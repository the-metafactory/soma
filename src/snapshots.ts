import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { compressEventSegment, eventArchiveDir, eventArchiveVersion, eventIndexPath, ensureCompressedEventSegments, pendingCompressedEventSegments, prepareEventCompression, recoverPendingEventRotation, waitForEventReaders, withEventLogLock } from "./event-log";
import packageJson from "../package.json";
import { createPaths } from "./paths";
import type {
  SomaSnapshotEntry,
  SomaSnapshotListOptions,
  SomaSnapshotOptions,
  SomaSnapshotResult,
  SomaSnapshotRollbackOptions,
  SomaSnapshotRollbackResult,
} from "./types";

interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

const SNAPSHOT_GITIGNORE_HEADER = "# Soma snapshot safety ignores";
const SNAPSHOT_METADATA_FILE = ".soma-snapshot.json";
const SNAPSHOT_GITIGNORE_RULES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.crt",
  "*.cert",
  "id_rsa",
  "id_ed25519",
  ".ssh/",
  ".aws/",
  ".azure/",
  ".config/",
  ".secrets/",
  ".tokens/",
  "secrets/",
  "tokens/",
  "**/credentials",
  "**/credentials.*",
  "*.token",
] as const;

// Separate header/block: NOT a secrets concern like the block above — the memory
// index is a deterministic, rebuildable PROJECTION (M3/M8), never a source, so a
// snapshot has no reason to track its byte-for-byte churn (rebuilds re-stamp
// "verified Nd ago" ages even when the underlying notes didn't change).
const GENERATED_GITIGNORE_HEADER = "# Soma generated files";
const GENERATED_GITIGNORE_RULES = [
  "memory/INDEX.md",
  "memory/STATE/events.jsonl",
  "memory/STATE/events-index.json",
  "memory/STATE/.events.lock/",
  "memory/STATE/.events.lock.reclaim/",
  "memory/STATE/.events.readers/",
  "memory/STATE/.rotation-pending.json",
  "memory/STATE/events-snapshots/",
  "!memory/STATE/events-archive/",
  "memory/STATE/events-archive/*.jsonl",
  "memory/STATE/events-archive/*.validation",
  "memory/STATE/events-archive/*.tmp",
  "memory/STATE/events-index.json.*.tmp",
  "!memory/STATE/events-archive/*.jsonl.gz",
  "!memory/STATE/events-archive/*.jsonl.counts.json",
] as const;
const PROTECTED_EVENT_PATHS = [
  "memory/STATE/events.jsonl",
  "memory/STATE/events-index.json",
  "memory/STATE/events-archive/",
  "memory/STATE/.events.lock/",
  "memory/STATE/.events.lock.reclaim/",
  "memory/STATE/.events.readers/",
] as const;

interface SnapshotMetadata {
  ignoredPaths: string[];
}

