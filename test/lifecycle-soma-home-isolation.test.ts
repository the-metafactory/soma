import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, serializeMemoryNote, type SomaMemoryNote } from "../src/index";
import { registerSessionEndTranscriptHandler, runSomaLifecycleSessionEnd, resolveLifecycleHomeDir, SCRATCH_SUBSTRATE_HOME_DIRNAME } from "../src/lifecycle";
import { memoryNotePath, type WritableType } from "../src/memory-write";
import { resolveInstalledLifecycleHomeDir } from "../src/adapters/shared/lifecycle-home-binding";
import { buildCodexHomeProjection, buildGrokHomeProjection, buildPiDevHomeProjection } from "../src/home-projection";
import { portableProjectionInput } from "./fixtures";
import { renderClaudeCodeStatusLineScript } from "../src/adapters/claude-code/hooks";

// node #614: `--soma-home <scratch>` reads as "this invocation is sandboxed", but
// substrate homes used to resolve against `os.homedir()` regardless, so a
// scratch lifecycle run overwrote the operator's live projection. These tests run
// the real CLI in a subprocess with HOME pointed at a fake home, so the "real
// home" is observable without touching the operator's.

const repoRoot = resolve(import.meta.dir, "..");

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "soma-lifecycle-isolation-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => !entry.isDirectory()).map((entry) => join(entry.parentPath, entry.name));
}

// A non-empty memory index is what makes session-start project a substrate
// file at all — with an empty one the reproject no-ops and isolation is untested.
async function seedScratchSomaHome(somaHome: string): Promise<void> {
  await bootstrapSomaHome({ somaHome });
  const n: SomaMemoryNote = {
    id: "isolation-fact",
    type: "semantic",
    created: "2026-07-01",
    last_verified: "2026-07-01",
    valid_until: null,
    provenance: "conversation",
    trust: "principal",
    source_of_truth: null,
    project: null,
    links: [],
    resurface_count: 0,
    body: "the gateway retries thrice",
  };
  const path = memoryNotePath(somaHome, n.type as WritableType, n.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeMemoryNote(n), "utf8");
}

function runLifecycle(fakeHome: string, args: string[], event = "session-start"): void {
  // Bun's own transpiler cache lives under HOME; it is not Soma's write, so keep
  // it out of the fake home rather than filter it from the assertions.
  const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  delete env.SOMA_HOME;
  delete env.SOMA_CLAUDE_TRANSCRIPT_ROOT;
  delete env.SOMA_MEMORY_FORCE_SUBAGENT;
  delete env.SOMA_MEMORY_FORCE_PRIMARY;
  const result = spawnSync(process.execPath, ["src/cli.ts", "lifecycle", event, "--substrate", "claude-code", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`soma lifecycle exited ${result.status}: ${result.stderr}`);
}

test.each(["absolute", "relative"])("lifecycle session-start with %s scratch --soma-home writes nothing outside it", async (pathKind) => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const scratch = join(root, "scratch-soma");
    await mkdir(fakeHome, { recursive: true });
    await seedScratchSomaHome(scratch);

    runLifecycle(fakeHome, ["--soma-home", pathKind === "relative" ? relative(repoRoot, scratch) : scratch]);

    expect(await listFiles(fakeHome)).toEqual([]);
    for (const file of await listFiles(root)) {
      expect(relative(scratch, file).startsWith("..")).toBe(false);
    }
    // The projection still happened — just inside the scratch tree.
    const projected = join(scratch, SCRATCH_SUBSTRATE_HOME_DIRNAME, ".claude", "rules", "soma", "MEMORY.md");
    expect((await stat(projected)).isFile()).toBe(true);
  });
}, 120_000);

