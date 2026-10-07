/**
 * A burst of headless Claude Code sessions must not pile up Soma lifecycle
 * processes, and a reinstall under a different Bun must not double every hook.
 *
 * Found 2026-09-12: `sage` reviewing five PRs at once started 27 `claude -p`
 * sessions (entrypoint `sdk-cli`) in 30 s. Every Soma hook was registered twice
 * — once per Bun install — so each session detached two
 * `bun src/cli.ts lifecycle session-start` processes. All 54 queued on the work
 * registry lock with the 30 s default, each holding 1.3–1.9 GB, and the host
 * hit a kernel watchdog panic three times. Three guards, one per link:
 *
 * 1. the Claude Code lifecycle hook passes a short work-registry lock timeout,
 *    as the Codex adapter already does for session-end;
 * 2. it starts no lifecycle process for an SDK-driven headless session;
 * 3. `soma install` replaces Soma entries written with another Bun path
 *    instead of appending a second set.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { installSomaForClaudeCode } from "../src/index";
import {
  patchClaudeCodeFeedbackCaptureSettings,
  patchClaudeCodeModeClassifierSettings,
  patchClaudeCodePolicyGuardSettings,
  patchClaudeCodePreCompactSettings,
  patchClaudeCodeSomaHookSettings,
} from "../src/adapters/claude-code/hooks";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-fanout-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Poll for a file a detached child writes, up to `timeoutMs`. */
async function waitForFile(path: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) {
      const content = await readFile(path, "utf8");
      if (content.length > 0) return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

/**
 * Install Soma into a temp home, then point the installed hook's `bunPath` at a
 * recorder that writes the arguments it was started with — so what the hook
 * would have handed to `bun src/cli.ts` is readable without running Soma.
 */
async function installWithRecorder(homeDir: string): Promise<{ hookPath: string; recordPath: string }> {
  await installSomaForClaudeCode({ homeDir });
  return pointHookAtRecorder(homeDir);
}

async function pointHookAtRecorder(homeDir: string): Promise<{ hookPath: string; recordPath: string }> {
  const hookDir = join(homeDir, ".claude/hooks/soma");
  const hookPath = join(hookDir, "soma-claude-code-hook.mjs");
  const configPath = join(hookDir, "soma-claude-code-hook.config.json");
  const recordPath = join(homeDir, "recorded-args.txt");
  const recorder = join(homeDir, "recorder.sh");
  await writeFile(recorder, `#!/bin/sh\nprintf '%s\\n' "$@" > '${recordPath}'\n`, "utf8");
  await chmod(recorder, 0o755);
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(configPath, `${JSON.stringify({ ...config, bunPath: recorder }, null, 2)}\n`, "utf8");
  return { hookPath, recordPath };
}

function runHook(hookPath: string, event: string, entrypoint: string, homeDir: string, runtimeHome?: string) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.CLAUDE_CODE_ENTRYPOINT = entrypoint;
  if (runtimeHome !== undefined) {
    env.HOME = runtimeHome;
    env.USERPROFILE = runtimeHome;
    env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
  }
  return spawnSync(process.execPath, [hookPath, event], {
    input: JSON.stringify({ session_id: "fanout-test-session", cwd: homeDir }),
    env,
    encoding: "utf8",
  });
}

for (const operation of ["install", "reproject"] as const) {
  for (const event of ["session-start", "session-end"] as const) {
    test(`${operation} binds the Claude Code ${event} hook to a custom home despite a different runtime HOME`, async () => {
      await withTempHome(async (root) => {
        const homeDir = join(root, "installation-home");
        const runtimeHome = join(root, "runtime-home");
        const somaHome = join(root, "soma-source");
        await mkdir(runtimeHome);
        await installSomaForClaudeCode({ homeDir, somaHome });

        if (operation === "reproject") {
          // Simulate a legacy hook config before reprojection, so retaining the
          // original install's homeDir cannot make this case pass accidentally.
          const configPath = join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.config.json");
          const config = JSON.parse(await readFile(configPath, "utf8"));
          delete config.homeDir;
          await writeFile(configPath, JSON.stringify(config));
          const result = spawnSync(process.execPath, [
            "src/cli.ts", "reproject", "claude-code", "--home-dir", homeDir, "--soma-home", somaHome,
          ], {
            cwd: resolve(import.meta.dir, ".."),
            env: { ...process.env, HOME: runtimeHome, USERPROFILE: runtimeHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
            encoding: "utf8",
            timeout: 30_000,
          });
          expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
        }

        const configPath = join(homeDir, ".claude/hooks/soma/soma-claude-code-hook.config.json");
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ homeDir, somaHome });
        const { hookPath, recordPath } = await pointHookAtRecorder(homeDir);
        const result = runHook(hookPath, event, "cli", homeDir, runtimeHome);
        expect(result.status).toBe(0);
        const recorded = await waitForFile(recordPath, 5000);
        expect(recorded).toBeDefined();
        const args = (recorded ?? "").trim().split("\n");
        expect(args).toContain("lifecycle");
        expect(args).toContain(event);
        for (const [flag, value] of [["--soma-home", somaHome], ["--home-dir", homeDir]] as const) {
          const index = args.indexOf(flag);
          expect(index).toBeGreaterThan(-1);
          expect(args[index + 1]).toBe(value);
        }
      });
    }, 30_000);
  }
}

