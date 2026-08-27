import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface RuntimeArtifactState {
  active: string;
  previous?: string;
}

export const GUARDED_RUNTIME_SUBSTRATES = ["claude-code", "codex", "grok"] as const;
export type GuardedRuntimeSubstrate = (typeof GUARDED_RUNTIME_SUBSTRATES)[number];
export function isGuardedRuntimeSubstrate(substrate: string): substrate is GuardedRuntimeSubstrate {
  return (GUARDED_RUNTIME_SUBSTRATES as readonly string[]).includes(substrate);
}

export function runtimeArtifactRoot(somaHome: string): string {
  return resolve(somaHome, "runtime");
}

function runtimeArtifactStoreRoot(somaHome: string): string {
  return join(runtimeArtifactRoot(somaHome), "artifacts");
}

export function runtimeArtifactStatePath(somaHome: string, substrate: GuardedRuntimeSubstrate): string {
  return join(runtimeArtifactRoot(somaHome), substrate, "active.json");
}

/** Stable, substrate-scoped hook target; it atomically resolves to a read-only deployment snapshot. */
export function runtimeArtifactActivePath(somaHome: string, substrate: GuardedRuntimeSubstrate): string {
  return join(runtimeArtifactRoot(somaHome), substrate, "current");
}

async function assertArtifactTargetRoot(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`runtime artifact target must be a non-symlink directory: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function activateRuntimeArtifact(somaHome: string, substrate: GuardedRuntimeSubstrate, hash: string): Promise<void> {
  const lifecycleRoot = dirname(runtimeArtifactActivePath(somaHome, substrate));
  const target = join(runtimeArtifactStoreRoot(somaHome), hash);
  if (!(await assertArtifactTargetRoot(target))) throw new Error(`runtime artifact target is missing: ${target}`);
  await stat(join(target, "src", "cli.ts"));
  await mkdir(lifecycleRoot, { recursive: true });
  const pending = join(lifecycleRoot, ".current-next");
  await rm(pending, { force: true });
  await symlink(join("..", "artifacts", hash), pending);
  await rename(pending, runtimeArtifactActivePath(somaHome, substrate));
}

async function makeWritable(path: string): Promise<void> {
  await chmod(path, 0o755).catch(() => undefined);
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await makeWritable(child);
    else if (entry.isFile()) await chmod(child, 0o644).catch(() => undefined);
  }
}

async function loadArtifact(entry: string): Promise<boolean> {
  // Bun cannot reliably import an entry below a home path containing shell
  // metacharacters. Copy the complete minimal runtime into an OS-temp directory
  // with a generated safe name, then load that copy.
  const artifactRoot = dirname(dirname(entry));
  const probeRoot = await mkdtemp(join(tmpdir(), "soma-runtime-probe-"));
  try {
    await cp(join(artifactRoot, "src"), join(probeRoot, "src"), { recursive: true });
    await cp(join(artifactRoot, "package.json"), join(probeRoot, "package.json"));
    const result = spawnSync(process.execPath, [join(probeRoot, "src", "cli.ts"), "--version"], {
      cwd: probeRoot,
      encoding: "utf8",
    });
    return result.status === 0;
  } finally {
    // Copies preserve the artifact's read-only modes; reopen only this disposable
    // probe tree so nested source directories never obstruct cleanup.
    await makeWritable(probeRoot);
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function writeRuntimeArtifactState(somaHome: string, substrate: GuardedRuntimeSubstrate, state: RuntimeArtifactState): Promise<void> {
  const statePath = runtimeArtifactStatePath(somaHome, substrate);
  await mkdir(dirname(statePath), { recursive: true });
  const pending = statePath + ".tmp";
  await writeFile(pending, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(pending, statePath);
}

async function sealArtifact(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await sealArtifact(path);
      await chmod(path, 0o555);
    } else if (entry.isFile()) {
      await chmod(path, 0o444);
    }
  }
  await chmod(root, 0o555);
}

/** Refuse links and special files before hashing or copying an enforcement runtime. */
async function assertRuntimeSourceTree(sourceRoot: string): Promise<void> {
  const srcPath = join(sourceRoot, "src");
  const srcStat = await lstat(srcPath);
  if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
    throw new Error("runtime artifact source src must be a non-symlink directory");
  }
  const packagePath = join(sourceRoot, "package.json");
  const packageStat = await lstat(packagePath);
  if (packageStat.isSymbolicLink() || !packageStat.isFile()) {
    throw new Error("runtime artifact source package.json must be a regular file");
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`runtime artifact source contains symlink: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (!entry.isFile()) throw new Error(`runtime artifact source contains unsupported entry: ${path}`);
    }
  }
  await visit(join(sourceRoot, "src"));
}

