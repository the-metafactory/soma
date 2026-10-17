import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { assertActiveCliRuntime, inspectRuntimeArtifact, isGuardedRuntimeSubstrate, isRuntimeArtifactTarget, locateRuntimeArtifact, prepareRuntimeSource, readRuntimeArtifactState, rollbackRuntimeArtifact, stageRuntimeArtifact, stageRuntimeArtifacts } from "../../src/substrates/runtime-artifact";
import { runRuntimeCli } from "../../src/cli/runtime";

const roots: string[] = [];
test("CLI is a runtime target, not a substrate", () => {
  expect(isRuntimeArtifactTarget("cli")).toBe(true);
  expect(isGuardedRuntimeSubstrate("cli")).toBe(false);
});
async function makeWritable(path: string): Promise<void> {
  await chmod(path, 0o755).catch(() => undefined);
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await makeWritable(child);
    else await chmod(child, 0o644).catch(() => undefined);
  }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(async root => { await makeWritable(root); await rm(root, { recursive: true, force: true }); })); });
async function fixture(): Promise<{ root: string; source: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "soma-runtime-artifact-")); roots.push(root);
  const source = join(root, "source"); const home = join(root, "home");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = true;\n");
  await writeFile(join(source, "package.json"), "{}\n");
  return { root, source, home };
}
test("refuses a symlinked runtime src root before hashing or staging", async () => {
  const { root, source, home } = await fixture();
  const outside = join(root, "outside-src");
  await mkdir(outside);
  await rm(join(source, "src"), { recursive: true });
  await symlink(outside, join(source, "src"));
  await expect(stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source })).rejects.toThrow(/src must be a non-symlink directory/);
});

test("refuses a symlink in the runtime source tree before hashing or staging", async () => {
  const { root, source, home } = await fixture();
  const outside = join(root, "outside.ts");
  await writeFile(outside, "export const escaped = true;\n");
  await symlink(outside, join(source, "src", "escaped.ts"));
  await expect(stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source })).rejects.toThrow(/symlink/);
  await expect(stat(join(home, "runtime"))).rejects.toThrow();
});

test("refuses a symlinked runtime package manifest before hashing or staging", async () => {
  const { root, source, home } = await fixture();
  const outside = join(root, "outside-package.json");
  await writeFile(outside, "{}\n");
  await rm(join(source, "package.json"));
  await symlink(outside, join(source, "package.json"));
  await expect(stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source })).rejects.toThrow(/package.json must be a regular file/);
});

test("framed runtime manifest distinguishes ambiguous path layouts", async () => {
  const left = await fixture();
  const right = await fixture();
  await mkdir(join(left.source, "src", "a"));
  await writeFile(join(left.source, "src", "a", "bc"), "same");
  await mkdir(join(right.source, "src", "ab"));
  await writeFile(join(right.source, "src", "ab", "c"), "same");
  const first = await stageRuntimeArtifact({ somaHome: left.home, target: "codex", sourceRoot: left.source });
  const second = await stageRuntimeArtifact({ somaHome: right.home, target: "codex", sourceRoot: right.source });
  expect(first.hash).not.toBe(second.hash);
});


test("stages an immutable source-complete artifact and atomically activates it", async () => {
  const { source, home } = await fixture();
  const staged = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  expect(await readFile(join(staged.path, "src", "cli.ts"), "utf8")).toContain("cli = true");
  expect((await readRuntimeArtifactState(home, "codex"))?.active).toBe(staged.hash);
  expect(await readFile(join(home, "runtime/codex/current/src/cli.ts"), "utf8")).toContain("cli = true");
});