function runGit(somaHome: string, args: string[], options: { allowFailure?: boolean } = {}): GitResult {
  const result = spawnSync("git", args, {
    cwd: somaHome,
    encoding: "utf8",
  });
  const status = result.status ?? 1;
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (status !== 0 && options.allowFailure !== true) {
    const detail = (stderr || stdout || `git ${args.join(" ")} failed`).trim();
    throw new Error(detail);
  }
  return { stdout, stderr, status };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function resolveSomaHome(options: { homeDir?: string; somaHome?: string }): string {
  return createPaths(options).root();
}

function sanitizeSnapshotLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

async function ensureSnapshotRepo(somaHome: string): Promise<void> {
  await mkdir(somaHome, { recursive: true });
  if (!(await pathExists(join(somaHome, ".git")))) {
    runGit(somaHome, ["init"]);
  }
  await ensureSnapshotGitignore(somaHome);
  untrackEventFiles(somaHome);
  runGit(somaHome, ["config", "user.name", "Soma Snapshot"]);
  runGit(somaHome, ["config", "user.email", "soma-snapshot@localhost"]);
}

function untrackEventFiles(somaHome: string): void {
  // Ignore rules alone do not protect a path already present in the index.
  // Remove it from future snapshots without touching the live working file.
  runGit(somaHome, ["rm", "--cached", "--ignore-unmatch", "--", "memory/STATE/events.jsonl"]);
  runGit(somaHome, ["rm", "--cached", "--ignore-unmatch", "--", "memory/STATE/events-index.json"]);
  const trackedArchives = runGit(somaHome, ["ls-files", "--", "memory/STATE/events-archive"]).stdout
    .split("\n")
    .filter((path) => /^memory\/STATE\/events-archive\/[^/]+\.jsonl$/.test(path));
  if (trackedArchives.length > 0) runGit(somaHome, ["rm", "--cached", "--ignore-unmatch", "--", ...trackedArchives]);
}

async function ensureSnapshotGitignore(somaHome: string): Promise<void> {
  const gitignorePath = join(somaHome, ".gitignore");
  const current = await readTextIfExists(gitignorePath);
  const lines = current.split(/\r?\n/);
  const gitignoreBlocks: readonly (readonly string[])[] = [
    [SNAPSHOT_GITIGNORE_HEADER, ...SNAPSHOT_GITIGNORE_RULES],
    [GENERATED_GITIGNORE_HEADER, ...GENERATED_GITIGNORE_RULES],
  ];
  const additions = gitignoreBlocks.flat().filter((line) => !lines.includes(line));
  if (additions.length === 0) return;

  const prefix = current.trimEnd();
  const next = [
    prefix,
    prefix.length > 0 ? "" : undefined,
    ...additions,
    "",
  ].filter((line) => line !== undefined).join("\n");
  await writeFile(gitignorePath, next, "utf8");
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return "";
    }
    throw error;
  }
}

