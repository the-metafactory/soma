/**
 * Claude Code PreCompact handover hook.
 *
 * One asset (`soma-precompact.mjs`) dispatched by argv into two events:
 *   - `capture` on PreCompact persists the handover + echoes it, and
 *   - `resurface` on UserPromptSubmit re-injects it once then consumes it.
 *
 * Compaction does not re-run SessionStart, so this persist+resurface pair is
 * what carries active work-state across the compression boundary.
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  bootstrapSomaHome,
  createAlgorithmRun,
  installSomaForClaudeCode,
  planSomaForClaudeCodeInstall,
  uninstallSomaForClaudeCode,
  writeAlgorithmRun,
} from "../src/index";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_REL = ".claude/hooks/soma/soma-precompact.mjs";
const CONFIG_REL = ".claude/hooks/soma/soma-precompact.config.json";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-precompact-hook-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function readJson<T>(path: string): Promise<T> {
  return readFile(path, "utf8").then((content) => JSON.parse(content) as T);
}

function countHookCommandsContaining(settings: { hooks?: Record<string, unknown[]> }, text: string): number {
  return Object.values(settings.hooks ?? {})
    .flatMap((groups) =>
      groups.flatMap((group) => {
        if (!group || typeof group !== "object" || !("hooks" in group) || !Array.isArray((group as { hooks: unknown[] }).hooks)) return [];
        return (group as { hooks: { command?: string }[] }).hooks.map((hook) => hook.command ?? "");
      }),
    )
    .filter((command) => command.includes(text)).length;
}

async function pointConfigAt(homeDir: string, somaHome: string): Promise<void> {
  await writeFile(
    join(homeDir, CONFIG_REL),
    JSON.stringify({ somaHome, trustedSomaRepo: REPO_ROOT, bunPath: process.execPath }),
    "utf8",
  );
}

function runHook(homeDir: string, action: string, input: object): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [join(homeDir, HOOK_REL), action], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

test("precompact hook files are default-on in the plan, opt-out excludes them", () => {
  const plan = planSomaForClaudeCodeInstall({ homeDir: "/tmp/test-home" });
  expect(plan.substrateFiles).toContain("/tmp/test-home/.claude/hooks/soma/soma-precompact.mjs");
  expect(plan.substrateFiles).toContain("/tmp/test-home/.claude/hooks/soma/soma-precompact.config.json");

  const planOff = planSomaForClaudeCodeInstall({ homeDir: "/tmp/test-home", preCompact: false });
  expect(planOff.substrateFiles).not.toContain("/tmp/test-home/.claude/hooks/soma/soma-precompact.mjs");
});

test("install is idempotent and patches PreCompact + UserPromptSubmit once each", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, preCompact: true });
    await installSomaForClaudeCode({ homeDir, preCompact: true });

    const hookInfo = await stat(join(homeDir, HOOK_REL));
    expect((hookInfo.mode & 0o100) !== 0).toBe(true); // executable

    const settings = await readJson<{ hooks: Record<string, unknown[]> }>(join(homeDir, ".claude/settings.json"));
    expect(countHookCommandsContaining(settings, "soma-precompact.mjs")).toBe(2);
    const preCompact = JSON.stringify(settings.hooks.PreCompact ?? []);
    expect(preCompact).toContain("soma-precompact.mjs");
    expect(preCompact).toContain("capture");
    const prompt = JSON.stringify(settings.hooks.UserPromptSubmit ?? []);
    expect(prompt).toContain("soma-precompact.mjs");
    expect(prompt).toContain("resurface");
  });
});

test("capture hook persists a handover file and echoes it to stdout", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, preCompact: true });
    const somaHome = join(homeDir, ".soma");
    await bootstrapSomaHome({ homeDir });
    await writeAlgorithmRun(
      createAlgorithmRun({
        id: "hook-active-run",
        timestamp: "2026-07-07T10:00:00.000Z",
        prompt: "Survive compaction",
        intent: "Expose active work across compaction.",
        currentState: "No handover.",
        goal: "Handover lists active runs.",
        criteria: [{ id: "C1", text: "Active run appears." }],
      }),
      { homeDir },
    );
    await pointConfigAt(homeDir, somaHome);

    const out = runHook(homeDir, "capture", { session_id: "sess-1", cwd: "/work" });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("# Pre-Compaction Handover");
    expect(out.stdout).toContain("hook-active-run");

    const handoverPath = join(somaHome, "memory/STATE", "precompact-handover-sess-1.md");
    expect(await fileExists(handoverPath)).toBe(true);
    expect(await readFile(handoverPath, "utf8")).toContain("hook-active-run");
  });
});

test("resurface hook re-injects the persisted handover once as additionalContext, then consumes it", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, preCompact: true });
    const somaHome = join(homeDir, ".soma");
    await pointConfigAt(homeDir, somaHome);

    // Simulate a prior compaction having persisted a handover for this session.
    const handoverPath = join(somaHome, "memory/STATE", "precompact-handover-sess-2.md");
    await mkdir(dirname(handoverPath), { recursive: true });
    await writeFile(handoverPath, "# Pre-Compaction Handover\nActive: hook-active-run\n", "utf8");

    const first = runHook(homeDir, "resurface", { hook_event_name: "UserPromptSubmit", session_id: "sess-2" });
    expect(first.status).toBe(0);
    const parsed = JSON.parse(first.stdout);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("hook-active-run");
    expect(await fileExists(handoverPath)).toBe(false); // consumed

    // Second prompt: nothing to resurface — continue with no injected context.
    const second = runHook(homeDir, "resurface", { hook_event_name: "UserPromptSubmit", session_id: "sess-2" });
    const secondParsed = JSON.parse(second.stdout);
    expect(secondParsed.continue).toBe(true);
    expect(secondParsed.hookSpecificOutput).toBeUndefined();
  });
});

test("resurface fails open (continue, no context) when the config is missing", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, preCompact: true });
    await rm(join(homeDir, CONFIG_REL));

    const out = runHook(homeDir, "resurface", { hook_event_name: "UserPromptSubmit", session_id: "sess-3" });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).continue).toBe(true);
  });
});

test("uninstall removes the precompact settings entries even if the bun path drifted", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, preCompact: true });
    const settingsPath = join(homeDir, ".claude/settings.json");

    const raw = await readFile(settingsPath, "utf8");
    await writeFile(settingsPath, raw.replaceAll(process.execPath, "/some/other/bun"), "utf8");
    expect(countHookCommandsContaining(await readJson(settingsPath), "soma-precompact.mjs")).toBe(2);

    await uninstallSomaForClaudeCode({ homeDir });

    const after = await readJson<{ hooks?: Record<string, unknown[]> }>(settingsPath);
    expect(countHookCommandsContaining(after, "soma-precompact.mjs")).toBe(0);
    expect(await fileExists(join(homeDir, HOOK_REL))).toBe(false);
  });
});
