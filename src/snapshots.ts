import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  runGit(somaHome, ["config", "user.name", "Soma Snapshot"]);
  runGit(somaHome, ["config", "user.email", "soma-snapshot@localhost"]);
}

async function ensureSnapshotGitignore(somaHome: string): Promise<void> {
  const gitignorePath = join(somaHome, ".gitignore");
  const current = await readTextIfExists(gitignorePath);
  const lines = current.split(/\r?\n/);
  const additions = [SNAPSHOT_GITIGNORE_HEADER, ...SNAPSHOT_GITIGNORE_RULES]
    .filter((line) => !lines.includes(line));
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

export async function createSomaSnapshot(options: SomaSnapshotOptions = {}): Promise<SomaSnapshotResult> {
  const somaHome = resolveSomaHome(options);
  const name = sanitizeSnapshotLabel(options.name, "manual");
  const trigger = sanitizeSnapshotLabel(options.trigger, "manual");
  const createdAt = new Date().toISOString();

  await ensureSnapshotRepo(somaHome);
  await writeSnapshotMetadata(somaHome);
  runGit(somaHome, ["add", "-A"]);
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
  runGit(somaHome, ["reset", "--hard", id]);
  const metadata = await readSnapshotMetadata(somaHome);
  runGit(somaHome, ["clean", "-ffd"]);
  await removeIgnoredAdditions(somaHome, metadata.ignoredPaths);
  return {
    somaHome,
    id,
    name: subject.replace(/^soma snapshot:\s*/, ""),
  };
}
