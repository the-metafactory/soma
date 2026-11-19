import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { auditMemory } from "../src/memory/index";
import { parseMemoryArgs, runMemoryCli } from "../src/cli/memory";
import type { SomaMemoryAuditResult } from "../src/memory/types";

// The home-replication probe reads real git state, so every case here builds a
// real repository: a bare "remote", a seed clone that pushes to it, and the Soma
// home as a second clone with an upstream tracking ref. No mocks.

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Soma Test",
  GIT_AUTHOR_EMAIL: "soma-test@localhost",
  GIT_COMMITTER_NAME: "Soma Test",
  GIT_COMMITTER_EMAIL: "soma-test@localhost",
};

function git(cwd: string, args: string[], options: { allowFailure?: boolean } = {}): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

interface Fixture {
  dir: string;
  remote: string;
  seed: string;
  somaHome: string;
}

/** A replicating Soma home: `somaHome` is a clone of `remote` tracking `origin/main`. */
async function withReplicatedHome<T>(fn: (fx: Fixture) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "soma-audit-repl-")));
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  const somaHome = join(dir, ".soma");
  try {
    git(dir, ["init", "-q", "--bare", "-b", "main", remote]);
    git(dir, ["clone", "-q", remote, seed], { allowFailure: true });
    await writeFile(join(seed, "notes.md"), "base\n");
    git(seed, ["add", "notes.md"]);
    git(seed, ["commit", "-q", "-m", "base"]);
    git(seed, ["push", "-q", "-u", "origin", "HEAD:main"]);
    git(dir, ["clone", "-q", remote, somaHome]);
    return await fn({ dir, remote, seed, somaHome });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One conflicting commit on each side, the remote side already fetched. */
async function divergeWithConflict(fx: Fixture): Promise<void> {
  await writeFile(join(fx.seed, "notes.md"), "remote edit\n");
  git(fx.seed, ["commit", "-q", "-am", "remote edit"]);
  git(fx.seed, ["push", "-q", "origin", "HEAD:main"]);
  await writeFile(join(fx.somaHome, "notes.md"), "local edit\n");
  git(fx.somaHome, ["commit", "-q", "-am", "local edit"]);
  git(fx.somaHome, ["fetch", "-q", "origin"]);
}

function replicationProbe(result: SomaMemoryAuditResult) {
  const probe = result.probes.find((p) => p.name === "home-replication");
  if (probe === undefined) throw new Error("home-replication probe missing from the audit");
  return probe;
}

const HOUR = 60 * 60 * 1000;

test("home-replication: a clean clone tracking a freshly fetched upstream is ok and HEALTHY", async () => {
  await withReplicatedHome(async ({ somaHome }) => {
    const result = await auditMemory({ somaHome });
    const probe = replicationProbe(result);
    expect(probe.gatesHealth).toBe(true);
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("origin/main");
    expect(probe.detail).toContain("ahead 0, behind 0");
    expect(result.healthy).toBe(true);
  });
});

test("home-replication: a soma home that is not a git work tree is skipped, not failed", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "soma-audit-repl-")));
  try {
    const somaHome = join(dir, ".soma");
    await mkdir(somaHome, { recursive: true });
    const probe = replicationProbe(await auditMemory({ somaHome }));
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("skipped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("home-replication: a soma home nested inside some other repository is skipped (it is not its own clone)", async () => {
  await withReplicatedHome(async ({ seed }) => {
    const nested = join(seed, "nested-home");
    await mkdir(nested, { recursive: true });
    const probe = replicationProbe(await auditMemory({ somaHome: nested }));
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("skipped");
  });
});

test("home-replication: a git home whose branch has no upstream skips only the staleness rule", async () => {
  await withReplicatedHome(async ({ somaHome }) => {
    git(somaHome, ["branch", "-q", "--unset-upstream"]);
    const probe = replicationProbe(await auditMemory({ somaHome, now: new Date(Date.now() + 100 * HOUR) }));
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("no upstream tracking ref");
  });
});

test("home-replication: a rebase stopped on a conflict FAILS and names the fix", async () => {
  await withReplicatedHome(async (fx) => {
    await divergeWithConflict(fx);
    git(fx.somaHome, ["rebase", "origin/main"], { allowFailure: true });
    const result = await auditMemory({ somaHome: fx.somaHome });
    const probe = replicationProbe(result);
    expect(probe.ok).toBe(false);
    expect(result.healthy).toBe(false);
    expect(probe.detail).toContain("rebase in progress");
    expect(probe.detail).toContain(fx.somaHome);
    expect(probe.detail).toContain("soma-sync");
  });
});

