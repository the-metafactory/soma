/**
 * Claude Code status line projection.
 *
 * Projects the bundled `soma-statusline.sh` (a self-contained bash script —
 * SOMA_HOME baked in at projection time, no bunPath, no companion config.json)
 * into `<substrateHome>/hooks/soma/` and points `settings.json`'s top-level
 * `statusLine` key at its absolute path. Unlike the other soma-owned hooks,
 * there is no matcher, no hooks[] group, and no argv dispatch — this is a
 * single command entry the substrate execs directly via the script's shebang.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  installSomaForClaudeCode,
  planSomaForClaudeCodeInstall,
  uninstallSomaForClaudeCode,
} from "../src/index";

const SCRIPT_REL = ".claude/hooks/soma/soma-statusline.sh";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-statusline-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function readJson<T>(path: string): Promise<T> {
  return readFile(path, "utf8").then((content) => JSON.parse(content) as T);
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

// ANSI SGR matcher built from a variable so the ESC byte never appears in a
// regex literal (avoids eslint no-control-regex).
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// Run the projected statusline script with `input` piped on stdin, returning
// its exit status + stdout (ANSI stripped, for content assertions).
function runStatusline(scriptPath: string, input: object): { status: number | null; stdout: string } {
  const result = spawnSync("bash", [scriptPath], { input: JSON.stringify(input), encoding: "utf8" });
  const stripped = (result.stdout ?? "").replace(ANSI_SGR, "");
  return { status: result.status, stdout: stripped };
}

test("status line file is default-on in the plan, opt-out excludes it", () => {
  const plan = planSomaForClaudeCodeInstall({ homeDir: "/tmp/test-home" });
  expect(plan.substrateFiles).toContain("/tmp/test-home/.claude/hooks/soma/soma-statusline.sh");

  const planOff = planSomaForClaudeCodeInstall({ homeDir: "/tmp/test-home", statusLine: false });
  expect(planOff.substrateFiles).not.toContain("/tmp/test-home/.claude/hooks/soma/soma-statusline.sh");
});

test("install writes the statusline script executable with SOMA_HOME substituted", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });

    const scriptPath = join(homeDir, SCRIPT_REL);
    const info = await stat(scriptPath);
    expect((info.mode & 0o100) !== 0).toBe(true); // executable

    const content = await readFile(scriptPath, "utf8");
    const somaHome = join(homeDir, ".soma");
    expect(content).not.toContain("__SOMA_HOME__");
    expect(content).toContain(`SOMA_HOME="\${SOMA_HOME:-${somaHome}}"`);
    // Everything else is byte-identical to the source asset — spot-check a
    // couple of unrelated lines survived untouched.
    expect(content).toContain("STATE_DIR=\"$SOMA_HOME/memory/STATE\"");
    expect(content).toContain("append_window \"5h\" \"$r5\" \"$r5r\"");
  });
});

test("a soma-home path with shell metacharacters is safely escaped in the script", async () => {
  await withTempHome(async (homeDir) => {
    // A path containing `$`, a space, `"`, a backtick, and a backslash: raw
    // substitution into the double-quoted `SOMA_HOME="${SOMA_HOME:-<value>}"`
    // would break out / inject. All four escapable chars must be backslashed.
    const nastySomaHome = `${homeDir}/od$d "x" \`y\` z\\w/.soma`;
    await installSomaForClaudeCode({ homeDir, somaHome: nastySomaHome });

    const content = await readFile(join(homeDir, SCRIPT_REL), "utf8");
    expect(content).not.toContain("__SOMA_HOME__");
    // The rendered line has each metacharacter backslash-escaped so the shell
    // reads the literal path inside the double quotes.
    const escaped = nastySomaHome.replace(/[\\"$`]/g, "\\$&");
    expect(content).toContain(`SOMA_HOME="\${SOMA_HOME:-${escaped}}"`);

    // Prove the escaping is correct by having bash actually evaluate the line
    // and echo the resulting SOMA_HOME — it must equal the real path verbatim.
    const line = content.split("\n").find((l) => l.startsWith("SOMA_HOME="));
    expect(line).toBeDefined();
    const result = spawnSync("bash", ["-c", `${line}\nprintf '%s' "$SOMA_HOME"`], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(nastySomaHome);
  });
});

test("install sets settings.json statusLine.command to the projected absolute path", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });

    const scriptPath = join(homeDir, SCRIPT_REL);
    const settings = await readJson<{ statusLine?: { type?: string; command?: string } }>(
      join(homeDir, ".claude/settings.json"),
    );
    expect(settings.statusLine).toEqual({ type: "command", command: scriptPath });
  });
});

test("statusLine: false disables both the file and the settings entry", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, statusLine: false });

    expect(await fileExists(join(homeDir, SCRIPT_REL))).toBe(false);
    const settings = await readJson<{ statusLine?: unknown }>(join(homeDir, ".claude/settings.json"));
    expect(settings.statusLine).toBeUndefined();
  });
});

test("install is idempotent: two installs produce byte-identical script and stable settings.json", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptBefore = await readFile(join(homeDir, SCRIPT_REL), "utf8");
    const settingsBefore = await readFile(join(homeDir, ".claude/settings.json"), "utf8");

    await installSomaForClaudeCode({ homeDir });
    const scriptAfter = await readFile(join(homeDir, SCRIPT_REL), "utf8");
    const settingsAfter = await readFile(join(homeDir, ".claude/settings.json"), "utf8");

    expect(scriptAfter).toBe(scriptBefore);
    expect(settingsAfter).toBe(settingsBefore);
  });
});

test("custom --soma-home substitutes correctly into the projected script", async () => {
  await withTempHome(async (homeDir) => {
    const customSomaHome = join(homeDir, "elsewhere/.soma-custom");
    await installSomaForClaudeCode({ homeDir, somaHome: customSomaHome });

    const content = await readFile(join(homeDir, SCRIPT_REL), "utf8");
    expect(content).not.toContain("__SOMA_HOME__");
    expect(content).toContain(`SOMA_HOME="\${SOMA_HOME:-${customSomaHome}}"`);
    expect(content).not.toContain(join(homeDir, ".soma"));
  });
});

test("uninstall removes the script and the statusLine settings entry", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptPath = join(homeDir, SCRIPT_REL);
    expect(await fileExists(scriptPath)).toBe(true);

    const removed = await uninstallSomaForClaudeCode({ homeDir });

    expect(removed.removed).toContain(scriptPath);
    expect(await fileExists(scriptPath)).toBe(false);
    const settings = await readJson<{ statusLine?: unknown }>(join(homeDir, ".claude/settings.json"));
    expect(settings.statusLine).toBeUndefined();
  });
});

test("uninstall does NOT remove a statusLine that points at some other command", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const settingsPath = join(homeDir, ".claude/settings.json");
    const unrelated = { type: "command", command: "/usr/local/bin/my-other-statusline.sh" };
    const settings = await readJson<Record<string, unknown>>(settingsPath);
    settings.statusLine = unrelated;
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    // Also remove the soma script itself so uninstall's file-removal loop
    // can't accidentally be what leaves settings alone — the assertion is
    // specifically about the settings-ownership check.
    await rm(join(homeDir, SCRIPT_REL), { force: true });

    await uninstallSomaForClaudeCode({ homeDir });

    const after = await readJson<{ statusLine?: unknown }>(settingsPath);
    expect(after.statusLine).toEqual(unrelated);
  });
});

test("uninstall is idempotent (second run removes nothing further)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    await uninstallSomaForClaudeCode({ homeDir });
    const second = await uninstallSomaForClaudeCode({ homeDir });
    expect(second.removed).not.toContain(join(homeDir, SCRIPT_REL));
  });
});

test("issue #236 pattern: statusLine install does not disturb an unrelated user settings entry", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({ theme: "dark" }, null, 2),
      "utf8",
    );

    await installSomaForClaudeCode({ homeDir });

    const settings = await readJson<{ theme?: string; statusLine?: unknown }>(join(homeDir, ".claude/settings.json"));
    expect(settings.theme).toBe("dark");
    expect(settings.statusLine).toEqual({ type: "command", command: join(homeDir, SCRIPT_REL) });
  });
});

test("BLOCKER: a crafted numeric field cannot inject shell (no eval)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptPath = join(homeDir, SCRIPT_REL);

    // A separate mktemp dir for the injection target so the assertion can't be
    // confused by anything under the soma/substrate homes.
    const canaryDir = await mkdtemp(join(tmpdir(), "soma-statusline-canary-"));
    try {
      const canary = join(canaryDir, "pwned");
      // Old code did `eval "$(jq ... tostring)"` with the numeric fields
      // UNQUOTED, so this command-substitution in `used_percentage` executed.
      const out = runStatusline(scriptPath, {
        workspace: { current_dir: "/tmp" },
        session_id: "inj",
        model: { display_name: "Claude Opus 4.8" },
        context_window: { used_percentage: 38 },
        rate_limits: {
          five_hour: { used_percentage: `$(touch ${canary})`, resets_at: 1893456000 },
          seven_day: { used_percentage: 41, resets_at: 1893600000 },
        },
      });

      // (a) the injection did NOT run, and (b) the line still rendered.
      expect(await fileExists(canary)).toBe(false);
      expect(out.status).toBe(0);
      expect(out.stdout.length).toBeGreaterThan(0);
      // Fields stayed aligned (the crafted value did not shift the row): the
      // real ctx and 7d percentages still render in their own segments.
      expect(out.stdout).toContain("ctx 38%");
      expect(out.stdout).toContain("7d 41%");
    } finally {
      await rm(canaryDir, { recursive: true, force: true });
    }
  });
});

// Mode/effort for the Soma segment come from the mode-classifier hook's
// per-session feed (`statusline-mode-<sid>.json`, written by
// `soma algorithm classify --session-id` on every prompt) — NOT the
// current-work pointer's `phase`, which carries no mode/effort. Task text
// still comes from the newest current-work file. These tests seed both
// session-scoped state files directly (bypassing the classify CLI) since the
// statusline script only ever reads them.
async function writeStatuslineModeState(
  homeDir: string,
  sessionId: string,
  state: { mode: string; effort?: string },
): Promise<void> {
  const stateDir = join(homeDir, ".soma/memory/STATE");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, `statusline-mode-${sessionId}.json`), JSON.stringify(state), "utf8");
}

async function writeCurrentWorkTask(homeDir: string, sessionId: string, task: string): Promise<void> {
  const stateDir = join(homeDir, ".soma/memory/STATE");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, `current-work-${sessionId}-1.json`), JSON.stringify({ task }), "utf8");
}

test("algorithm mode renders ⚙<effort> plus the full multi-word task", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptPath = join(homeDir, SCRIPT_REL);
    const sid = "task-space-sess";

    await writeStatuslineModeState(homeDir, sid, { mode: "algorithm", effort: "E3" });
    // The whole task survives (a tab-collapsing split would truncate at the
    // first word).
    await writeCurrentWorkTask(homeDir, sid, "write adapter");

    const out = runStatusline(scriptPath, {
      workspace: { current_dir: "/tmp" },
      session_id: sid,
      model: { display_name: "Claude Opus 4.8" },
      context_window: { used_percentage: 5 },
    });

    expect(out.status).toBe(0);
    expect(out.stdout).toContain("⚙E3");
    expect(out.stdout).toContain("write adapter");
  });
});

test("native mode renders ○ plus the task", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptPath = join(homeDir, SCRIPT_REL);
    const sid = "native-sess";

    await writeStatuslineModeState(homeDir, sid, { mode: "native" });
    await writeCurrentWorkTask(homeDir, sid, "read the diff");

    const out = runStatusline(scriptPath, {
      workspace: { current_dir: "/tmp" },
      session_id: sid,
      model: { display_name: "Claude Opus 4.8" },
      context_window: { used_percentage: 5 },
    });

    expect(out.status).toBe(0);
    expect(out.stdout).toContain("○ read the diff");
    expect(out.stdout).not.toContain("⚙");
  });
});

test("minimal mode drops the Soma segment but keeps the rest of the line", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptPath = join(homeDir, SCRIPT_REL);
    const sid = "minimal-sess";

    await writeStatuslineModeState(homeDir, sid, { mode: "minimal" });
    await writeCurrentWorkTask(homeDir, sid, "should not render");

    const out = runStatusline(scriptPath, {
      workspace: { current_dir: "/tmp" },
      session_id: sid,
      model: { display_name: "Claude Opus 4.8" },
      context_window: { used_percentage: 5 },
    });

    expect(out.status).toBe(0);
    expect(out.stdout).not.toContain("⚙");
    expect(out.stdout).not.toContain("○");
    expect(out.stdout).not.toContain("should not render");
    expect(out.stdout).toContain("ctx ");
  });
});

test("a missing statusline-mode state file drops the Soma segment but keeps the rest of the line", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptPath = join(homeDir, SCRIPT_REL);
    const sid = "no-state-sess";

    // No statusline-mode-<sid>.json written at all — only a current-work file.
    await writeCurrentWorkTask(homeDir, sid, "should not render");

    const out = runStatusline(scriptPath, {
      workspace: { current_dir: "/tmp" },
      session_id: sid,
      model: { display_name: "Claude Opus 4.8" },
      context_window: { used_percentage: 5 },
    });

    expect(out.status).toBe(0);
    expect(out.stdout).not.toContain("⚙");
    expect(out.stdout).not.toContain("○");
    expect(out.stdout).not.toContain("should not render");
    expect(out.stdout).toContain("ctx ");
  });
});
