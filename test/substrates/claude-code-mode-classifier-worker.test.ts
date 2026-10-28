/**
 * The Claude Code mode-classifier hook runs `algorithm classify` in a Worker of
 * its own process. The classifier is advisory, so every way that worker can
 * fail must fail open: the prompt continues natively, the hook exits 0, and no
 * statusline mode is written for a classification that never happened.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { installSomaForClaudeCode } from "../fixtures/shared-runtime";

const HOOK_REL = ".claude/hooks/soma/soma-mode-classifier.mjs";
const CONFIG_REL = ".claude/hooks/soma/soma-mode-classifier.config.json";
const FAIL_OPEN = "Soma mode classifier unavailable; continue natively";
const PROMPT = { hook_event_name: "UserPromptSubmit", session_id: "worker-sess", prompt: "Implement a multi-file migration for the adapter" };

interface ClassifierConfig {
  somaHome: string;
  trustedSomaRepo: string;
  bunPath: string;
}

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-mode-worker-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function runHook(homeDir: string, input: object): { status: number | null; context: string; elapsedMs: number } {
  const started = performance.now();
  const result = spawnSync(process.execPath, [join(homeDir, HOOK_REL)], {
    env: { ...process.env, HOME: homeDir },
    input: JSON.stringify(input),
    encoding: "utf8",
    // Far past the hook's own 3 s timer: a hook that ignores its timer is
    // killed here and fails the test instead of hanging the suite.
    timeout: 30_000,
  });
  const parsed = result.stdout ? JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } } : {};
  return { status: result.status, context: parsed.hookSpecificOutput?.additionalContext ?? "", elapsedMs: performance.now() - started };
}

async function installWithWorker(homeDir: string, body: string): Promise<ClassifierConfig> {
  await installSomaForClaudeCode({ homeDir });
  const config = JSON.parse(await readFile(join(homeDir, CONFIG_REL), "utf8")) as ClassifierConfig;
  const repo = join(homeDir, "fake-soma");
  await mkdir(join(repo, "src", "cli"), { recursive: true });
  await writeFile(join(repo, "src", "cli", "mode-classifier-worker.ts"), body, "utf8");
  await writeFile(join(homeDir, CONFIG_REL), JSON.stringify({ ...config, trustedSomaRepo: repo }), "utf8");
  return config;
}

async function statuslineFiles(somaHome: string): Promise<string[]> {
  const entries = await readdir(join(somaHome, "memory", "STATE")).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith("statusline-mode-"));
}

test("the installed classifier worker classifies and feeds the statusline", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const out = runHook(homeDir, PROMPT);
    expect(out.status).toBe(0);
    expect(out.context).toContain("Soma MODE: ALGORITHM E3");
    const config = JSON.parse(await readFile(join(homeDir, CONFIG_REL), "utf8")) as ClassifierConfig;
    expect(await statuslineFiles(config.somaHome)).toEqual(["statusline-mode-worker-sess.json"]);
  });
});

test("a classify error from the worker fails open with the CLI's message", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    // A prompt that reads as a flag makes the CLI parser throw.
    const out = runHook(homeDir, { ...PROMPT, prompt: "--json" });
    expect(out.status).toBe(0);
    expect(out.context).toBe(`${FAIL_OPEN} unless this prompt clearly needs Algorithm. --prompt requires a value.\n`);
  });
});

test("a classifier worker that exits without a classification fails open", async () => {
  await withTempHome(async (homeDir) => {
    const config = await installWithWorker(homeDir, "self.onmessage = () => { process.exit(0); };\n");
    const out = runHook(homeDir, PROMPT);
    expect(out.status).toBe(0);
    expect(out.context).toContain(FAIL_OPEN);
    expect(out.context).toContain("exited without a classification");
    expect(await statuslineFiles(config.somaHome)).toEqual([]);
  });
});

test("a classifier worker that fails to load fails open", async () => {
  await withTempHome(async (homeDir) => {
    await installWithWorker(homeDir, 'import { nothing } from "./does-not-exist";\nconsole.log(nothing);\n');
    const out = runHook(homeDir, PROMPT);
    expect(out.status).toBe(0);
    expect(out.context).toContain(FAIL_OPEN);
    // The load error names the cause; a bare exit would not.
    expect(out.context).toContain("Cannot find module './does-not-exist'");
  });
});

test("a classifier worker stuck in a synchronous loop fails open on the hook's timeout", async () => {
  await withTempHome(async (homeDir) => {
    const config = await installWithWorker(homeDir, "self.onmessage = () => { for (;;) {} };\n");
    const out = runHook(homeDir, PROMPT);
    expect(out.status).toBe(0);
    expect(out.context).toContain(FAIL_OPEN);
    expect(out.context).toContain("timed out after 3000 ms");
    expect(await statuslineFiles(config.somaHome)).toEqual([]);
  });
}, 60_000);