test("graph close accepts only the active hash-checked CLI module", async () => {
  const { source, home } = await fixture();
  await mkdir(join(source, "src", "cli"));
  await writeFile(join(source, "src", "cli", "graph.ts"), "export const graph = true;\n");
  const staged = await stageRuntimeArtifact({ somaHome: home, target: "cli", sourceRoot: source });
  const activeModule = pathToFileURL(join(staged.path, "src", "cli", "graph.ts")).href;
  const sourceModule = pathToFileURL(join(source, "src", "cli", "graph.ts")).href;
  expect(await assertActiveCliRuntime(home, activeModule)).toBe(staged.hash);
  await expect(assertActiveCliRuntime(home, sourceModule)).rejects.toThrow(/source checkout/);
  await makeWritable(staged.path);
  await writeFile(join(staged.path, "src", "cli", "graph.ts"), "export const graph = false;\n");
  expect((await locateRuntimeArtifact(home, "cli")).status).toBe("ready");
  await expect(assertActiveCliRuntime(home, activeModule)).rejects.toThrow(/valid installed CLI runtime required/);
});
test("retains and explicitly rolls back the selected substrate predecessor", async () => {
  const { source, home } = await fixture();
  const first = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = false;\n");
  const second = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  expect(second.previous).toBe(first.hash);
  expect((await rollbackRuntimeArtifact(home, "codex")).active).toBe(first.hash);
  expect(await runRuntimeCli({ command: "runtime", action: "rollback", target: "codex", somaHome: home })).toContain(second.hash);
});
test("keeps guarded substrate activations independent", async () => {
  const { source, home } = await fixture();
  const codex = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = false;\n");
  const claude = await stageRuntimeArtifact({ somaHome: home, target: "claude-code", sourceRoot: source });
  expect(await readFile(join(home, "runtime/codex/current/src/cli.ts"), "utf8")).toContain("cli = true");
  expect(await readFile(join(home, "runtime/claude-code/current/src/cli.ts"), "utf8")).toContain("cli = false");
  expect((await readRuntimeArtifactState(home, "codex"))?.active).toBe(codex.hash);
  expect((await readRuntimeArtifactState(home, "claude-code"))?.active).toBe(claude.hash);
  await expect(rollbackRuntimeArtifact(home, "claude-code")).rejects.toThrow("No previous runtime artifact");
  expect((await readRuntimeArtifactState(home, "codex"))?.active).toBe(codex.hash);
});
test("one staging activates several targets, each keeping its own predecessor (node #929)", async () => {
  const { source, home } = await fixture();
  const first = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = false;\n");
  const [cli, codex] = await stageRuntimeArtifacts({ somaHome: home, targets: ["cli", "codex"], source: await prepareRuntimeSource(source) });
  expect(cli.hash).toBe(codex.hash);
  expect(cli.hash).not.toBe(first.hash);
  expect(cli.previous).toBeUndefined();
  expect(codex.previous).toBe(first.hash);
  expect(await readFile(join(home, "runtime/cli/current/src/cli.ts"), "utf8")).toContain("cli = false");
  expect(await readFile(join(home, "runtime/codex/current/src/cli.ts"), "utf8")).toContain("cli = false");
  // Codex's predecessor stays retained alongside the new artifact.
  expect((await readdir(join(home, "runtime/artifacts"))).filter((name) => !name.startsWith(".")).sort()).toEqual([first.hash, cli.hash].sort());
});
test("a prepared source that changed before staging fails the staging hash check", async () => {
  const { source, home } = await fixture();
  const prepared = await prepareRuntimeSource(source);
  await writeFile(join(source, "src", "cli.ts"), "export const cli = false;\n");
  await expect(stageRuntimeArtifacts({ somaHome: home, targets: ["codex"], source: prepared })).rejects.toThrow("runtime artifact staging hash mismatch");
  expect(await readRuntimeArtifactState(home, "codex")).toBeUndefined();
});
test("reports missing and unloadable active artifacts", async () => {
  const { source, home } = await fixture();
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("missing-state");
  const staged = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await makeWritable(staged.path);
  await writeFile(join(staged.path, "src", "cli.ts"), "this is not valid TypeScript");
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("unloadable");
});
test("detects and replaces valid-TypeScript artifact tampering", async () => {
  const { source, home } = await fixture();
  const staged = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await makeWritable(staged.path);
  await writeFile(join(staged.path, "src", "cli.ts"), "export const cli = false;\n");
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("unloadable");
  const restored = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  expect(restored.hash).toBe(staged.hash);
  expect(await readFile(join(restored.path, "src", "cli.ts"), "utf8")).toContain("cli = true");
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("ready");
});
test("replaces an incomplete existing target on reinstall", async () => {
  const { source, home } = await fixture();
  const staged = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await makeWritable(staged.path);
  await rm(join(staged.path, "package.json"));
  const restored = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  expect(restored.hash).toBe(staged.hash);
  expect(await readFile(join(restored.path, "package.json"), "utf8")).toBe("{}\n");
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("ready");
});
test("seals payload files read-only and keeps directories writable", async () => {
  const { source, home } = await fixture();
  await mkdir(join(source, "src", "nested"), { recursive: true });
  await writeFile(join(source, "src", "nested", "extra.ts"), "export const nested = true;\n");
  const staged = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  // Payload files are read-only; directories stay writable so cleanup and atomic
  // replacement work. Same-UID permissions are detection, not prevention.
  for (const path of [join(staged.path, "src", "cli.ts"), join(staged.path, "package.json")]) {
    expect((await stat(path)).mode & 0o222).toBe(0);
  }
  for (const path of [staged.path, join(staged.path, "src"), join(staged.path, "src", "nested")]) {
    expect((await stat(path)).mode & 0o200).not.toBe(0);
  }
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("ready");
});
test("refuses rollback to a corrupted predecessor and preserves the current pointer", async () => {
  const { source, home } = await fixture();
  const first = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = false;\n");
  const second = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await makeWritable(join(home, "runtime", "artifacts", first.hash));
  await writeFile(join(home, "runtime", "artifacts", first.hash, "src", "cli.ts"), "export const cli = 'tampered';\n");
  const before = await readRuntimeArtifactState(home, "codex");
  const current = await readFile(join(home, "runtime/codex/current/src/cli.ts"), "utf8");
  await expect(rollbackRuntimeArtifact(home, "codex")).rejects.toThrow("integrity or load validation");
  expect(await readRuntimeArtifactState(home, "codex")).toEqual(before);
  expect((await readRuntimeArtifactState(home, "codex"))?.active).toBe(second.hash);
  expect(await readFile(join(home, "runtime/codex/current/src/cli.ts"), "utf8")).toBe(current);
});