test("scratch lifecycle repairs only scratch statuslines and preserves existing live projection bytes and modes", async () => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const scratch = join(root, "scratch-soma");
    await seedScratchSomaHome(scratch);
    const outsideMemory = join(fakeHome, ".claude", "rules", "soma", "MEMORY.md");
    const outsideScript = join(fakeHome, ".claude", "hooks", "soma", "soma-statusline.sh");
    const scratchScript = join(scratch, SCRATCH_SUBSTRATE_HOME_DIRNAME, ".claude", "hooks", "soma", "soma-statusline.sh");
    for (const file of [outsideMemory, outsideScript, scratchScript]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, file === scratchScript ? renderClaudeCodeStatusLineScript(scratch) : "preserve live projection\n");
      await chmod(file, 0o644);
    }
    const outsideBefore = await Promise.all([outsideMemory, outsideScript].map(async (path) => ({
      path,
      content: await readFile(path, "utf8"),
      mode: (await stat(path)).mode,
    })));

    runLifecycle(fakeHome, ["--soma-home", scratch]);

    expect((await listFiles(fakeHome)).sort()).toEqual([outsideMemory, outsideScript].sort());
    for (const before of outsideBefore) {
      expect(await readFile(before.path, "utf8")).toBe(before.content);
      expect((await stat(before.path)).mode).toBe(before.mode);
    }
    // A repair really ran, so routing the repair provider to the live home would
    // fail both the scratch-mode assertion and the unchanged-live-mode assertion.
    expect((await stat(scratchScript)).mode & 0o111).toBe(0o111);
    const events = await readFile(join(scratch, "memory", "STATE", "events.jsonl"), "utf8");
    expect(events).toContain("lifecycle.session_start.projection-repair");
    expect(events).not.toContain("lifecycle.session_start.projection-repair-failed");
  });
}, 120_000);

test.each(["implicit", "explicit"])("lifecycle with the %s default soma home still projects into the real substrate home (live hook contract)", async (pathKind) => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const somaHome = join(fakeHome, ".soma");
    await seedScratchSomaHome(somaHome);

    // A legacy installation explicitly binds the live substrate to this source.
    const configPath = join(fakeHome, ".claude/hooks/soma/soma-claude-code-hook.config.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ somaHome }));
    runLifecycle(fakeHome, pathKind === "explicit" ? ["--soma-home", somaHome] : []);

    const projected = join(fakeHome, ".claude", "rules", "soma", "MEMORY.md");
    expect((await stat(projected)).isFile()).toBe(true);
    await expect(stat(join(somaHome, SCRATCH_SUBSTRATE_HOME_DIRNAME))).rejects.toThrow();
  });
}, 120_000);

test("an explicit --home-dir wins over the derived scratch substrate home", async () => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const target = join(root, "target-home");
    const scratch = join(root, "scratch-soma");
    await mkdir(fakeHome, { recursive: true });
    await seedScratchSomaHome(scratch);

    runLifecycle(fakeHome, ["--soma-home", scratch, "--home-dir", target]);

    expect(await listFiles(fakeHome)).toEqual([]);
    const projected = join(target, ".claude", "rules", "soma", "MEMORY.md");
    expect((await stat(projected)).isFile()).toBe(true);
  });
}, 120_000);

test("resolveLifecycleHomeDir derives for every explicit soma home without a home dir", () => {
  expect(resolveLifecycleHomeDir({})).toBeUndefined();
  expect(resolveLifecycleHomeDir({ somaHome: join(homedir(), ".soma") })).toBe(join(homedir(), ".soma", SCRATCH_SUBSTRATE_HOME_DIRNAME));
  expect(resolveLifecycleHomeDir({ homeDir: "/x" })).toBe("/x");
  expect(resolveLifecycleHomeDir({ somaHome: "/scratch/soma", homeDir: "/x" })).toBe("/x");
  expect(resolveLifecycleHomeDir({ somaHome: "/scratch/soma" })).toBe(join("/scratch/soma", SCRATCH_SUBSTRATE_HOME_DIRNAME));
});


