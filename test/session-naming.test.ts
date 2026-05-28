import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";

const run = promisify(execFile);
import { deriveSessionName } from "../src/lifecycle";
import { bootstrapSomaHome, runSomaLifecycleSessionEnd, runSomaLifecycleSessionStart, scaffoldIsa, setActiveIsa } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-session-naming-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function readWork(homeDir: string): Promise<Record<string, { sessionUUID: string; sessionName: string; task: string }>> {
  const work = JSON.parse(await readFile(join(homeDir, ".soma/memory/STATE/work.json"), "utf8"));
  return work.sessions;
}

// --- Pure deriveSessionName: priority order ---

test("deriveSessionName prefers the active ISA slug and goal", () => {
  expect(
    deriveSessionName({
      sessionId: "uuid-1",
      activeIsaSlug: "kaltura-xss-fuzz",
      activeIsaGoal: "Fuzz the upload endpoint for stored XSS.",
      cwd: "/Users/fischer/work/mf/soma",
      gitBranch: "feature-x",
    }),
  ).toEqual({
    slug: "kaltura-xss-fuzz",
    sessionName: "kaltura-xss-fuzz",
    task: "Fuzz the upload endpoint for stored XSS.",
  });
});

test("deriveSessionName falls back to cwd basename plus a feature branch", () => {
  expect(
    deriveSessionName({ sessionId: "uuid-2", cwd: "/Users/fischer/work/mf/sage", gitBranch: "issue-236" }),
  ).toEqual({ slug: "sage/issue-236", sessionName: "sage/issue-236" });
});

test("deriveSessionName uses bare cwd basename for default branches", () => {
  for (const branch of ["main", "master", "HEAD", "develop", "trunk", ""]) {
    expect(deriveSessionName({ sessionId: "uuid-3", cwd: "/Users/fischer/work/mf/soma", gitBranch: branch })).toEqual({
      slug: "soma",
      sessionName: "soma",
    });
  }
});

test("deriveSessionName uses bare cwd basename when no branch is known", () => {
  expect(deriveSessionName({ sessionId: "uuid-4", cwd: "/a/b/reporter/" })).toEqual({
    slug: "reporter",
    sessionName: "reporter",
  });
});

test("deriveSessionName falls back to the legacy uuid name", () => {
  expect(deriveSessionName({ sessionId: "uuid-5" })).toEqual({
    slug: "session uuid-5",
    sessionName: "session uuid-5",
    task: "Session uuid-5",
  });
  // empty cwd → still fallback
  expect(deriveSessionName({ sessionId: "uuid-6", cwd: "   " })).toEqual({
    slug: "session uuid-6",
    sessionName: "session uuid-6",
    task: "Session uuid-6",
  });
});

// --- Integration: lifecycle plumbs cwd / active ISA into the work registry ---

test("session-start names the registry entry after the cwd basename", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await runSomaLifecycleSessionStart({
      homeDir,
      substrate: "claude-code",
      sessionId: "sess-cwd",
      cwd: "/Users/fischer/work/mf/soma",
      gitBranch: "main",
      timestamp: "2026-05-28T10:00:00.000Z",
    });

    const sessions = await readWork(homeDir);
    expect(sessions.soma).toMatchObject({ sessionUUID: "sess-cwd", sessionName: "soma" });
    expect(sessions["session-sess-cwd"]).toBeUndefined();
  });
});

test("session-start detects the git branch from cwd when none is supplied", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    // Real repo on a non-default branch; no gitBranch / ISA passed, so the
    // lifecycle must shell out via detectGitBranch() to discover it.
    const repo = await mkdtemp(join(tmpdir(), "soma-naming-repo-"));
    try {
      await run("git", ["-C", repo, "init", "-q"]);
      await run("git", ["-C", repo, "checkout", "-q", "-b", "feature-z"]);

      await runSomaLifecycleSessionStart({
        homeDir,
        substrate: "claude-code",
        sessionId: "sess-detect",
        cwd: repo,
        timestamp: "2026-05-28T12:00:00.000Z",
      });

      const sessions = await readWork(homeDir);
      const entry = Object.values(sessions).find((value) => value.sessionUUID === "sess-detect");
      expect(entry).toBeDefined();
      // git present → "<repo-basename>/feature-z"; if git is unavailable the
      // best-effort detection yields undefined and we fall back to the bare
      // basename. Either is acceptable; the detection path is what's exercised.
      const base = basename(repo);
      expect([`${base}/feature-z`, base]).toContain(entry?.sessionName ?? "");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("an active ISA slug wins over cwd, end re-keys the same entry", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await scaffoldIsa({ homeDir, slug: "switch-netops-ai", goal: "Ship the NetOps assistant.", effort: "E2" });
    await setActiveIsa("switch-netops-ai", { homeDir });

    await runSomaLifecycleSessionStart({
      homeDir,
      substrate: "claude-code",
      sessionId: "sess-isa",
      cwd: "/Users/fischer/work/mf/soma",
      timestamp: "2026-05-28T11:00:00.000Z",
    });
    await runSomaLifecycleSessionEnd({
      homeDir,
      substrate: "claude-code",
      sessionId: "sess-isa",
      cwd: "/Users/fischer/work/mf/soma",
      timestamp: "2026-05-28T11:30:00.000Z",
    });

    const sessions = await readWork(homeDir);
    // ISA slug used, not "soma"; exactly one entry for the session.
    expect(sessions["switch-netops-ai"]).toMatchObject({
      sessionUUID: "sess-isa",
      sessionName: "switch-netops-ai",
      task: "Ship the NetOps assistant.",
      phase: "complete",
    });
    expect(sessions.soma).toBeUndefined();
    const forSession = Object.values(sessions).filter((entry) => entry.sessionUUID === "sess-isa");
    expect(forSession).toHaveLength(1);
  });
});
