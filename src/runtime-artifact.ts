import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface RuntimeArtifactState {
  active: string;
  previous?: string;
}

export function runtimeArtifactRoot(somaHome: string): string {
  return resolve(somaHome, "runtime");
}

export function runtimeArtifactStatePath(somaHome: string): string {
  return join(runtimeArtifactRoot(somaHome), "active.json");
}

/** Stable hook target; it atomically resolves to the selected immutable artifact. */
export function runtimeArtifactActivePath(somaHome: string): string {
  return join(runtimeArtifactRoot(somaHome), "current");
}

async function activateRuntimeArtifact(somaHome: string, hash: string): Promise<void> {
  const root = runtimeArtifactRoot(somaHome);
  const target = join(root, hash);
  await stat(join(target, "src", "cli.ts"));
  const pending = join(root, ".current-next");
  await rm(pending, { force: true });
  await symlink(hash, pending);
  await rename(pending, runtimeArtifactActivePath(somaHome));
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
    // `cp` preserves read-only artifact modes; reopen the disposable probe copy
    // solely so its temporary directories can be removed.
    await chmod(join(probeRoot, "src"), 0o755).catch(() => undefined);
    await chmod(join(probeRoot, "src", "cli.ts"), 0o644).catch(() => undefined);
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function writeRuntimeArtifactState(somaHome: string, state: RuntimeArtifactState): Promise<void> {
  const statePath = runtimeArtifactStatePath(somaHome);
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
      // Keep directories writable so home cleanup and atomic replacement work;
      // payload files themselves are read-only and hash-validated at install/doctor.
      await chmod(path, 0o755);
    } else if (entry.isFile()) {
      await chmod(path, 0o444);
    }
  }
  await chmod(root, 0o755);
}

async function sourceHash(sourceRoot: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(path.slice(sourceRoot.length));
        hash.update(await readFile(path));
      }
    }
  }
  await visit(join(sourceRoot, "src"));
  hash.update(await readFile(join(sourceRoot, "package.json")));
  return hash.digest("hex");
}

export async function readRuntimeArtifactState(somaHome: string): Promise<RuntimeArtifactState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(runtimeArtifactStatePath(somaHome), "utf8"));
    if (!value || typeof value !== "object" || typeof (value as { active?: unknown }).active !== "string") return undefined;
    const state = value as { active: string; previous?: unknown };
    return { active: state.active, ...(typeof state.previous === "string" ? { previous: state.previous } : {}) };
  } catch { return undefined; }
}

/** Stages a source-complete, content-addressed policy runtime and atomically activates it. */
export async function stageRuntimeArtifact(input: { somaHome: string; sourceRoot: string; afterCopy?: (staging: string) => Promise<void> }): Promise<{ path: string; hash: string; previous?: string }> {
  const hash = await sourceHash(input.sourceRoot);
  const root = runtimeArtifactRoot(input.somaHome);
  const target = join(root, hash);
  const existingHash = await sourceHash(target).catch(() => undefined);
  if (existingHash !== hash) {
    const staging = join(root, ".staging-" + hash);
    const displaced = join(root, ".replaced-" + hash);
    const targetExists = await stat(target).then(() => true).catch(() => false);
    await rm(staging, { recursive: true, force: true });
    await rm(displaced, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await cp(join(input.sourceRoot, "src"), join(staging, "src"), { recursive: true });
    await cp(join(input.sourceRoot, "package.json"), join(staging, "package.json"));
    await input.afterCopy?.(staging);
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
  const current = await readRuntimeArtifactState(input.somaHome);
  const state: RuntimeArtifactState = { active: hash, ...(current?.active !== hash ? { previous: current?.active } : current?.previous ? { previous: current.previous } : {}) };
  await activateRuntimeArtifact(input.somaHome, hash);
  await writeRuntimeArtifactState(input.somaHome, state);
  return { path: runtimeArtifactActivePath(input.somaHome), hash, ...(state.previous ? { previous: state.previous } : {}) };
}

/** Explicit local recovery switch; it never fetches or rebuilds an artifact. */
export async function inspectRuntimeArtifact(somaHome: string): Promise<{ state?: RuntimeArtifactState; status: "missing-state" | "missing-active" | "unloadable" | "ready" }> {
  const state = await readRuntimeArtifactState(somaHome);
  if (!state) return { status: "missing-state" };
  const entry = join(runtimeArtifactRoot(somaHome), state.active, "src", "cli.ts");
  const activeEntry = join(runtimeArtifactActivePath(somaHome), "src", "cli.ts");
  try {
    await readFile(join(runtimeArtifactRoot(somaHome), state.active, "package.json"), "utf8");
    const expectedPath = await realpath(entry);
    const activePath = await realpath(activeEntry);
    if (expectedPath !== activePath) return { state, status: "missing-active" };
    // Doctor hashes on demand; guarded hooks never hash on the tool-call path.
    if (await sourceHash(join(runtimeArtifactRoot(somaHome), state.active)) !== state.active) return { state, status: "unloadable" };
    if (!(await loadArtifact(entry))) return { state, status: "unloadable" };
  } catch {
    return { state, status: "missing-active" };
  }
  return { state, status: "ready" };
}

export async function rollbackRuntimeArtifact(somaHome: string): Promise<RuntimeArtifactState> {
  const current = await readRuntimeArtifactState(somaHome);
  if (!current?.previous) throw new Error("No previous runtime artifact is available for rollback.");
  const priorRoot = join(runtimeArtifactRoot(somaHome), current.previous);
  const priorPath = join(priorRoot, "src", "cli.ts");
  if (await sourceHash(priorRoot) !== current.previous || !(await loadArtifact(priorPath))) {
    throw new Error("Retained runtime artifact failed integrity or load validation.");
  }
  const next: RuntimeArtifactState = { active: current.previous, previous: current.active };
  await activateRuntimeArtifact(somaHome, next.active);
  await writeRuntimeArtifactState(somaHome, next);
  return next;
}