async function writeSnapshotMetadata(somaHome: string): Promise<void> {
  const metadata: SnapshotMetadata = {
    ignoredPaths: listIgnoredPaths(somaHome),
  };
  await writeFile(join(somaHome, SNAPSHOT_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function readSnapshotMetadata(somaHome: string): Promise<SnapshotMetadata> {
  const raw = await readTextIfExists(join(somaHome, SNAPSHOT_METADATA_FILE));
  if (raw.trim() === "") return { ignoredPaths: [] };
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("ignoredPaths" in parsed)) {
    return { ignoredPaths: [] };
  }
  const ignoredPaths = (parsed as { ignoredPaths?: unknown }).ignoredPaths;
  if (!Array.isArray(ignoredPaths)) return { ignoredPaths: [] };
  return {
    ignoredPaths: ignoredPaths.filter((path): path is string => typeof path === "string" && isSafeRelativeGitPath(path)),
  };
}

function listIgnoredPaths(somaHome: string): string[] {
  const result = runGit(somaHome, ["status", "--ignored=matching", "--short", "-z", "--untracked-files=all"], { allowFailure: true });
  if (result.status !== 0 || result.stdout === "") return [];
  return result.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("!! "))
    .map((entry) => entry.slice(3))
    .filter(isSafeRelativeGitPath)
    .sort();
}

function isSafeRelativeGitPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

function isPreservedIgnoredPath(path: string, preserved: Set<string>): boolean {
  if (preserved.has(path)) return true;
  for (const preservedPath of preserved) {
    if (preservedPath.endsWith("/") && path.startsWith(preservedPath)) return true;
  }
  return false;
}

async function removeIgnoredAdditions(somaHome: string, preservedIgnoredPaths: readonly string[]): Promise<void> {
  const preserved = new Set(preservedIgnoredPaths);
  for (const ignoredPath of listIgnoredPaths(somaHome)) {
    if (isPreservedIgnoredPath(ignoredPath, preserved)) continue;
    await rm(join(somaHome, ignoredPath), { recursive: true, force: true });
  }
}

function assertSafeRevision(snapshot: string): void {
  if (snapshot.trim() === "" || snapshot.startsWith("-")) {
    throw new Error("Snapshot id must be a commit id or snapshot ref, not an option.");
  }
}

async function restoreProtectedFile(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.rollback-${crypto.randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}

async function restoreProtectedPath(backupPath: string, destination: string, existed: boolean, backupRoot: string): Promise<void> {
  if (!existed) { await rm(destination, { force: true }); return; }
  if (!(await pathExists(backupPath))) throw new Error(`Missing rollback event backup: ${backupRoot}`);
  await restoreProtectedFile(backupPath, destination);
}

export async function createSomaSnapshot(options: SomaSnapshotOptions = {}): Promise<SomaSnapshotResult> {
  const somaHome = resolveSomaHome(options);
  const name = sanitizeSnapshotLabel(options.name, "manual");
  const trigger = sanitizeSnapshotLabel(options.trigger, "manual");
  const createdAt = new Date().toISOString();

  await ensureSnapshotRepo(somaHome);
  const eventsPath = createPaths(somaHome).events();
  await writeSnapshotMetadata(somaHome);
  runGit(somaHome, ["add", "-A"]);
  let stagedEvents = false;
  for (let attempt = 0; attempt < 5 && !stagedEvents; attempt++) {
    const prepared = await withEventLogLock(eventsPath, async () => {
      await recoverPendingEventRotation(eventsPath);
      return prepareEventCompression(eventsPath);
    });
    let verifiedVersion: string | undefined;
    try {
      for (const path of prepared.paths) await compressEventSegment(path);
      if ((await pendingCompressedEventSegments(eventsPath)).length === 0) {
        const before = await eventArchiveVersion(eventsPath);
        let validated = false;
        try { await ensureCompressedEventSegments(eventsPath, false); validated = true; }
        catch (error) {
          if ((await pendingCompressedEventSegments(eventsPath)).length === 0) throw error;
        }
        const after = await eventArchiveVersion(eventsPath);
        if (validated && before === after) verifiedVersion = after;
      }
    }
    finally { await prepared.release(); }
    if (verifiedVersion === undefined) continue;
    stagedEvents = await withEventLogLock(eventsPath, async () => {
      if ((await pendingCompressedEventSegments(eventsPath)).length > 0) return false;
      if ((await eventArchiveVersion(eventsPath)) !== verifiedVersion) return false;
      const archivePath = "memory/STATE/events-archive";
      if (await pathExists(eventArchiveDir(eventsPath)) || runGit(somaHome, ["ls-files", "--", archivePath]).stdout.trim()) {
        runGit(somaHome, ["add", "-A", "--", archivePath]);
      }
      return true;
    });
  }
  if (!stagedEvents) throw new Error("Event archive kept changing during snapshot compression");
  runGit(somaHome, [
    "commit",
    "--allow-empty",
    "-m",
    `soma snapshot: ${name}`,
    "-m",
    `trigger: ${trigger}\ncreated-at: ${createdAt}\nsoma-version: ${packageJson.version}`,
  ]);
  const id = runGit(somaHome, ["rev-parse", "HEAD"]).stdout.trim();
  return { somaHome, id, name, trigger, createdAt };
}

export async function listSomaSnapshots(options: SomaSnapshotListOptions = {}): Promise<SomaSnapshotEntry[]> {
  const somaHome = resolveSomaHome(options);
  if (!(await pathExists(join(somaHome, ".git")))) {
    return [];
  }
  const limit = options.limit === undefined ? 20 : Math.max(1, Math.min(100, Math.trunc(options.limit)));
  const result = runGit(somaHome, [
    "log",
    `--max-count=${limit}`,
    "--grep=^soma snapshot:",
    "--format=%H%x1f%cI%x1f%s",
  ], { allowFailure: true });
  if (result.status !== 0 || result.stdout.trim() === "") {
    return [];
  }
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [id = "", createdAt = "", subject = ""] = line.split("\x1f");
      return {
        id,
        createdAt,
        subject,
        name: subject.replace(/^soma snapshot:\s*/, ""),
      };
    });
}