test("prunes artifacts unreferenced by every guarded substrate state", async () => {
  const { source, home } = await fixture();
  const first = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = 'second';\n");
  const second = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = 'third';\n");
  const third = await stageRuntimeArtifact({ somaHome: home, target: "codex", sourceRoot: source });
  const hashes = (await readdir(join(home, "runtime", "artifacts"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  expect(hashes).toEqual([second.hash, third.hash].sort());
  await expect(stat(join(home, "runtime", "artifacts", first.hash))).rejects.toThrow();
});

// node #866: the artifact carries the production dependency closure.
async function writePackage(dir: string, manifest: Record<string, unknown>, body = "export const ok = true;\n"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest) + "\n");
  await writeFile(join(dir, "index.js"), body);
}
async function dependencyFixture(): Promise<{ root: string; source: string; home: string }> {
  const { root, source, home } = await fixture();
  const modules = join(source, "node_modules");
  await writeFile(join(source, "package.json"), JSON.stringify({
    dependencies: { "dep-a": "1.0.0", "@scope/dep-c": "1.0.0" },
    optionalDependencies: { "absent-optional": "1.0.0" },
    devDependencies: { "dev-only": "1.0.0" },
  }) + "\n");
  await writePackage(join(modules, "dep-a"), { name: "dep-a", dependencies: { "dep-b": "2.0.0" }, peerDependencies: { "dep-peer": "*" } }, 'import "dep-b";\nexport const ok = "dep-a with nested dep-b";\n');
  await writePackage(join(modules, "dep-a", "node_modules", "dep-b"), { name: "dep-b" });
  await writePackage(join(modules, "@scope", "dep-c"), { name: "@scope/dep-c" });
  await writePackage(join(modules, "dev-only"), { name: "dev-only" });
  await mkdir(join(modules, ".bin"));
  await symlink(join(modules, "dev-only", "index.js"), join(modules, ".bin", "dev-only"));
  await symlink(join(modules, "dep-a", "index.js"), join(modules, "dep-a", "shim"));
  await writeFile(join(source, "src", "cli.ts"), 'import { ok } from "dep-a";\nimport "@scope/dep-c";\nconsole.log(ok);\n');
  return { root, source, home };
}
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

test("carries the production dependency closure and leaves dev-only packages, links and bin shims behind", async () => {
  const { source, home } = await dependencyFixture();
  const staged = await stageRuntimeArtifact({ somaHome: home, target: "cli", sourceRoot: source });
  const modules = join(staged.path, "node_modules");
  for (const carried of ["dep-a/package.json", "dep-a/node_modules/dep-b/index.js", "@scope/dep-c/index.js"]) {
    expect(await exists(join(modules, carried))).toBe(true);
  }
  for (const left of ["dev-only", ".bin", "dep-a/shim", "absent-optional"]) {
    expect(await exists(join(modules, left))).toBe(false);
  }
  expect((await stat(join(modules, "dep-a", "index.js"))).mode & 0o222).toBe(0);
  // Resolution happens inside the artifact: no auto-install, no network.
  const run = spawnSync(process.execPath, ["--no-install", join(staged.path, "src", "cli.ts")], { cwd: tmpdir(), encoding: "utf8" });
  expect(run.status).toBe(0);
  expect(run.stdout.trim()).toBe("dep-a with nested dep-b");
  expect((await inspectRuntimeArtifact(home, "cli")).status).toBe("ready");
});

test("hash follows the dependency content and stays put for an unchanged checkout", async () => {
  const { source, home } = await dependencyFixture();
  const first = await stageRuntimeArtifact({ somaHome: home, target: "cli", sourceRoot: source });
  const again = await stageRuntimeArtifact({ somaHome: home, target: "cli", sourceRoot: source });
  expect(again.hash).toBe(first.hash);
  expect(again.previous).toBeUndefined();
  await writeFile(join(source, "node_modules", "dep-a", "node_modules", "dep-b", "index.js"), "export const ok = 'patched';\n");
  const changed = await stageRuntimeArtifact({ somaHome: home, target: "cli", sourceRoot: source });
  expect(changed.hash).not.toBe(first.hash);
  expect(changed.previous).toBe(first.hash);
});

test("refuses a checkout whose production dependency is not installed, naming it and its dependent", async () => {
  const { source, home } = await dependencyFixture();
  await rm(join(source, "node_modules", "dep-a", "node_modules", "dep-b"), { recursive: true });
  await expect(stageRuntimeArtifact({ somaHome: home, target: "cli", sourceRoot: source })).rejects.toThrow(/missing runtime dependency dep-b \(required by dep-a\)/);
  await rm(join(source, "node_modules", "@scope"), { recursive: true });
  await expect(stageRuntimeArtifact({ somaHome: home, target: "cli", sourceRoot: source })).rejects.toThrow(/missing runtime dependency @scope\/dep-c \(required by package.json\)/);
  await expect(stat(join(home, "runtime"))).rejects.toThrow();
});

test("reports a dependency missing from the active artifact by name", async () => {
  const { source, home } = await dependencyFixture();
  const staged = await stageRuntimeArtifact({ somaHome: home, target: "cli", sourceRoot: source });
  await makeWritable(staged.path);
  await rm(join(staged.path, "node_modules", "dep-a", "node_modules", "dep-b"), { recursive: true });
  const inspected = await inspectRuntimeArtifact(home, "cli", { load: false });
  expect(inspected.status).toBe("unloadable");
  expect(inspected.detail).toMatch(/missing runtime dependency dep-b \(required by dep-a\)/);
  expect(await runRuntimeCli({ command: "runtime", action: "status", target: "cli", somaHome: home })).toContain("missing runtime dependency dep-b");
  const sourceModule = pathToFileURL(join(source, "src", "cli", "graph.ts")).href;
  await expect(assertActiveCliRuntime(home, sourceModule)).rejects.toThrow(/unloadable: missing runtime dependency dep-b/);
});

test("an artifact built from this checkout resolves myelin and its outbox with no auto-install, and its run-ledger emit passes the load stage", async () => {
  const checkout = resolve(import.meta.dir, "..", "..");
  const root = await mkdtemp(join(tmpdir(), "soma-runtime-artifact-checkout-")); roots.push(root);
  const home = join(root, "home");
  const staged = await stageRuntimeArtifact({ somaHome: home, target: "cli", sourceRoot: checkout });
  const artifact = join(home, "runtime", "artifacts", staged.hash);
  expect(await exists(join(artifact, "node_modules", "@the-metafactory", "myelin", "package.json"))).toBe(true);
  expect(await exists(join(artifact, "node_modules", "typescript"))).toBe(false);

  const script = [
    `const root = ${JSON.stringify(artifact)};`,
    'const myelin = await import(Bun.resolveSync("@the-metafactory/myelin", root));',
    'const outbox = await import(Bun.resolveSync("@the-metafactory/myelin/outbox", root));',
    "console.log(typeof myelin.createEnvelope, typeof outbox.createOutbox);",
  ].join("\n");
  const imported = spawnSync(process.execPath, ["--no-install", "-e", script], { cwd: artifact, encoding: "utf8" });
  expect(imported.stderr).toBe("");
  expect(imported.status).toBe(0);
  expect(imported.stdout.trim()).toBe("function function");

  // The same funnel serves `algorithm advance` and `soma run finished`; aimed at a
  // closed loopback port, the emit must get past `load` and fail at `publish`.
  const principalHome = join(root, "principal");
  await mkdir(principalHome, { recursive: true });
  const emitted = spawnSync(
    process.execPath,
    ["--no-install", join(artifact, "src", "cli.ts"), "run", "finished", "--kind", "job", "--ref", "node-866", "--outcome", "succeeded", "--started-at", "2026-10-01T08:00:00Z"],
    { cwd: artifact, encoding: "utf8", env: { ...process.env, HOME: principalHome, SOMA_PRINCIPAL: "jc", SOMA_NATS_URL: "nats://127.0.0.1:1" } },
  );
  expect(emitted.status).toBe(0);
  const events = (await readFile(join(principalHome, ".soma", "memory", "STATE", "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; metadata?: { stage?: string }; summary?: string });
  const failures = events.filter((event) => event.kind === "run_ledger.publish_failed");
  expect(failures.map((event) => event.metadata?.stage)).toEqual(["publish"]);
}, 120_000);
