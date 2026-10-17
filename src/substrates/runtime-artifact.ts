import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeArtifactState {
  active: string;
  previous?: string;
}

export const GUARDED_RUNTIME_SUBSTRATES = ["claude-code", "codex", "grok"] as const;
export type GuardedRuntimeSubstrate = (typeof GUARDED_RUNTIME_SUBSTRATES)[number];
export const RUNTIME_ARTIFACT_TARGETS = ["cli", ...GUARDED_RUNTIME_SUBSTRATES] as const;
export type RuntimeArtifactTarget = (typeof RUNTIME_ARTIFACT_TARGETS)[number];
export function isRuntimeArtifactTarget(target: string): target is RuntimeArtifactTarget {
  return (RUNTIME_ARTIFACT_TARGETS as readonly string[]).includes(target);
}
export function isGuardedRuntimeSubstrate(substrate: string): substrate is GuardedRuntimeSubstrate {
  return (GUARDED_RUNTIME_SUBSTRATES as readonly string[]).includes(substrate);
}

export function runtimeArtifactRoot(somaHome: string): string {
  return resolve(somaHome, "runtime");
}

function runtimeArtifactStoreRoot(somaHome: string): string {
  return join(runtimeArtifactRoot(somaHome), "artifacts");
}

export function runtimeArtifactStatePath(somaHome: string, substrate: RuntimeArtifactTarget): string {
  return join(runtimeArtifactRoot(somaHome), substrate, "active.json");
}

/** Stable, substrate-scoped hook target; it atomically resolves to a read-only deployment snapshot. */
export function runtimeArtifactActivePath(somaHome: string, substrate: RuntimeArtifactTarget): string {
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

async function activateRuntimeArtifact(somaHome: string, substrate: RuntimeArtifactTarget, hash: string): Promise<void> {
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

/** One entry of the runtime payload, relative to the artifact root with `/` separators. */
interface RuntimeFrame { type: "dir" | "file"; path: string }

interface RuntimeDependency { name: string; path: string; dir: string }

interface PackageManifest {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`runtime artifact package manifest is not an object: ${path}`);
  return value;
}

function manifestNames(field: unknown): string[] {
  return field && typeof field === "object" && !Array.isArray(field) ? Object.keys(field) : [];
}

/**
 * The packages a manifest needs at runtime. `dependencies` are required;
 * optional and peer dependencies are carried when the install resolved them
 * and skipped otherwise. devDependencies never travel.
 */
function dependencySpecs(manifest: PackageManifest): { name: string; optional: boolean }[] {
  const specs = new Map<string, boolean>();
  for (const name of manifestNames(manifest.dependencies)) specs.set(name, false);
  for (const name of [...manifestNames(manifest.optionalDependencies), ...manifestNames(manifest.peerDependencies)]) {
    if (!specs.has(name)) specs.set(name, true);
  }
  return [...specs.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, optional]) => ({ name, optional }));
}

/**
 * Node-style package lookup from `fromDir` upward, bounded by `root`: a
 * dependency that only resolves above the root is not part of the artifact.
 * Hoisted and nested `node_modules` layouts both resolve; a symlinked package
 * (an isolated-linker install) is refused because the artifact carries no links.
 */