async function sourceHash(sourceRoot: string): Promise<string> {
  await assertRuntimeSourceTree(sourceRoot);
  const hash = createHash("sha256");
  const frame = (type: string, path: string, bytes: Uint8Array = new Uint8Array()): void => {
    hash.update(`${type.length}:${type}${path.length}:${path}${bytes.byteLength}:`, "utf8");
    hash.update(bytes);
  };
  async function visit(directory: string, relative: string): Promise<void> {
    frame("dir", relative);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path, child);
      else if (entry.isFile()) frame("file", child, await readFile(path));
      else throw new Error(`runtime artifact source contains unsupported entry: ${path}`);
    }
  }
  await visit(join(sourceRoot, "src"), "src");
  frame("file", "package.json", await readFile(join(sourceRoot, "package.json")));
  return hash.digest("hex");
}

export async function readRuntimeArtifactState(somaHome: string, substrate: GuardedRuntimeSubstrate): Promise<RuntimeArtifactState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(runtimeArtifactStatePath(somaHome, substrate), "utf8"));
    if (!value || typeof value !== "object" || typeof (value as { active?: unknown }).active !== "string") return undefined;
    const state = value as { active: string; previous?: unknown };
    return { active: state.active, ...(typeof state.previous === "string" ? { previous: state.previous } : {}) };
  } catch { return undefined; }
}
/** Keep only artifacts referenced by any guarded substrate's active or predecessor state. */
async function pruneUnreferencedArtifacts(somaHome: string): Promise<void> {
  const store = runtimeArtifactStoreRoot(somaHome);
  const retained = new Set<string>();
  for (const substrate of GUARDED_RUNTIME_SUBSTRATES) {
    const state = await readRuntimeArtifactState(somaHome, substrate);
    if (state !== undefined) {
      retained.add(state.active);
      if (state.previous !== undefined) retained.add(state.previous);
    }
  }
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || retained.has(entry.name)) continue;
    const path = join(store, entry.name);
    // Never traverse a link while pruning; remove the directory entry itself.
    if (entry.isSymbolicLink()) {
      await rm(path, { force: true });
    } else if (entry.isDirectory()) {
      await makeWritable(path);
      await rm(path, { recursive: true, force: true });
    }
  }
}