for (const event of ["session-start", "session-end"] as const) {
  test(`the ${event} hook passes a short work-registry lock timeout`, async () => {
    await withTempHome(async (homeDir) => {
      const { hookPath, recordPath } = await installWithRecorder(homeDir);
      runHook(hookPath, event, "cli", homeDir);
      const recorded = await waitForFile(recordPath, 5000);
      expect(recorded).toBeDefined();
      const args = (recorded ?? "").trim().split("\n");
      expect(args).toContain("lifecycle");
      expect(args).toContain(event);
      expect(args[args.indexOf("--home-dir") + 1]).toBe(homeDir);
      const flag = args.indexOf("--work-registry-lock-timeout-ms");
      expect(flag).toBeGreaterThan(-1);
      const timeoutMs = Number(args[flag + 1]);
      // Short enough that a burst fails fast instead of queueing; the Codex
      // adapter's session-end already uses 1 s.
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(1000);
    });
  });

  test(`the ${event} hook starts no lifecycle process for an SDK-driven headless session`, async () => {
    await withTempHome(async (homeDir) => {
      const { hookPath, recordPath } = await installWithRecorder(homeDir);
      // Control first: the same install, the same recorder, an interactive
      // entrypoint — the recorder must fire, or the absence below proves nothing.
      runHook(hookPath, event, "cli", homeDir);
      expect(await waitForFile(recordPath, 5000)).toBeDefined();
      await rm(recordPath, { force: true });

      for (const entrypoint of ["sdk-cli", "sdk-ts", "sdk-py"]) {
        runHook(hookPath, event, entrypoint, homeDir);
        expect([entrypoint, await waitForFile(recordPath, 1500)]).toEqual([entrypoint, undefined]);
      }
    });
    // A control run plus three 1.5 s waits for a file that must not appear is
    // longer than bun's 5 s default; the red build returned early because the
    // file did appear, which is why the default only bit once the fix worked.
  }, 20_000);
}

type PatchFn = (substrateHome: string, bunPath: string) => Promise<string[]>;

const PATCHES: readonly [string, PatchFn, string][] = [
  ["lifecycle and writeback hooks", patchClaudeCodeSomaHookSettings, "soma-claude-code-hook.mjs"],
  ["mode classifier", patchClaudeCodeModeClassifierSettings, "soma-mode-classifier.mjs"],
  ["policy guard", patchClaudeCodePolicyGuardSettings, "soma-policy-guard.mjs"],
  ["pre-compact", patchClaudeCodePreCompactSettings, "soma-precompact.mjs"],
  ["feedback capture", patchClaudeCodeFeedbackCaptureSettings, "soma-feedback-capture.mjs"],
];

function commandsReferencing(settings: { hooks?: Record<string, unknown[]> }, script: string): string[] {
  return Object.values(settings.hooks ?? {}).flatMap((groups) =>
    (groups ?? []).flatMap((group) => {
      if (!group || typeof group !== "object" || !("hooks" in group) || !Array.isArray(group.hooks)) return [];
      return group.hooks
        .map((hook) => (hook && typeof hook === "object" && "command" in hook ? String(hook.command) : ""))
        .filter((command) => command.includes(script));
    }),
  );
}

for (const [label, patch, script] of PATCHES) {
  test(`reinstalling the ${label} under another Bun replaces its entries instead of adding a second set`, async () => {
    await withTempHome(async (homeDir) => {
      const substrateHome = join(homeDir, ".claude");
      const settingsPath = join(substrateHome, "settings.json");
      await patch(substrateHome, "/tmp/soma-test-bun-a");
      const once = JSON.parse(await readFile(settingsPath, "utf8"));
      const firstCount = commandsReferencing(once, script).length;
      expect(firstCount).toBeGreaterThan(0);

      await patch(substrateHome, "/tmp/soma-test-bun-b");
      const twice = JSON.parse(await readFile(settingsPath, "utf8"));
      const commands = commandsReferencing(twice, script);
      expect(commands.length).toBe(firstCount);
      expect(commands.every((command) => command.includes("/tmp/soma-test-bun-b"))).toBe(true);
      expect(commands.some((command) => command.includes("/tmp/soma-test-bun-a"))).toBe(false);
    });
  });
}