test("home-replication: a merge stopped on a conflict (MERGE_HEAD) FAILS", async () => {
  await withReplicatedHome(async (fx) => {
    await divergeWithConflict(fx);
    git(fx.somaHome, ["merge", "--no-edit", "origin/main"], { allowFailure: true });
    const result = await auditMemory({ somaHome: fx.somaHome });
    const probe = replicationProbe(result);
    expect(probe.ok).toBe(false);
    expect(result.healthy).toBe(false);
    expect(probe.detail).toContain("merge in progress");
  });
});

test("home-replication: a detached HEAD FAILS and names the fix", async () => {
  await withReplicatedHome(async ({ somaHome }) => {
    git(somaHome, ["checkout", "-q", "--detach"]);
    const result = await auditMemory({ somaHome });
    const probe = replicationProbe(result);
    expect(probe.ok).toBe(false);
    expect(result.healthy).toBe(false);
    expect(probe.detail).toContain("detached HEAD");
    expect(probe.detail).toContain(`git -C ${somaHome} switch`);
  });
});

test("home-replication: an upstream ref not updated for longer than the default 24 h FAILS", async () => {
  await withReplicatedHome(async ({ somaHome }) => {
    const result = await auditMemory({ somaHome, now: new Date(Date.now() + 25 * HOUR) });
    const probe = replicationProbe(result);
    expect(probe.ok).toBe(false);
    expect(result.healthy).toBe(false);
    expect(probe.detail).toContain("origin/main last updated 25h ago");
    expect(probe.detail).toContain("threshold 24h");
    expect(probe.detail).toContain("soma-sync");
  });
});

test("home-replication: just inside the default threshold is still ok", async () => {
  await withReplicatedHome(async ({ somaHome }) => {
    const probe = replicationProbe(await auditMemory({ somaHome, now: new Date(Date.now() + 23 * HOUR) }));
    expect(probe.ok).toBe(true);
  });
});

test("home-replication: a successful fetch that brought nothing new still counts as fresh (FETCH_HEAD)", async () => {
  await withReplicatedHome(async ({ somaHome }) => {
    // Pretend the clone happened two days ago: only the fetch below is recent.
    const later = new Date(Date.now() + 48 * HOUR);
    git(somaHome, ["fetch", "-q", "origin", "main"]);
    await utimes(join(somaHome, ".git", "FETCH_HEAD"), later, later);
    const probe = replicationProbe(await auditMemory({ somaHome, now: new Date(later.getTime() + HOUR) }));
    expect(probe.ok).toBe(true);
  });
});

test("home-replication: the staleness threshold is configurable (--replication-stale-hours)", async () => {
  await withReplicatedHome(async ({ somaHome }) => {
    const now = new Date(Date.now() + 30 * HOUR);
    expect(replicationProbe(await auditMemory({ somaHome, now, replicationStaleHours: 48 })).ok).toBe(true);
    expect(replicationProbe(await auditMemory({ somaHome, now, replicationStaleHours: 12 })).ok).toBe(false);
    expect(parseMemoryArgs(["memory", "audit", "--replication-stale-hours", "6"])).toMatchObject({
      options: { replicationStaleHours: 6 },
    });
    expect(() => parseMemoryArgs(["memory", "audit", "--replication-stale-hours", "zero"])).toThrow();
  });
});

test("home-replication: ahead/behind counts are reported but do not fail the probe", async () => {
  await withReplicatedHome(async (fx) => {
    await divergeWithConflict(fx);
    const probe = replicationProbe(await auditMemory({ somaHome: fx.somaHome }));
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("ahead 1, behind 1");
  });
});

test("home-replication: the CLI exits UNHEALTHY on a stuck rebase and prints the FAIL line", async () => {
  await withReplicatedHome(async (fx) => {
    await divergeWithConflict(fx);
    git(fx.somaHome, ["rebase", "origin/main"], { allowFailure: true });
    await expect(runMemoryCli(parseMemoryArgs(["memory", "audit", "--soma-home", fx.somaHome]))).rejects.toThrow(
      /\[FAIL\] home-replication: .*rebase in progress/,
    );
  });
});