async function resolvePackageDir(root: string, fromDir: string, name: string): Promise<string | undefined> {
  let dir = fromDir;
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", ...name.split("/"));
      const info = await lstat(candidate).catch(() => undefined);
      if (info?.isSymbolicLink()) throw new Error(`runtime artifact dependency is a symlink (isolated installs are not supported): ${candidate}`);
      if (info?.isDirectory() && (await lstat(join(candidate, "package.json")).catch(() => undefined))?.isFile()) return candidate;
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The production dependency closure below `root`, in deterministic path order. */
async function collectRuntimeDependencies(root: string): Promise<RuntimeDependency[]> {
  const found = new Map<string, RuntimeDependency>();
  const queue: { dir: string; label: string }[] = [{ dir: root, label: "package.json" }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const manifest = await readPackageManifest(join(next.dir, "package.json"));
    for (const spec of dependencySpecs(manifest)) {
      const dir = await resolvePackageDir(root, next.dir, spec.name);
      if (dir === undefined) {
        if (spec.optional) continue;
        throw new Error(`missing runtime dependency ${spec.name} (required by ${next.label}) under ${root}`);
      }
      const path = relative(root, dir).split(sep).join("/");
      if (found.has(path)) continue;
      found.set(path, { name: spec.name, path, dir });
      queue.push({ dir, label: spec.name });
    }
  }
  return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * The complete runtime payload in deterministic path order: `src/`, the
 * package manifest, then every production dependency package (node #866).
 * `src` rejects links and special files; a dependency package skips them
 * (bin shims and the like are not payload) and never walks a nested
 * `node_modules`, which only enters through resolution.
 */
async function collectRuntimeFrames(sourceRoot: string): Promise<RuntimeFrame[]> {
  const root = resolve(sourceRoot);
  const srcPath = join(root, "src");
  const srcStat = await lstat(srcPath);
  if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
    throw new Error("runtime artifact source src must be a non-symlink directory");
  }
  const packagePath = join(root, "package.json");
  const packageStat = await lstat(packagePath);
  if (packageStat.isSymbolicLink() || !packageStat.isFile()) {
    throw new Error("runtime artifact source package.json must be a regular file");
  }
  const frames: RuntimeFrame[] = [];
  async function visit(directory: string, relativePath: string, strict: boolean): Promise<void> {
    frames.push({ type: "dir", path: relativePath });
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const child = `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!strict && entry.name === "node_modules") continue;
        await visit(path, child, strict);
      } else if (entry.isFile()) frames.push({ type: "file", path: child });
      else if (!strict) continue;
      else if (entry.isSymbolicLink()) throw new Error(`runtime artifact source contains symlink: ${path}`);
      else throw new Error(`runtime artifact source contains unsupported entry: ${path}`);
    }
  }
  await visit(srcPath, "src", true);
  frames.push({ type: "file", path: "package.json" });
  for (const dependency of await collectRuntimeDependencies(root)) await visit(dependency.dir, dependency.path, false);
  return frames;
}

/** Hash the framed payload so that an ambiguous path layout or a changed dependency changes the digest. */
async function hashRuntimeFrames(root: string, frames: readonly RuntimeFrame[]): Promise<string> {
  const hash = createHash("sha256");
  const frame = (type: string, path: string, bytes: Uint8Array = new Uint8Array()): void => {
    hash.update(`${type.length}:${type}${path.length}:${path}${bytes.byteLength}:`, "utf8");
    hash.update(bytes);
  };
  for (let start = 0; start < frames.length; start += 32) {
    const batch = frames.slice(start, start + 32);
    const contents = await Promise.all(batch.map(async (entry) => entry.type === "file" ? await readFile(join(root, ...entry.path.split("/"))) : undefined));
    batch.forEach((entry, index) => { frame(entry.type, entry.path, contents[index]); });
  }
  return hash.digest("hex");
}

/** Hash the complete runtime (source, manifest and carried dependencies) in deterministic path order. */
async function sourceHash(sourceRoot: string): Promise<string> {
  return hashRuntimeFrames(sourceRoot, await collectRuntimeFrames(sourceRoot));
}

/** Replay `frames` from `from` under `to`, cloning file data where the filesystem supports it. */
async function materializeRuntime(from: string, to: string, frames: readonly RuntimeFrame[]): Promise<void> {
  await mkdir(to, { recursive: true });
  for (let start = 0; start < frames.length; start += 32) {
    await Promise.all(frames.slice(start, start + 32).map(async (entry) => {
      const target = join(to, ...entry.path.split("/"));
      if (entry.type === "dir") {
        await mkdir(target, { recursive: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(from, ...entry.path.split("/")), target, fsConstants.COPYFILE_FICLONE);
      }
    }));
  }
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

/**
 * Load check: the CLI entry starts and every production dependency of the
 * manifest resolves from inside the payload. The resolution runs as a preload
 * of the same process, and `--no-install` keeps Bun's auto-install out, so a
 * dependency the artifact does not carry fails here instead of resolving
 * through the network at hook time.
 */
async function loadArtifact(artifactRoot: string): Promise<boolean> {
  // Bun cannot reliably import an entry below a home path containing shell
  // metacharacters. Copy the complete runtime into an OS-temp directory with a
  // generated safe name, then load that copy.
  const frames = await collectRuntimeFrames(artifactRoot);
  const probeRoot = await mkdtemp(join(tmpdir(), "soma-runtime-probe-"));
  try {
    await materializeRuntime(artifactRoot, probeRoot, frames);
    const names = manifestNames((await readPackageManifest(join(probeRoot, "package.json"))).dependencies);
    const preload = join(probeRoot, ".soma-runtime-probe.ts");
    await writeFile(preload, `for (const name of ${JSON.stringify(names)}) Bun.resolveSync(name, ${JSON.stringify(probeRoot)});\n`, "utf8");
    const result = spawnSync(process.execPath, ["--no-install", "--preload", preload, join(probeRoot, "src", "cli.ts"), "--version"], {
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

async function writeRuntimeArtifactState(somaHome: string, substrate: RuntimeArtifactTarget, state: RuntimeArtifactState): Promise<void> {
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
      // Directories stay writable so home cleanup and atomic replacement work;
      // payload files are read-only. Same-UID permissions are best-effort
      // hardening, not a tamper-proof boundary (detection, not prevention).
      await chmod(path, 0o755);
    } else if (entry.isFile()) {
      await chmod(path, 0o444);
    }
  }
  await chmod(root, 0o755);
}

export async function readRuntimeArtifactState(somaHome: string, substrate: RuntimeArtifactTarget): Promise<RuntimeArtifactState | undefined> {
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
  for (const substrate of RUNTIME_ARTIFACT_TARGETS) {
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

/** A runtime source walked and hashed once, so one install can stage every target from it (node #929). */
export interface RuntimeSource {
  readonly root: string;
  readonly frames: readonly RuntimeFrame[];
  readonly hash: string;
}

export async function prepareRuntimeSource(sourceRoot: string): Promise<RuntimeSource> {
  const frames = await collectRuntimeFrames(sourceRoot);
  return { root: sourceRoot, frames, hash: await hashRuntimeFrames(sourceRoot, frames) };
}

export interface StagedRuntimeArtifact { path: string; hash: string; previous?: string }

/** Stages a source-complete, content-addressed policy runtime and atomically activates one substrate. */
export async function stageRuntimeArtifact(input: { somaHome: string; target: RuntimeArtifactTarget; sourceRoot: string }): Promise<StagedRuntimeArtifact> {
  const [staged] = await stageRuntimeArtifacts({ somaHome: input.somaHome, targets: [input.target], source: await prepareRuntimeSource(input.sourceRoot) });
  return staged;
}

/**
 * Verifies or stages `source`'s artifact once, then activates it for each
 * target, returning one result per target in the order given. An existing
 * artifact is reused only when its payload still hashes to the source's hash;
 * anything else is re-staged.
 */
export async function stageRuntimeArtifacts(input: { somaHome: string; targets: readonly RuntimeArtifactTarget[]; source: RuntimeSource }): Promise<StagedRuntimeArtifact[]> {
  const { hash } = input.source;
  const store = runtimeArtifactStoreRoot(input.somaHome);
  const artifactPath = join(store, hash);
  await mkdir(store, { recursive: true });
  // Only installation mutates the shared artifact store. Hooks never hash it.
  await chmod(store, 0o755);
  try {
    const targetExists = await assertArtifactTargetRoot(artifactPath);
    const existingHash = targetExists ? await sourceHash(artifactPath).catch(() => undefined) : undefined;
    if (existingHash !== hash) {
      const staging = join(store, ".staging-" + hash);
      const displaced = join(store, ".replaced-" + hash);
      await rm(staging, { recursive: true, force: true });
      await rm(displaced, { recursive: true, force: true });
      await materializeRuntime(input.source.root, staging, input.source.frames);
      if (await sourceHash(staging) !== hash) throw new Error("runtime artifact staging hash mismatch");
      if (!(await loadArtifact(staging))) throw new Error("runtime artifact load check failed");
      await sealArtifact(staging);
      if (targetExists) await rename(artifactPath, displaced);
      try {
        await rename(staging, artifactPath);
      } catch (error) {
        if (targetExists) await rename(displaced, artifactPath).catch(() => undefined);
        throw error;
      }
      await rm(displaced, { recursive: true, force: true });
    }
    const staged: StagedRuntimeArtifact[] = [];
    for (const target of input.targets) {
      const current = await readRuntimeArtifactState(input.somaHome, target);
      const previous = current?.active === hash ? current.previous : current?.active;
      const state: RuntimeArtifactState = { active: hash, ...(previous ? { previous } : {}) };
      await activateRuntimeArtifact(input.somaHome, target, hash);
      await writeRuntimeArtifactState(input.somaHome, target, state);
      staged.push({ path: runtimeArtifactActivePath(input.somaHome, target), hash, ...(state.previous ? { previous: state.previous } : {}) });
    }
    // Every target's state is written before pruning, so each one's active and
    // predecessor artifacts are retained.
    await pruneUnreferencedArtifacts(input.somaHome);
    return staged;
  } finally {
    // The shared store stays writable between installs; individual payload files
    // are read-only. Same-UID permissions are best-effort hardening, not a
    // tamper-proof boundary; W1 intentionally does not hash on every hook invocation.
    await chmod(store, 0o755).catch(() => undefined);
  }
}

export interface RuntimeArtifactInspection {
  state?: RuntimeArtifactState;
  status: "missing-state" | "missing-active" | "unloadable" | "ready";
  /** Why an active artifact is unloadable: a missing dependency, a hash mismatch or a failed load check. */
  detail?: string;
}

/** Resolve the active artifact without reading its payload; ordinary CLI calls use this fast path. */
export async function locateRuntimeArtifact(somaHome: string, substrate: RuntimeArtifactTarget): Promise<RuntimeArtifactInspection> {
  const state = await readRuntimeArtifactState(somaHome, substrate);
  if (!state) return { status: "missing-state" };
  const entry = join(runtimeArtifactStoreRoot(somaHome), state.active, "src", "cli.ts");
  const activeEntry = join(runtimeArtifactActivePath(somaHome, substrate), "src", "cli.ts");
  try {
    await readFile(join(runtimeArtifactStoreRoot(somaHome), state.active, "package.json"), "utf8");
    const expectedPath = await realpath(entry);
    const activePath = await realpath(activeEntry);
    if (expectedPath !== activePath) return { state, status: "missing-active" };
  } catch {
    return { state, status: "missing-active" };
  }
  return { state, status: "ready" };
}

/** Explicit local recovery inspection; it never fetches or rebuilds an artifact. */
export async function inspectRuntimeArtifact(somaHome: string, substrate: RuntimeArtifactTarget, options: { load?: boolean } = {}): Promise<RuntimeArtifactInspection> {
  const located = await locateRuntimeArtifact(somaHome, substrate);
  if (located.status !== "ready" || !located.state) return located;
  const failure = await validateArtifact(join(runtimeArtifactStoreRoot(somaHome), located.state.active), located.state.active, options.load !== false);
  if (failure !== undefined) return { state: located.state, status: "unloadable", detail: failure };
  return located;
}

/** Bind an intact graph CLI to the active, hash-checked tree at close time.
 * The Arc launcher supplies the external check for PATH invocation. Directly
 * executing already modified code remains outside this entrypoint's trust boundary.
 */
export async function assertActiveCliRuntime(somaHome: string, moduleUrl: string): Promise<string> {
  const inspected = await inspectRuntimeArtifact(somaHome, "cli", { load: false });
  if (inspected.status !== "ready" || !inspected.state) {
    throw new Error(`valid installed CLI runtime required (${inspected.status}${inspected.detail ? `: ${inspected.detail}` : ""})`);
  }
  const expected = await realpath(join(runtimeArtifactActivePath(somaHome, "cli"), "src", "cli", "graph.ts"));
  const actual = await realpath(fileURLToPath(moduleUrl));
  if (actual !== expected) throw new Error("active installed CLI runtime required; source checkout cannot enforce its own close");
  return inspected.state.active;
}

/** The reason an artifact is not valid, or undefined when its hash matches and (when asked) it loads. */
async function validateArtifact(root: string, expectedHash: string, load: boolean): Promise<string | undefined> {
  let hash: string;
  try {
    hash = await sourceHash(root);
  } catch (error) {
    return errorMessage(error);
  }
  if (hash !== expectedHash) return "payload hash does not match the recorded artifact hash";
  if (!load) return undefined;
  try {
    return (await loadArtifact(root)) ? undefined : "load check failed";
  } catch (error) {
    return errorMessage(error);
  }
}

export async function rollbackRuntimeArtifact(somaHome: string, substrate: RuntimeArtifactTarget): Promise<RuntimeArtifactState> {
  const current = await readRuntimeArtifactState(somaHome, substrate);
  if (!current?.previous) throw new Error("No previous runtime artifact is available for rollback.");
  const priorRoot = join(runtimeArtifactStoreRoot(somaHome), current.previous);
  const failure = await validateArtifact(priorRoot, current.previous, true);
  if (failure !== undefined) {
    throw new Error(`Retained runtime artifact failed integrity or load validation: ${failure}`);
  }
  const next: RuntimeArtifactState = { active: current.previous, previous: current.active };
  await activateRuntimeArtifact(somaHome, substrate, next.active);
  await writeRuntimeArtifactState(somaHome, substrate, next);
  return next;
}