async function withPreservedEventHistory(
  somaHome: string,
  eventsPath: string,
  action: (archiveBackup: string) => Promise<void>,
): Promise<void> {
  const backup = await mkdtemp(join(tmpdir(), "soma-event-rollback-"));
  const archive = eventArchiveDir(eventsPath);
  const archiveBackup = join(somaHome, "memory", "STATE", `.events-archive-rollback-${crypto.randomUUID()}`);
  const index = eventIndexPath(eventsPath);
  const hadLive = await pathExists(eventsPath);
  const hadIndex = await pathExists(index);
  const hadArchive = await pathExists(archive);
  let archiveMoved = false;
  let operationError: unknown;
  let operationFailed = false;
  const restorationFailures: unknown[] = [];
  try {
    if (hadLive) await copyFile(eventsPath, join(backup, "events.jsonl"));
    if (hadIndex) await copyFile(index, join(backup, "events-index.json"));
    if (hadArchive) { await rename(archive, archiveBackup); archiveMoved = true; }
    await action(archiveBackup);
  } catch (error) { operationError = error; operationFailed = true; }
  finally {
    const attempt = async (restore: () => Promise<void>): Promise<void> => { try { await restore(); } catch (error) { restorationFailures.push(error); } };
    await attempt(async () => {
      if (archiveMoved || !hadArchive) await rm(archive, { recursive: true, force: true });
      if (archiveMoved) { await rename(archiveBackup, archive); archiveMoved = false; }
    });
    await attempt(() => restoreProtectedPath(join(backup, "events.jsonl"), eventsPath, hadLive, backup));
    await attempt(() => restoreProtectedPath(join(backup, "events-index.json"), index, hadIndex, backup));
    if (restorationFailures.length === 0) await rm(backup, { recursive: true, force: true });
  }
  if (restorationFailures.length > 0) throw new AggregateError(operationFailed ? [operationError, ...restorationFailures] : restorationFailures, `Rollback event restoration failed; backup retained at ${backup}`);
  if (operationFailed) throw operationError;
}

export async function rollbackSomaSnapshot(options: SomaSnapshotRollbackOptions): Promise<SomaSnapshotRollbackResult> {
  const somaHome = resolveSomaHome(options);
  assertSafeRevision(options.snapshot);
  if (!(await pathExists(join(somaHome, ".git")))) {
    throw new Error("No Soma snapshot repository exists. Create a snapshot first.");
  }
  const rev = `${options.snapshot}^{commit}`;
  const id = runGit(somaHome, ["rev-parse", "--verify", rev]).stdout.trim();
  const subject = runGit(somaHome, ["show", "-s", "--format=%s", id]).stdout.trim();
  if (!subject.startsWith("soma snapshot: ")) {
    throw new Error(`Refusing to rollback to non-snapshot commit: ${options.snapshot}`);
  }
  const eventsPath = createPaths(somaHome).events();
  await withEventLogLock(eventsPath, async () => {
    await recoverPendingEventRotation(eventsPath);
    await waitForEventReaders(eventsPath);
    await withPreservedEventHistory(somaHome, eventsPath, async (archiveBackup) => {
      runGit(somaHome, ["reset", "--hard", id]);
      const metadata = await readSnapshotMetadata(somaHome);
      runGit(somaHome, ["clean", "-ffd", ...PROTECTED_EVENT_PATHS.flatMap((path) => ["-e", path]), "-e", relative(somaHome, archiveBackup)]);
      await removeIgnoredAdditions(somaHome, [
        ...metadata.ignoredPaths,
        ...PROTECTED_EVENT_PATHS,
        `${relative(somaHome, archiveBackup)}/`,
        "memory/STATE/events-snapshots/",
      ]);
    });
    await ensureSnapshotGitignore(somaHome);
    untrackEventFiles(somaHome);
  });
  return {
    somaHome,
    id,
    name: subject.replace(/^soma snapshot:\s*/, ""),
  };
}
