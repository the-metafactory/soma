/**
 * `soma precompact` — the compaction-survival handover CLI.
 *
 * `capture` snapshots live work-state (active Algorithm runs) into a durable,
 * session-scoped file AND returns it for stdout emit. `resurface` returns that
 * file once and consumes it, so the handover re-injects exactly on the first
 * prompt after compaction and never again.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, createAlgorithmRun, writeAlgorithmRun } from "../src/index";
import { parsePreCompactArgs, preCompactHandoverPath, runPreCompactCli } from "../src/cli/precompact";
import { isEnoent } from "../src/fs-errors";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-precompact-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: unknown) => {
      if (isEnoent(error)) return false;
      throw error;
    },
  );
}

async function seedActiveRun(homeDir: string): Promise<void> {
  await writeAlgorithmRun(
    createAlgorithmRun({
      id: "active-precompact-run",
      timestamp: "2026-07-07T10:00:00.000Z",
      prompt: "Do compaction-surviving work",
      intent: "Expose active work across compaction.",
      currentState: "No handover.",
      goal: "Handover lists active runs.",
      criteria: [{ id: "C1", text: "Active run appears." }],
    }),
    { homeDir },
  );
}

test("capture writes a session-scoped handover file from the startup context and returns it for stdout", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await seedActiveRun(homeDir);
    const somaHome = join(homeDir, ".soma");

    const parsed = parsePreCompactArgs([
      "precompact",
      "capture",
      "--soma-home",
      somaHome,
      "--substrate",
      "claude-code",
      "--session-id",
      "sess-abc",
      "--cwd",
      "/work/dir",
    ]);
    const emitted = await runPreCompactCli(parsed);

    // Emitted to stdout (the "emit" half) …
    expect(emitted).toContain("# Pre-Compaction Handover");
    expect(emitted).toContain("Session: sess-abc");
    expect(emitted).toContain("Working directory: `/work/dir`");
    expect(emitted).toContain("# Soma Startup Context");
    expect(emitted).toContain("active-precompact-run");

    // … and persisted (the "persist" half) to the session-scoped path.
    const path = preCompactHandoverPath(somaHome, "sess-abc");
    expect(path).toBe(join(somaHome, "memory/STATE", "precompact-handover-sess-abc.md"));
    expect(await readFile(path, "utf8")).toContain("active-precompact-run");
  });
});

test("resurface prints the handover once then consumes (deletes) it", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await seedActiveRun(homeDir);
    const somaHome = join(homeDir, ".soma");

    await runPreCompactCli(
      parsePreCompactArgs(["precompact", "capture", "--soma-home", somaHome, "--session-id", "sess-xyz"]),
    );
    const path = preCompactHandoverPath(somaHome, "sess-xyz");
    expect(await fileExists(path)).toBe(true);

    const first = await runPreCompactCli(
      parsePreCompactArgs(["precompact", "resurface", "--soma-home", somaHome, "--session-id", "sess-xyz"]),
    );
    expect(first).toContain("# Pre-Compaction Handover");
    expect(first).toContain("active-precompact-run");
    expect(await fileExists(path)).toBe(false); // consumed

    const second = await runPreCompactCli(
      parsePreCompactArgs(["precompact", "resurface", "--soma-home", somaHome, "--session-id", "sess-xyz"]),
    );
    expect(second).toBe("");
  });
});

test("resurface returns empty when there is no handover file (no compaction happened)", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const somaHome = join(homeDir, ".soma");
    const out = await runPreCompactCli(
      parsePreCompactArgs(["precompact", "resurface", "--soma-home", somaHome, "--session-id", "never-captured"]),
    );
    expect(out).toBe("");
  });
});

test("capture/resurface round-trip without a session id uses the unscoped path", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await seedActiveRun(homeDir);
    const somaHome = join(homeDir, ".soma");

    await runPreCompactCli(parsePreCompactArgs(["precompact", "capture", "--soma-home", somaHome]));
    const path = preCompactHandoverPath(somaHome);
    expect(path).toBe(join(somaHome, "memory/STATE", "precompact-handover.md"));
    expect(await fileExists(path)).toBe(true);

    const out = await runPreCompactCli(parsePreCompactArgs(["precompact", "resurface", "--soma-home", somaHome]));
    expect(out).toContain("# Pre-Compaction Handover");
    expect(await fileExists(path)).toBe(false);
  });
});

test("a session id with path-hostile characters is sanitized into the filename", () => {
  const path = preCompactHandoverPath("/home/.soma", "../../etc/passwd");
  expect(path).toBe("/home/.soma/memory/STATE/precompact-handover-______etc_passwd.md");
});

test("parsePreCompactArgs rejects an unknown action", () => {
  expect(() => parsePreCompactArgs(["precompact", "bogus"])).toThrow(/capture\|resurface/);
});
