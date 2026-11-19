import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isFsUtilsEnoent as isEnoent } from "../core/index";
import type { SomaMemoryAuditProbe } from "./types";

/** Default age, in hours, after which an upstream ref that has not moved fails the probe. */
export const DEFAULT_REPLICATION_STALE_HOURS = 24;

const GIT_TIMEOUT_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a read-only git command in the Soma home. `GIT_OPTIONAL_LOCKS=0` stops
 * git from refreshing the index as a side effect, and none of the commands used
 * here touch the network. Returns `undefined` when git itself is not installed.
 */
function runGit(cwd: string, args: string[]): GitResult | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  if (result.error !== undefined) {
    if (isEnoent(result.error)) return undefined;
    throw new Error(`git ${args.join(" ")} could not run`, { cause: result.error });
  }
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isEnoent(error)) return false;
      throw error;
    },
  );
}

async function mtimeMs(path: string): Promise<number | undefined> {
  return lstat(path).then(
    (info) => info.mtimeMs,
    (error: unknown) => {
      if (isEnoent(error)) return undefined;
      throw error;
    },
  );
}

/** Timestamp (ms) of the newest entry in a reflog file, or `undefined` when there is none. */
async function lastReflogMs(path: string): Promise<number | undefined> {
  const content = await readFile(path, "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return "";
    throw error;
  });
  const lines = content.trimEnd().split("\n");
  const match = /> (\d+) [+-]\d{4}\t/.exec(lines[lines.length - 1] ?? "");
  return match ? Number(match[1]) * 1000 : undefined;
}

function skipped(reason: string): SomaMemoryAuditProbe {
  return { name: "home-replication", gatesHealth: true, ok: true, detail: `skipped: ${reason}` };
}

function failed(detail: string): SomaMemoryAuditProbe {
  return { name: "home-replication", gatesHealth: true, ok: false, detail };
}

/**
 * Probe: the Soma home's git transport for home replication is not stuck (GATES
 * health). It runs only when the Soma home is the top level of its own git work
 * tree; any other home is skipped as ok. It fails when:
 *
 * - a rebase or merge is in progress (`rebase-merge`, `rebase-apply`, `MERGE_HEAD`),
 * - HEAD is detached, or
 * - the upstream tracking ref has not been updated for longer than `staleHours`.
 *   "Updated" is the newest of: the ref's last reflog entry, the loose ref file's
 *   mtime (or `packed-refs`' when the ref is packed), and `FETCH_HEAD`'s mtime. `FETCH_HEAD` is rewritten by every successful
 *   fetch, so a quiet remote with nothing new does not read as stale.
 *
 * Ahead/behind counts are reported but never fail the probe: the replication job
 * commits and pushes in the same run, so a non-zero count between runs is normal.
 * The counts compare against the local tracking ref; the probe never fetches.
 */
export async function probeHomeReplication(
  somaHome: string,
  options: { now: Date; staleHours: number },
): Promise<SomaMemoryAuditProbe> {
  if (!(await exists(somaHome))) return skipped("soma home does not exist");
  const located = runGit(somaHome, [
    "rev-parse",
    "--show-toplevel",
    "--git-path",
    "rebase-merge",
    "--git-path",
    "rebase-apply",
    "--git-path",
    "MERGE_HEAD",
    "--git-path",
    "FETCH_HEAD",
  ]);
  if (located === undefined) return skipped("git is not installed");
  if (located.status !== 0) {
    if (/not a git repository/i.test(located.stderr)) return skipped("soma home is not a git work tree");
    return failed(`git cannot read the soma home ${somaHome}: ${located.stderr || "unknown error"}`);
  }
  const [toplevel = "", rebaseMerge = "", rebaseApply = "", mergeHead = "", fetchHead = ""] = located.stdout.split("\n");
  if ((await realpath(toplevel)) !== (await realpath(somaHome))) {
    return skipped(`soma home is inside the git work tree ${toplevel}, not its own clone`);
  }
  const gitPath = (p: string) => (isAbsolute(p) ? p : join(somaHome, p));

  const problems: string[] = [];
  if ((await exists(gitPath(rebaseMerge))) || (await exists(gitPath(rebaseApply)))) {
    problems.push(
      `rebase in progress in ${somaHome}: resolve it or run 'git -C ${somaHome} rebase --abort', then run soma-sync`,
    );
  }
  if (await exists(gitPath(mergeHead))) {
    problems.push(`merge in progress in ${somaHome}: resolve it or run 'git -C ${somaHome} merge --abort', then run soma-sync`);
  }
  const branch = runGit(somaHome, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const detached = branch !== undefined && branch.status !== 0;
  if (detached) {
    problems.push(`detached HEAD in ${somaHome}: run 'git -C ${somaHome} switch main' (after any rebase is resolved), then run soma-sync`);
  }
  if (problems.length > 0) return failed(problems.join("; "));

  const upstream = runGit(somaHome, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  if (upstream?.status !== 0 || upstream.stdout === "") {
    return skipped(`branch ${branch?.stdout ?? "?"} has no upstream tracking ref; staleness not checked`);
  }
  const upstreamRef = upstream.stdout;
  const shortName = upstreamRef.replace(/^refs\/remotes\//, "");
  const paths = runGit(somaHome, [
    "rev-parse",
    "--git-path",
    `logs/${upstreamRef}`,
    "--git-path",
    upstreamRef,
    "--git-path",
    "packed-refs",
  ]);
  const [reflogPath = "", refPath = "", packedRefsPath = ""] = paths?.stdout.split("\n") ?? [];
  // A ref with no loose file lives in packed-refs (a fresh clone writes it there
  // and no reflog), so the packed-refs mtime stands in for the ref file's.
  const refMtime = refPath === "" ? undefined : await mtimeMs(gitPath(refPath));
  const candidates = await Promise.all([
    reflogPath === "" ? undefined : lastReflogMs(gitPath(reflogPath)),
    refMtime ?? (packedRefsPath === "" ? undefined : mtimeMs(gitPath(packedRefsPath))),
    mtimeMs(gitPath(fetchHead)),
  ]);
  const lastUpdate = candidates.reduce<number | undefined>((max, m) => (m !== undefined && (max === undefined || m > max) ? m : max), undefined);

  const counts = runGit(somaHome, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  const [ahead = "?", behind = "?"] = counts?.status === 0 ? counts.stdout.split(/\s+/) : [];
  const position = `ahead ${ahead}, behind ${behind}`;

  if (lastUpdate === undefined) {
    return failed(`no record of ${shortName} ever being updated in ${somaHome} (no reflog, ref file, packed-refs or FETCH_HEAD): run soma-sync`);
  }
  const ageHours = Math.floor((options.now.getTime() - lastUpdate) / HOUR_MS);
  if (options.now.getTime() - lastUpdate > options.staleHours * HOUR_MS) {
    return failed(
      `${shortName} last updated ${ageHours}h ago (threshold ${options.staleHours}h; ${position}): ` +
        `the home stopped fetching; check the soma-sync job and its log, then run soma-sync in ${somaHome}`,
    );
  }
  return {
    name: "home-replication",
    gatesHealth: true,
    ok: true,
    detail: `on ${branch?.stdout ?? "?"} tracking ${shortName}, last updated ${ageHours}h ago (threshold ${options.staleHours}h; ${position})`,
  };
}
