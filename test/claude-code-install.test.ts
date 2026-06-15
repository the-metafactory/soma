/**
 * #29 Claude Code adapter — full install + projection (per soma#64 pivot).
 * Minimal-correct scope: rules/soma/ skeleton + ISA skill projection +
 * lifecycle/writeback hooks + uninstaller.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  bootstrapSomaHome,
  projectClaudeCodeHome,
  installSomaForClaudeCode,
  planSomaForClaudeCodeInstall,
  scaffoldIsa,
  setActiveIsa,
  uninstallSomaForClaudeCode,
} from "../src/index";
import { unpatchClaudeCodeModeClassifierSettings } from "../src/adapters/claude-code/hooks";
import { datePrefixSlug } from "../src/dated-slug";
import { portableProjectionInput } from "./fixtures";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-29-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function readJson<T>(path: string): Promise<T> {
  return readFile(path, "utf8").then((content) => JSON.parse(content) as T);
}

function countSomaHookCommands(settings: { hooks?: Record<string, unknown[]> }): number {
  return Object.values(settings.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => {
      if (!group || typeof group !== "object" || !("hooks" in group) || !Array.isArray(group.hooks)) return [];
      return group.hooks.filter((hook) =>
        hook &&
        typeof hook === "object" &&
        "command" in hook &&
        typeof hook.command === "string" &&
        hook.command.includes("hooks/soma/soma-claude-code-hook.mjs"),
      );
    }),
  ).length;
}

function countHookCommandsContaining(settings: { hooks?: Record<string, unknown[]> }, text: string): number {
  return Object.values(settings.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => {
      if (!group || typeof group !== "object" || !("hooks" in group) || !Array.isArray(group.hooks)) return [];
      return group.hooks.filter((hook) =>
        hook &&
        typeof hook === "object" &&
        "command" in hook &&
        typeof hook.command === "string" &&
        hook.command.includes(text),
      );
    }),
  ).length;
}

function runClaudeHook(homeDir: string, event: string, input: Record<string, unknown>): void {
  const hook = join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.mjs");
  const result = spawnSync(process.execPath, [hook, event], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: homeDir },
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
}

interface ClaudePromptHookOutput {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
  };
}

function runClaudeModeClassifierHook(homeDir: string, input: Record<string, unknown>): ClaudePromptHookOutput {
  const hook = join(homeDir, ".claude/hooks/soma/soma-mode-classifier.mjs");
  const result = spawnSync(process.execPath, [hook], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: homeDir },
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as ClaudePromptHookOutput;
}

async function waitForEvents(homeDir: string, predicate: (events: ClaudeHookEvent[]) => boolean): Promise<ClaudeHookEvent[]> {
  const eventsPath = join(homeDir, ".soma/memory/STATE/events.jsonl");
  let events: ClaudeHookEvent[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const content = await readFile(eventsPath, "utf8").catch(() => "");
    events = content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ClaudeHookEvent);
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return events;
}

interface ClaudeHookEvent {
  substrate: string;
  kind: string;
  summary: string;
  artifactPaths?: string[];
  metadata?: Record<string, unknown>;
}

test("AC-1: projectClaudeCodeHome writes everything under rules/soma/", () => {
  const bundle = projectClaudeCodeHome(portableProjectionInput);
  for (const f of bundle.files) {
    expect(f.path.startsWith("rules/soma/")).toBe(true);
  }
  const expected = [
    "rules/soma/README.md",
    "rules/soma/CONTEXT.md",
    "rules/soma/PROFILE.md",
    "rules/soma/TELOS.md",
    "rules/soma/MEMORY_LAYOUT.md",
    "rules/soma/SKILLS.md",
    "rules/soma/POLICY.md",
    "rules/soma/ACTIVE_ISA.md",
  ];
  expect(bundle.files.map((f) => f.path)).toEqual(expected);
});

test("AC-2: planSomaForClaudeCodeInstall lists every file written", () => {
  const plan = planSomaForClaudeCodeInstall({ homeDir: "/tmp/test-home" });
  expect(plan.substrate).toBe("claude-code");
  expect(plan.apply).toBe(false);
  expect(plan.substrateHome).toBe("/tmp/test-home/.claude");
  expect(plan.substrateFiles).toEqual([
    "/tmp/test-home/.claude/rules/soma/README.md",
    "/tmp/test-home/.claude/rules/soma/CONTEXT.md",
    "/tmp/test-home/.claude/rules/soma/PROFILE.md",
    "/tmp/test-home/.claude/rules/soma/TELOS.md",
    "/tmp/test-home/.claude/rules/soma/MEMORY_LAYOUT.md",
    "/tmp/test-home/.claude/rules/soma/SKILLS.md",
    "/tmp/test-home/.claude/rules/soma/POLICY.md",
    "/tmp/test-home/.claude/rules/soma/ACTIVE_ISA.md",
    "/tmp/test-home/.claude/hooks/soma/soma-claude-code-hook.mjs",
    "/tmp/test-home/.claude/hooks/soma/soma-claude-code-hook.config.json",
    "/tmp/test-home/.claude/settings.json",
  ]);
});

test("issue #274: mode classifier hook files are opt-in in the Claude Code install plan", () => {
  const defaultPlan = planSomaForClaudeCodeInstall({ homeDir: "/tmp/test-home" });
  expect(defaultPlan.substrateFiles).not.toContain("/tmp/test-home/.claude/hooks/soma/soma-mode-classifier.mjs");

  const plan = planSomaForClaudeCodeInstall({ homeDir: "/tmp/test-home", modeClassifier: true });
  expect(plan.substrateFiles).toContain("/tmp/test-home/.claude/hooks/soma/soma-mode-classifier.mjs");
  expect(plan.substrateFiles).toContain("/tmp/test-home/.claude/hooks/soma/soma-mode-classifier.config.json");
});

test("AC-3: planSomaForClaudeCodeInstall does not write files (plan.apply === false)", async () => {
  await withTempHome(async (homeDir) => {
    planSomaForClaudeCodeInstall({ homeDir });
    // Nothing exists at the target path after planning.
    await expect(stat(join(homeDir, ".claude/rules/soma"))).rejects.toThrow();
  });
});

test("AC-4: installSomaForClaudeCode is idempotent (second install bytes-identical)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const before = await readFile(join(homeDir, ".claude/rules/soma/CONTEXT.md"), "utf8");
    const settingsBefore = await readFile(join(homeDir, ".claude/settings.json"), "utf8");
    await installSomaForClaudeCode({ homeDir });
    const after = await readFile(join(homeDir, ".claude/rules/soma/CONTEXT.md"), "utf8");
    const settingsAfter = await readFile(join(homeDir, ".claude/settings.json"), "utf8");
    expect(after).toBe(before);
    expect(settingsAfter).toBe(settingsBefore);
  });
});

test("issue #236: claude-code install wires Soma-owned hooks without overwriting user hooks", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              description: "user hook",
              hooks: [{ type: "command", command: "echo user-start" }],
            },
          ],
        },
      }, null, 2),
      "utf8",
    );

    await installSomaForClaudeCode({ homeDir });
    await installSomaForClaudeCode({ homeDir });

    const hookInfo = await stat(join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.mjs"));
    expect((hookInfo.mode & 0o100) !== 0).toBe(true);
    const hookContent = await readFile(join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.mjs"), "utf8");
    expect(hookContent).toContain('"src/cli.ts"');
    expect(hookContent).not.toContain('"run",\n    "soma"');
    expect(hookContent).toContain('child.on("error", onError)');
    expect(hookContent).toContain("flush-writeback-queue");
    const settings = await readJson<{ hooks: Record<string, unknown[]> }>(join(homeDir, ".claude/settings.json"));
    const config = await readJson<{ bunPath: string }>(join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.config.json"));
    expect(JSON.stringify(settings)).toContain("echo user-start");
    expect(JSON.stringify(settings)).toContain(config.bunPath);
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart", "SubagentStart", "SubagentStop"]);
    expect(countSomaHookCommands(settings)).toBe(5);
    expect(JSON.stringify(settings)).not.toContain("soma-mode-classifier");
  });
});

test("issue #274: Claude Code mode classifier install disables PAI classifier and restores it on uninstall", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    const paiModeClassifierCommand = "bun ~/PAI/TOOLS/ModeClassifier.hook.ts";
    await writeFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              description: "PAI ModeClassifier",
              hooks: [{ type: "command", command: paiModeClassifierCommand }],
            },
            {
              description: "user prompt hook",
              hooks: [{ type: "command", command: "echo user-prompt" }],
            },
          ],
        },
      }, null, 2),
      "utf8",
    );

    await installSomaForClaudeCode({ homeDir, modeClassifier: true });
    await installSomaForClaudeCode({ homeDir, modeClassifier: true });

    const hookInfo = await stat(join(homeDir, ".claude/hooks/soma/soma-mode-classifier.mjs"));
    expect((hookInfo.mode & 0o100) !== 0).toBe(true);
    const settings = await readJson<{ hooks: Record<string, unknown[]>; somaDisabledHooks?: Record<string, unknown[]> }>(join(homeDir, ".claude/settings.json"));
    expect(countHookCommandsContaining(settings, "soma-mode-classifier.mjs")).toBe(1);
    expect(JSON.stringify(settings.hooks)).toContain("echo user-prompt");
    expect(JSON.stringify(settings.hooks)).not.toContain("ModeClassifier.hook.ts");
    expect(JSON.stringify(settings.somaDisabledHooks)).toContain("ModeClassifier.hook.ts");

    const output = runClaudeModeClassifierHook(homeDir, { prompt: "Implement a multi-file migration for the adapter" });
    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput?.additionalContext).toContain("Soma MODE: ALGORITHM E3");
    expect(output.hookSpecificOutput?.additionalContext).toContain("Do not downshift");

    const removed = await uninstallSomaForClaudeCode({ homeDir });
    expect(removed.removed).toContain(join(homeDir, ".claude/hooks/soma/soma-mode-classifier.mjs"));
    expect(removed.removed).toContain(join(homeDir, ".claude/hooks/soma/soma-mode-classifier.config.json"));
    await expect(stat(join(homeDir, ".claude/hooks/soma/soma-mode-classifier.mjs"))).rejects.toThrow();
    const after = await readJson<{ hooks: Record<string, unknown[]>; somaDisabledHooks?: unknown }>(join(homeDir, ".claude/settings.json"));
    expect(JSON.stringify(after.hooks)).toContain("ModeClassifier.hook.ts");
    expect(JSON.stringify(after.hooks)).toContain("echo user-prompt");
    expect(JSON.stringify(after.hooks)).not.toContain("soma-mode-classifier");
    expect(after.somaDisabledHooks).toBeUndefined();
  });
});

test("issue #274: mode classifier uninstall ignores empty disabled PAI hook groups", async () => {
  await withTempHome(async (homeDir) => {
    const substrateHome = join(homeDir, ".claude");
    await mkdir(substrateHome, { recursive: true });
    const settingsPath = join(substrateHome, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ somaDisabledHooks: { paiModeClassifier: [{ description: "empty", hooks: [] }] } }, null, 2),
      "utf8",
    );

    const before = await readFile(settingsPath, "utf8");
    const changed = await unpatchClaudeCodeModeClassifierSettings(substrateHome, process.execPath);
    const after = await readJson<{ somaDisabledHooks?: unknown }>(settingsPath);

    expect(changed).toEqual([settingsPath]);
    expect(await readFile(settingsPath, "utf8")).not.toBe(before);
    expect(after.somaDisabledHooks).toBeUndefined();
  });
});

test("issue #274: mode classifier uninstall restores only missing PAI hook commands", async () => {
  await withTempHome(async (homeDir) => {
    const substrateHome = join(homeDir, ".claude");
    await mkdir(substrateHome, { recursive: true });
    const existingCommand = "bun ~/PAI/TOOLS/ModeClassifier.hook.ts";
    const missingCommand = "node ~/PAI/TOOLS/ModeClassifier.hook.mjs";
    const settingsPath = join(substrateHome, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ description: "already restored", hooks: [{ type: "command", command: existingCommand }] }],
        },
        somaDisabledHooks: {
          paiModeClassifier: [{ description: "PAI ModeClassifier", hooks: [{ type: "command", command: existingCommand }, { type: "command", command: missingCommand }] }],
        },
      }, null, 2),
      "utf8",
    );

    await unpatchClaudeCodeModeClassifierSettings(substrateHome, process.execPath);

    const after = await readJson<{ hooks: Record<string, unknown[]>; somaDisabledHooks?: unknown }>(settingsPath);
    expect(countHookCommandsContaining(after, "ModeClassifier.hook.ts")).toBe(1);
    expect(countHookCommandsContaining(after, "ModeClassifier.hook.mjs")).toBe(1);
    expect(after.somaDisabledHooks).toBeUndefined();
  });
});

test("issue #274: mode classifier install disables quoted PAI mjs classifier commands", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    const paiModeClassifierCommand = 'bun "/workspace/PAI/TOOLS/ModeClassifier.hook.mjs"';
    await writeFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ description: "PAI ModeClassifier", hooks: [{ type: "command", command: paiModeClassifierCommand }] }],
        },
      }, null, 2),
      "utf8",
    );

    await installSomaForClaudeCode({ homeDir, modeClassifier: true });

    const settings = await readJson<{ hooks: Record<string, unknown[]>; somaDisabledHooks?: Record<string, unknown[]> }>(join(homeDir, ".claude/settings.json"));
    expect(JSON.stringify(settings.hooks)).not.toContain("ModeClassifier.hook.mjs");
    expect(JSON.stringify(settings.somaDisabledHooks)).toContain("ModeClassifier.hook.mjs");
  });
});

test("issue #274: mode classifier hook fails open when config is missing", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, modeClassifier: true });
    await rm(join(homeDir, ".claude/hooks/soma/soma-mode-classifier.config.json"));

    const output = runClaudeModeClassifierHook(homeDir, { prompt: "hello" });

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput?.additionalContext).toContain("Soma mode classifier unavailable");
  });
});

test("issue #236: installed Claude hook appends lifecycle and metadata-only writeback events", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });

    runClaudeHook(homeDir, "session-start", { session_id: "claude-session-1" });
    runClaudeHook(homeDir, "writeback-tool", {
      session_id: "claude-session-1",
      hook_event_name: "PostToolUse",
      cwd: "/workspace/example",
      tool_name: "Write",
      tool_input: { file_path: "/workspace/example/result.md", content: "private transcript content must not be mirrored" },
    });
    runClaudeHook(homeDir, "session-end", { session_id: "claude-session-1" });

    const events = await waitForEvents(homeDir, (items) =>
      ["lifecycle.session_start", "writeback.claude_code.tool", "lifecycle.session_end"].every((kind) =>
        items.some((event) => event.kind === kind),
      ),
    );
    expect(events.some((event) => event.substrate === "claude-code" && event.kind === "lifecycle.session_start")).toBe(true);
    expect(events.some((event) => event.substrate === "claude-code" && event.kind === "lifecycle.session_end")).toBe(true);
    const toolEvent = events.find((event) => event.kind === "writeback.claude_code.tool");
    expect(toolEvent).toBeDefined();
    expect(toolEvent?.artifactPaths).toEqual(["/workspace/example/result.md"]);
    expect(toolEvent?.metadata).toMatchObject({
      sessionId: "claude-session-1",
      source: "PostToolUse",
      toolName: "Write",
    });
    expect(JSON.stringify(toolEvent)).not.toContain("private transcript content");
  });
});

test("AC-5: CLAUDE.md left untouched (pivot dropped @-import composition)", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    const distinctive = "# my hand-written CLAUDE.md\n\nUntouched by Soma.\n";
    await writeFile(join(homeDir, ".claude/CLAUDE.md"), distinctive, "utf8");
    await installSomaForClaudeCode({ homeDir });
    const after = await readFile(join(homeDir, ".claude/CLAUDE.md"), "utf8");
    expect(after).toBe(distinctive);
  });
});

test("AC-10: uninstallSomaForClaudeCode removes only Soma-owned projection and hook entries", async () => {
  await withTempHome(async (homeDir) => {
    // User-owned sibling file that must survive uninstall.
    await mkdir(join(homeDir, ".claude/rules/user-rule"), { recursive: true });
    await writeFile(join(homeDir, ".claude/rules/user-rule/note.md"), "user note", "utf8");
    await mkdir(join(homeDir, ".claude/skills/UserSkill"), { recursive: true });
    await writeFile(join(homeDir, ".claude/skills/UserSkill/SKILL.md"), "user skill", "utf8");
    await mkdir(join(homeDir, ".claude/hooks/user"), { recursive: true });
    await writeFile(join(homeDir, ".claude/hooks/user/hook.mjs"), "user hook", "utf8");
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              description: "user-owned empty group",
              hooks: [],
            },
          ],
        },
      }, null, 2),
      "utf8",
    );

    await installSomaForClaudeCode({ homeDir });
    const result = await uninstallSomaForClaudeCode({ homeDir });

    expect(result.removed).toContain(join(homeDir, ".claude/rules/soma"));
    expect(result.removed).toContain(join(homeDir, ".claude/skills/ISA"));
    expect(result.removed).toContain(join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.mjs"));
    expect(result.removed).toContain(join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.config.json"));
    await expect(stat(join(homeDir, ".claude/rules/soma"))).rejects.toThrow();
    await expect(stat(join(homeDir, ".claude/skills/ISA"))).rejects.toThrow();
    await expect(stat(join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.mjs"))).rejects.toThrow();
    // User-owned siblings survive.
    expect(await readFile(join(homeDir, ".claude/rules/user-rule/note.md"), "utf8")).toBe("user note");
    expect(await readFile(join(homeDir, ".claude/skills/UserSkill/SKILL.md"), "utf8")).toBe("user skill");
    expect(await readFile(join(homeDir, ".claude/hooks/user/hook.mjs"), "utf8")).toBe("user hook");
    const settings = await readJson<Record<string, unknown>>(join(homeDir, ".claude/settings.json"));
    expect(JSON.stringify(settings)).not.toContain("soma-claude-code-hook");
    expect(settings).toMatchObject({
      hooks: {
        PostToolUse: [{ description: "user-owned empty group", hooks: [] }],
      },
    });
  });
});

test("issue #236: uninstall removes settings entries using the installed Bun path", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const configPath = join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.config.json");
    const settingsPath = join(homeDir, ".claude/settings.json");
    const config = await readJson<{ bunPath: string }>(configPath);
    const oldBunPath = "/tmp/soma-test-old-bun";
    await writeFile(configPath, `${JSON.stringify({ ...config, bunPath: oldBunPath }, null, 2)}\n`, "utf8");
    // Rewrite the frozen bun path inside settings.json as decoded JSON
    // string values, not raw file text: a raw replaceAll silently no-ops
    // when the resolved path is a native Windows path (C:\...), whose
    // backslashes are JSON-escaped on disk.
    const settings = await readJson<unknown>(settingsPath);
    const rewritten = JSON.stringify(
      settings,
      (_key, value) => (typeof value === "string" ? value.replaceAll(config.bunPath, oldBunPath) : value),
      2,
    );
    await writeFile(settingsPath, `${rewritten}\n`, "utf8");

    await uninstallSomaForClaudeCode({ homeDir });

    const after = await readFile(settingsPath, "utf8");
    expect(after).not.toContain("soma-claude-code-hook");
  });
});

test("uninstallSomaForClaudeCode rethrows non-ENOENT errors (sage r1)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    // Make rules/soma read-only AND remove write+execute on the parent
    // so rm cannot recurse into it. On a Bun/Posix runtime this surfaces
    // a non-ENOENT error from rm (EACCES). Uninstall must NOT silently
    // report success.
    const { chmod } = await import("node:fs/promises");
    const parent = join(homeDir, ".claude/rules");
    await chmod(parent, 0o500);
    try {
      await expect(uninstallSomaForClaudeCode({ homeDir })).rejects.toThrow();
    } finally {
      await chmod(parent, 0o700);
    }
  });
});

test("uninstallSomaForClaudeCode is idempotent (second run = no-op, removed=[])", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    await uninstallSomaForClaudeCode({ homeDir });
    const second = await uninstallSomaForClaudeCode({ homeDir });
    expect(second.removed).toEqual([]);
  });
});

test("AC-11: active ISA refreshed on install when one is set", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    await setActiveIsa("demo", { homeDir });
    await installSomaForClaudeCode({ homeDir });
    const isaContent = await readFile(join(homeDir, ".claude/rules/soma/ACTIVE_ISA.md"), "utf8");
    // serializeIsa drops the slug (filename is the slug) but keeps task + Goal.
    expect(isaContent).toContain("task: G");
    expect(isaContent).toContain("## Goal");
  });
});

test("active-ISA file is omitted from skeleton when no active ISA set", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    // No setActiveIsa called → installer must skip the ACTIVE_ISA file.
    await installSomaForClaudeCode({ homeDir });
    await expect(stat(join(homeDir, ".claude/rules/soma/ACTIVE_ISA.md"))).rejects.toThrow();
  });
});

test("README documents the directory contract for humans", () => {
  const bundle = projectClaudeCodeHome(portableProjectionInput);
  const readme = bundle.files.find((f) => f.path === "rules/soma/README.md");
  expect(readme).toBeDefined();
  expect(readme!.content).toContain("Soma");
  expect(readme!.content).toContain("rules");
  expect(readme!.content).toContain("uninstall");
});

async function waitForRunFile(homeDir: string, slug: string): Promise<boolean> {
  const runPath = join(homeDir, ".soma/memory/WORK/algorithm-runs", `${slug}.json`);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const exists = await stat(runPath).then(() => true, () => false);
    if (exists) return true;
    await Bun.sleep(50);
  }
  return false;
}

test("hook bridge: editing a shared Soma ISA file via writeback-tool mirrors it into a soma Algorithm run", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });

    const slug = "hook-bridge-demo";
    const isaDir = join(homeDir, ".soma/memory/WORK", slug);
    const isaPath = join(isaDir, "ISA.md");
    await mkdir(isaDir, { recursive: true });
    await writeFile(
      isaPath,
      [
        "---",
        "task: Hook bridge demo",
        `slug: ${slug}`,
        "effort: E2",
        "phase: think",
        "progress: 0/1",
        "mode: ALGORITHM",
        "started: 2026-05-29",
        "updated: 2026-05-29",
        "---",
        "",
        "## Goal",
        "",
        "Mirror this ISA into a soma run.",
        "",
        "## Criteria",
        "",
        "- [ ] ISC-1: the run exists",
        "",
      ].join("\n"),
      "utf8",
    );

    const expectedSlug = datePrefixSlug(slug);
    runClaudeHook(homeDir, "writeback-tool", {
      session_id: "claude-session-hook-bridge",
      hook_event_name: "PostToolUse",
      cwd: isaDir,
      tool_name: "Write",
      tool_input: { file_path: isaPath, content: "..." },
    });

    expect(await waitForRunFile(homeDir, expectedSlug)).toBe(true);
    const run = await readJson<{ id: string; substrate: string }>(
      join(homeDir, ".soma/memory/WORK/algorithm-runs", `${expectedSlug}.json`),
    );
    expect(run.id).toBe(expectedSlug);
    expect(run.substrate).toBe("claude-code");
  });
});

test("hook bridge: a non-ISA file edit does not create any soma Algorithm run", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });

    runClaudeHook(homeDir, "writeback-tool", {
      session_id: "claude-session-no-isa",
      hook_event_name: "PostToolUse",
      cwd: join(homeDir, "workspace"),
      tool_name: "Write",
      tool_input: { file_path: join(homeDir, "workspace/notes.md"), content: "not an ISA" },
    });

    // Give the detached path a beat; then assert the runs dir has nothing.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runsDir = join(homeDir, ".soma/memory/WORK/algorithm-runs");
    const exists = await stat(runsDir).then(() => true, () => false);
    if (exists) {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(runsDir);
      expect(entries.filter((e) => e.endsWith(".json"))).toEqual([]);
    }
  });
});
