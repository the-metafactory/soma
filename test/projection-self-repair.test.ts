/**
 * Projection self-repair (soma#460).
 *
 * A deterministic SessionStart pass that (1) restores the exec bit on a
 * projected direct-exec script that lost it, containment-guarded to the
 * substrate home, and (2) reports content drift vs a fresh render. These tests
 * exercise the portable core against the claude-code reference surface (the
 * statusline — the one projection Claude Code execs directly via its shebang).
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  claudeCodeProjectionRepairArtifacts,
  installSomaForClaudeCode,
  repairProjectedArtifacts,
  runSomaLifecycleSessionStart,
} from "../src/index";

const STATUSLINE_REL = ".claude/hooks/soma/soma-statusline.sh";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-proj-repair-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function claudeArtifacts(homeDir: string): { substrateHome: string; artifacts: ReturnType<typeof claudeCodeProjectionRepairArtifacts> } {
  const substrateHome = join(homeDir, ".claude");
  return {
    substrateHome,
    artifacts: claudeCodeProjectionRepairArtifacts({ substrateHome, somaHome: join(homeDir, ".soma") }),
  };
}

test("restores the exec bit on a projected direct-exec script that lost it", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptPath = join(homeDir, STATUSLINE_REL);
    await chmod(scriptPath, 0o644);
    expect((await stat(scriptPath)).mode & 0o100).toBe(0);

    const { substrateHome, artifacts } = claudeArtifacts(homeDir);
    const result = await repairProjectedArtifacts({ substrateHome, artifacts });

    expect(result.healed).toEqual([scriptPath]);
    expect((await stat(scriptPath)).mode & 0o111).not.toBe(0);
    expect(result.findings.some((f) => f.kind === "exec-bit-restored" && f.path === scriptPath)).toBe(true);
    // Only the mode changed — the bytes still match the fresh render.
    expect(result.drifted).toEqual([]);
  });
});

test("refuses to follow a symlink that escapes the substrate home", async () => {
  await withTempHome(async (homeDir) => {
    const substrateHome = join(homeDir, ".claude");
    const hookDir = join(substrateHome, "hooks/soma");
    await mkdir(hookDir, { recursive: true });

    // A real script OUTSIDE the substrate home, non-executable.
    const outsideScript = join(homeDir, "outside", "evil.sh");
    await mkdir(join(homeDir, "outside"), { recursive: true });
    await writeFile(outsideScript, "#!/bin/sh\n", { mode: 0o644 });
    await chmod(outsideScript, 0o644);

    // The projected path is a symlink into the escaped target.
    const linkPath = join(hookDir, "soma-statusline.sh");
    await symlink(outsideScript, linkPath);

    const result = await repairProjectedArtifacts({
      substrateHome,
      artifacts: [{ path: linkPath, directExec: true, expected: "#!/bin/sh\n" }],
    });

    expect(result.skipped).toEqual([linkPath]);
    expect(result.healed).toEqual([]);
    expect(result.drifted).toEqual([]);
    // The escaped target was never chmod'd — still 0644, not executable.
    expect((await stat(outsideScript)).mode & 0o111).toBe(0);
    expect(result.findings.some((f) => f.kind === "containment-skip")).toBe(true);
  });
});

test("no-op on a healthy projection: nothing healed, drifted, or refused", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const { substrateHome, artifacts } = claudeArtifacts(homeDir);
    const result = await repairProjectedArtifacts({ substrateHome, artifacts });
    expect(result).toEqual({ healed: [], drifted: [], skipped: [], findings: [] });
  });
});

test("reports drift for a hand-edited projected file", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptPath = join(homeDir, STATUSLINE_REL);
    const original = await readFile(scriptPath, "utf8");
    await writeFile(scriptPath, `${original}\n# hand-edited\n`, { mode: 0o755 });

    const { substrateHome, artifacts } = claudeArtifacts(homeDir);
    const result = await repairProjectedArtifacts({ substrateHome, artifacts });

    expect(result.drifted).toEqual([scriptPath]);
    expect(result.findings.some((f) => f.kind === "content-drift" && f.path === scriptPath)).toBe(true);
    // Still executable — only the content changed, not the mode.
    expect(result.healed).toEqual([]);
  });
});

test("session start heals a chmod-644'd statusline and logs an observability event", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scriptPath = join(homeDir, STATUSLINE_REL);
    await chmod(scriptPath, 0o644);

    const start = await runSomaLifecycleSessionStart({
      homeDir,
      substrate: "claude-code",
      sessionId: "session-projection-repair",
      timestamp: "2026-07-13T10:00:00.000Z",
    });

    expect((await stat(scriptPath)).mode & 0o111).not.toBe(0);
    expect(start.files).toContain(scriptPath);

    const events = (await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const repair = events.find((event) => event.kind === "lifecycle.session_start.projection-repair");
    expect(repair).toBeDefined();
    expect(repair?.metadata.healed).toContain(scriptPath);
    expect(events.some((event) => event.kind === "lifecycle.session_start")).toBe(true);
  });
});

test("session start emits no projection-repair event when the projection is healthy", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });

    await runSomaLifecycleSessionStart({
      homeDir,
      substrate: "claude-code",
      sessionId: "session-healthy",
      timestamp: "2026-07-13T10:00:00.000Z",
    });

    const events = (await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.kind.startsWith("lifecycle.session_start.projection-repair"))).toBe(false);
  });
});
