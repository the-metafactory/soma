/**
 * Poteto-mode triggers that fire on an action: after a tool call, the
 * PostToolUse principle-nudge hook points at the principle or skill file the
 * action calls for, and says nothing when no rule matches or the file is not
 * installed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { installClaudeCodeSomaHooks, patchClaudeCodeSomaHookSettings } from "../../src/substrates/adapters/claude-code/hooks";

const PRINCIPLES = "skills/the-algorithm/references/principles";

async function withInstalledHook<T>(fn: (run: (input: object) => string, somaHome: string, substrateHome: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "soma-principle-nudge-"));
  try {
    const somaHome = join(root, "soma");
    const substrateHome = join(root, "claude");
    for (const file of [`${PRINCIPLES}/own-delegated-work.md`, `${PRINCIPLES}/verify-before-claiming.md`, `${PRINCIPLES}/weigh-review-findings-on-merit.md`]) {
      await mkdir(dirname(join(somaHome, file)), { recursive: true });
      await writeFile(join(somaHome, file), "# principle\n");
    }
    await installClaudeCodeSomaHooks({
      somaHome,
      somaRepoPath: resolve(import.meta.dir, "../.."),
      substrateHome,
      homeDir: root,
      options: { modeClassifier: false, policyGuard: false, preCompact: false, statusLine: false, feedbackCapture: false },
    });
    const hook = join(substrateHome, "hooks/soma/soma-claude-code-hook.mjs");
    const run = (input: object) =>
      spawnSync(process.execPath, [hook, "principle-nudge"], { input: JSON.stringify(input), encoding: "utf8" }).stdout.trim();
    return await fn(run, somaHome, substrateHome);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function context(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

test("settings register the nudge once on PostToolUse for Bash, Agent and Task, beside the writeback group", async () => {
  await withInstalledHook(async (_run, _somaHome, substrateHome) => {
    expect(await patchClaudeCodeSomaHookSettings(substrateHome)).toEqual([]);
    const settings = JSON.parse(await readFile(join(substrateHome, "settings.json"), "utf8"));
    const groups = settings.hooks.PostToolUse.filter((group: { hooks: { command: string }[] }) =>
      group.hooks.some((hook) => hook.command.endsWith(" principle-nudge")));
    expect(groups.map((group: { matcher: string }) => group.matcher)).toEqual([".*"]);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
  });
});

test("each action names its installed principle file", async () => {
  await withInstalledHook(async (run, somaHome) => {
    expect(context(run({ tool_name: "Agent", tool_input: { prompt: "x" } }))).toContain(join(somaHome, PRINCIPLES, "own-delegated-work.md"));
    expect(context(run({ tool_name: "Bash", tool_input: { command: "gh pr view 12 --comments" } }))).toContain("weigh-review-findings-on-merit.md");
    expect(context(run({ tool_name: "Bash", tool_input: { command: "git add -A && git commit -m x" } }))).toContain("verify-before-claiming.md");
  });
});

test("no match and an undeclared skill both stay silent", async () => {
  await withInstalledHook(async (run, somaHome) => {
    expect(run({ tool_name: "Bash", tool_input: { command: "ls -la" } })).toBe("");
    expect(run({ tool_name: "Read", tool_input: { file_path: "/x" } })).toBe("");
    expect(run({ tool_name: "Bash", tool_input: { command: "hyperfine 'bun x'" } })).toBe("");

    await mkdir(join(somaHome, "skills/benchmark-checklist"), { recursive: true });
    await writeFile(join(somaHome, "skills/benchmark-checklist/SKILL.md"), "# b\n");
    expect(run({ tool_name: "Bash", tool_input: { command: "hyperfine 'bun x'" } })).toBe("");
  });
});

test("reinstall migrates the old nudge matcher and preserves a foreign hook in its group", async () => {
  await withInstalledHook(async (_run, _somaHome, substrateHome) => {
    const path = join(substrateHome, "settings.json");
    const settings = JSON.parse(await readFile(path, "utf8"));
    const group = settings.hooks.PostToolUse.find((entry: { hooks: { command: string }[] }) =>
      entry.hooks.some((hook) => hook.command.endsWith(" principle-nudge")));
    group.matcher = "Bash|Agent|Task";
    group.hooks.push({ type: "command", command: "foreign-hook" });
    await writeFile(path, JSON.stringify(settings));
    await patchClaudeCodeSomaHookSettings(substrateHome);
    const updated = JSON.parse(await readFile(path, "utf8"));
    const groups = updated.hooks.PostToolUse;
    expect(groups.find((entry: { hooks: { command: string }[] }) => entry.hooks.some((hook) => hook.command === "foreign-hook")).matcher).toBe("Bash|Agent|Task");
    expect(groups.find((entry: { hooks: { command: string }[] }) => entry.hooks.some((hook) => hook.command.endsWith(" principle-nudge"))).matcher).toBe(".*");
    expect(await patchClaudeCodeSomaHookSettings(substrateHome)).toEqual([]);
  });
});