/** Stages a source-complete, content-addressed policy runtime and atomically activates one substrate. */
export async function stageRuntimeArtifact(input: { somaHome: string; substrate: GuardedRuntimeSubstrate; sourceRoot: string }): Promise<{ path: string; hash: string; previous?: string }> {
  const hash = await sourceHash(input.sourceRoot);
  const store = runtimeArtifactStoreRoot(input.somaHome);
  const target = join(store, hash);
  await mkdir(store, { recursive: true });
  // Only installation mutates the shared artifact store. Hooks never hash it.
  await chmod(store, 0o755);
  try {
    const targetExists = await assertArtifactTargetRoot(target);
    const existingHash = targetExists ? await sourceHash(target).catch(() => undefined) : undefined;
    if (existingHash !== hash) {
      const staging = join(store, ".staging-" + hash);
      const displaced = join(store, ".replaced-" + hash);
      await rm(staging, { recursive: true, force: true });
      await rm(displaced, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      await cp(join(input.sourceRoot, "src"), join(staging, "src"), { recursive: true });
      await cp(join(input.sourceRoot, "package.json"), join(staging, "package.json"));
      if (await sourceHash(staging) !== hash) throw new Error("runtime artifact staging hash mismatch");
      if (!(await loadArtifact(join(staging, "src", "cli.ts")))) throw new Error("runtime artifact load check failed");
      await sealArtifact(staging);
      if (targetExists) await rename(target, displaced);
      try {
        await rename(staging, target);
      } catch (error) {
        if (targetExists) await rename(displaced, target).catch(() => undefined);
        throw error;
      }
      await rm(displaced, { recursive: true, force: true });
    }
    const current = await readRuntimeArtifactState(input.somaHome, input.substrate);
    const state: RuntimeArtifactState = { active: hash, ...(current?.active !== hash ? { previous: current?.active } : current?.previous ? { previous: current.previous } : {}) };
    await activateRuntimeArtifact(input.somaHome, input.substrate, hash);
    await writeRuntimeArtifactState(input.somaHome, input.substrate, state);
    await pruneUnreferencedArtifacts(input.somaHome);
    return { path: runtimeArtifactActivePath(input.somaHome, input.substrate), hash, ...(state.previous ? { previous: state.previous } : {}) };
  } finally {
    // Artifact directories are read-only deployment snapshots between installs.
    // Same-UID filesystem permissions are best-effort hardening, not a
    // tamper-proof boundary; W1 intentionally does not hash on every hook invocation.
    await chmod(store, 0o555).catch(() => undefined);
  }
}

/** Explicit local recovery inspection; it never fetches or rebuilds an artifact. */
export async function inspectRuntimeArtifact(somaHome: string, substrate: GuardedRuntimeSubstrate): Promise<{ state?: RuntimeArtifactState; status: "missing-state" | "missing-active" | "unloadable" | "ready" }> {
  const state = await readRuntimeArtifactState(somaHome, substrate);
  if (!state) return { status: "missing-state" };
  const entry = join(runtimeArtifactStoreRoot(somaHome), state.active, "src", "cli.ts");
  const activeEntry = join(runtimeArtifactActivePath(somaHome, substrate), "src", "cli.ts");
  try {
    await readFile(join(runtimeArtifactStoreRoot(somaHome), state.active, "package.json"), "utf8");
    const expectedPath = await realpath(entry);
    const activePath = await realpath(activeEntry);
    if (expectedPath !== activePath) return { state, status: "missing-active" };
    if (!(await isValidArtifact(join(runtimeArtifactStoreRoot(somaHome), state.active), state.active))) return { state, status: "unloadable" };
  } catch {
    return { state, status: "missing-active" };
  }
  return { state, status: "ready" };
}

async function isValidArtifact(root: string, expectedHash: string): Promise<boolean> {
  try {
    return await sourceHash(root) === expectedHash && await loadArtifact(join(root, "src", "cli.ts"));
  } catch {
    return false;
  }
}

export async function rollbackRuntimeArtifact(somaHome: string, substrate: GuardedRuntimeSubstrate): Promise<RuntimeArtifactState> {
  const current = await readRuntimeArtifactState(somaHome, substrate);
  if (!current?.previous) throw new Error("No previous runtime artifact is available for rollback.");
  const priorRoot = join(runtimeArtifactStoreRoot(somaHome), current.previous);
  if (!(await isValidArtifact(priorRoot, current.previous))) {
    throw new Error("Retained runtime artifact failed integrity or load validation.");
  }
  const next: RuntimeArtifactState = { active: current.previous, previous: current.active };
  await activateRuntimeArtifact(somaHome, substrate, next.active);
  await writeRuntimeArtifactState(somaHome, substrate, next);
  return next;
}
