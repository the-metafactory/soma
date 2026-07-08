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
    expect(content).toContain("# ── 6. 7d window");
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