test.each(["source", "symlink"])("legacy custom live installation keeps projecting with its %s Soma path", async (kind) => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const somaHome = join(root, "custom-live-soma");
    await seedScratchSomaHome(somaHome);
    const alias = join(root, "alias-soma");
    await symlink(somaHome, alias, "dir");
    const configPath = join(fakeHome, ".claude/hooks/soma/soma-claude-code-hook.config.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ somaHome }));
    runLifecycle(fakeHome, ["--soma-home", kind === "symlink" ? alias : somaHome]);
    expect((await stat(join(fakeHome, ".claude/rules/soma/MEMORY.md"))).isFile()).toBe(true);
    await expect(stat(join(somaHome, SCRATCH_SUBSTRATE_HOME_DIRNAME))).rejects.toThrow();
  });
}, 120_000);

test("a live installation bound to another source cannot authorize scratch writes outside it", async () => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const live = join(root, "live-soma");
    const scratch = join(root, "scratch-soma");
    await seedScratchSomaHome(live);
    await seedScratchSomaHome(scratch);
    const configPath = join(fakeHome, ".claude/hooks/soma/soma-claude-code-hook.config.json");
    await mkdir(dirname(configPath), { recursive: true });
    const config = JSON.stringify({ somaHome: live });
    await writeFile(configPath, config);
    // A copy of live metadata inside scratch is not a binding from the substrate.
    await mkdir(join(scratch, "projections"), { recursive: true });
    await writeFile(join(scratch, "projections", "live-binding.json"), config);
    runLifecycle(fakeHome, ["--soma-home", scratch]);
    expect(await listFiles(fakeHome)).toEqual([configPath]);
    expect(await readFile(configPath, "utf8")).toBe(config);
    expect((await stat(join(scratch, SCRATCH_SUBSTRATE_HOME_DIRNAME, ".claude/rules/soma/MEMORY.md"))).isFile()).toBe(true);
  });
}, 120_000);

test("session-end with a scratch transcript and session id leaves the live home empty", async () => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const scratch = join(root, "scratch-soma");
    await mkdir(fakeHome, { recursive: true });
    await seedScratchSomaHome(scratch);
    const transcript = join(scratch, SCRATCH_SUBSTRATE_HOME_DIRNAME, ".claude/projects/project/session.jsonl");
    await mkdir(dirname(transcript), { recursive: true });
    const turns = [
      ["user", "Check the scratch lifecycle isolation behavior."],
      ["assistant", "I checked the home resolver and projection paths."],
      ["user", "Add regression coverage for the session end handler."],
      ["assistant", "The tests verify transcript routing and isolation."],
      ["user", "Run the checks and record the results."],
      ["assistant", "The scratch home contains all generated artifacts."],
      ["user", "Confirm that no live projection was changed."],
      ["user", "Include the session transcript in the check."],
      ["user", "Keep the generated digest inside scratch."],
    ];
    await writeFile(transcript, turns.map(([role, content]) => JSON.stringify({ type: role, message: { role, content } })).join("\n"));
    runLifecycle(fakeHome, ["--soma-home", scratch, "--session-id", "scratch-session", "--transcript", transcript], "session-end");
    expect(await listFiles(fakeHome)).toEqual([]);
    for (const file of await listFiles(root)) expect(relative(scratch, file).startsWith("..")).toBe(false);
    expect(await readFile(join(scratch, "memory/STATE/events.jsonl"), "utf8")).toContain("digest: written");
  });
}, 120_000);

test("session-end passes the derived home to a registered transcript handler", async () => {
  await withTempRoot(async (root) => {
    const scratch = join(root, "scratch-soma");
    await seedScratchSomaHome(scratch);
    let receivedHome: string | undefined;
    registerSessionEndTranscriptHandler("custom", async (input) => {
      receivedHome = input.homeDir;
      return { outcome: "skipped" };
    });
    await runSomaLifecycleSessionEnd({ somaHome: scratch, substrate: "custom", sessionId: "scratch-handler", transcriptPath: join(scratch, "session.jsonl") });
    expect(receivedHome).toBe(join(scratch, SCRATCH_SUBSTRATE_HOME_DIRNAME));
  });
});


test.each([
  ["claude-code", ".claude/hooks/soma/soma-claude-code-hook.config.json"],
  ["codex", ".codex/hooks/soma-lifecycle.config.json"],
  ["grok", ".grok/hooks/soma-lifecycle.config.json"],
  ["pi-dev", ".pi/agent/extensions/soma.ts"],
] as const)("legacy %s bindings accept aliases and reject copied or invalid sources", async (substrate, bindingPath) => {
  await withTempRoot(async (root) => {
    const liveHome = join(root, "home");
    const source = join(root, 'live "Soma"');
    const scratch = join(root, "scratch");
    const alias = join(root, "alias");
    await mkdir(source);
    await mkdir(scratch);
    await symlink(source, alias, "dir");
    const binding = join(liveHome, bindingPath);
    await mkdir(dirname(binding), { recursive: true });
    const raw = substrate === "pi-dev" ? `const SOMA_HOME = ${JSON.stringify(source)};\n` : JSON.stringify({ somaHome: source });
    await writeFile(binding, raw);
    expect(await resolveInstalledLifecycleHomeDir({ somaHome: source, substrate }, liveHome)).toBe(liveHome);
    expect(await resolveInstalledLifecycleHomeDir({ somaHome: alias, substrate }, liveHome)).toBe(liveHome);
    expect(await resolveInstalledLifecycleHomeDir({ somaHome: scratch, substrate }, liveHome)).toBeUndefined();
    expect(await resolveInstalledLifecycleHomeDir({ somaHome: source, substrate, homeDir: scratch }, liveHome)).toBe(scratch);
    await writeFile(binding, "invalid binding");
    expect(await resolveInstalledLifecycleHomeDir({ somaHome: source, substrate }, liveHome)).toBeUndefined();
    await rm(binding);
    expect(await resolveInstalledLifecycleHomeDir({ somaHome: source, substrate }, liveHome)).toBeUndefined();
  });
});

test.each([
  ["codex", buildCodexHomeProjection],
  ["grok", buildGrokHomeProjection],
] as const)("%s projection binds the substrate home independently of its custom Soma source", (substrate, build) => {
  const homeDir = resolve("/target-substrate-home");
  const somaHome = resolve("/custom-soma-home");
  const projection = build(portableProjectionInput, { homeDir, somaHome });
  const configFile = projection.bundle.files.find((file) => file.path === "hooks/soma-lifecycle.config.json");
  expect(JSON.parse(configFile?.content ?? "{}")).toMatchObject({ somaHome, homeDir });
  const entry = projection.bundle.files.find((file) => file.path === `hooks/${substrate}-hook-entry.mjs`);
  expect(entry?.content).toContain('"--home-dir", config.homeDir ?? homedir()');
});

test("pi-dev binds both generated lifecycle extensions to the installation home", () => {
  const homeDir = resolve("/target-pi-home");
  const projection = buildPiDevHomeProjection(portableProjectionInput, { homeDir, somaHome: resolve("/custom-soma-home") });
  for (const path of ["agent/extensions/soma.ts", "agent/extensions/soma-algorithm.ts"]) {
    const content = projection.bundle.files.find((file) => file.path === path)?.content ?? "";
    expect(content).toContain(JSON.stringify(homeDir));
    expect(content).toContain('"--home-dir"');
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(content)).not.toThrow();
  }
});

test("the default Soma path without an installed binding is isolated too", async () => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const scratch = join(fakeHome, ".soma");
    await seedScratchSomaHome(scratch);
    runLifecycle(fakeHome, ["--soma-home", scratch]);
    for (const file of await listFiles(root)) expect(relative(scratch, file).startsWith("..")).toBe(false);
    expect((await stat(join(scratch, SCRATCH_SUBSTRATE_HOME_DIRNAME, ".claude/rules/soma/MEMORY.md"))).isFile()).toBe(true);
  });
}, 120_000);
