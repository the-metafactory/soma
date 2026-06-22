import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  activeIsaProjectionPath,
  bootstrapSomaHome,
  projectClaudeCode,
  projectClaudeCodeHome,
  projectCodexHome,
  projectCursor,
  projectCursorHome,
  projectGrokHome,
  projectPiDevHome,
  installClaudeCodeHomeProjection,
  installCodexHomeProjection,
  installPiDevHomeProjection,
  installSomaForClaudeCode,
  installSomaForCodex,
  installSomaForCursor,
  installSomaForGrok,
  installSomaForPiDev,
  loadActiveIsaForBundle,
  renderActiveIsaFile,
  scaffoldIsa,
  setActiveIsa,
} from "../src/index";
import { portableProjectionInput } from "./fixtures";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-37-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("activeIsaProjectionPath: per-substrate paths match the #37 spec", () => {
  expect(activeIsaProjectionPath("codex")).toBe("memories/soma/active-isa.md");
  expect(activeIsaProjectionPath("pi-dev")).toBe("agent/soma/active-isa.md");
  expect(activeIsaProjectionPath("claude-code")).toBe("rules/soma/ACTIVE_ISA.md");
  expect(activeIsaProjectionPath("cursor")).toBe(".cursor/rules/soma/ACTIVE_ISA.md");
  expect(activeIsaProjectionPath("grok")).toBe("skills/soma/active-isa.md");
  expect(() => activeIsaProjectionPath("custom")).toThrow();
  expect(() => activeIsaProjectionPath("cortex")).toThrow();
});

test("AC-1: codex/pi-dev/claude/cursor/grok home builders all include active-isa when set", () => {
  const codex = projectCodexHome(portableProjectionInput, "/tmp/soma");
  const piDev = projectPiDevHome(portableProjectionInput, "/tmp/soma");
  const claude = projectClaudeCodeHome(portableProjectionInput);
  const cursor = projectCursorHome(portableProjectionInput);
  const grok = projectGrokHome(portableProjectionInput, "/tmp/soma");
  const codexPaths = codex.files.map((f) => f.path);
  const piPaths = piDev.files.map((f) => f.path);
  const claudePaths = claude.files.map((f) => f.path);
  const cursorPaths = cursor.files.map((f) => f.path);
  const grokPaths = grok.files.map((f) => f.path);
  expect(codexPaths).toContain("memories/soma/active-isa.md");
  expect(piPaths).toContain("agent/soma/active-isa.md");
  expect(claudePaths).toContain("rules/soma/ACTIVE_ISA.md");
  expect(cursorPaths).toContain(".cursor/rules/soma/ACTIVE_ISA.md");
  expect(grokPaths).toContain("skills/soma/active-isa.md");
});

test("AC-1: project bundles for claude-code and cursor include active-isa when set", () => {
  const bundle = projectClaudeCode(portableProjectionInput);
  const cursor = projectCursor(portableProjectionInput);
  expect(bundle.files.map((f) => f.path)).toContain(".claude/soma/active-isa.md");
  expect(cursor.files.map((f) => f.path)).toContain(".cursor/rules/soma/ACTIVE_ISA.md");
});

test("AC-2: omits active-isa when no active ISA — no empty file, no stale content", () => {
  const inputWithoutIsa = { ...portableProjectionInput, activeIsa: undefined };
  const codex = projectCodexHome(inputWithoutIsa, "/tmp/soma");
  const piDev = projectPiDevHome(inputWithoutIsa, "/tmp/soma");
  const claude = projectClaudeCodeHome(inputWithoutIsa);
  const claudeProject = projectClaudeCode(inputWithoutIsa);
  const cursor = projectCursorHome(inputWithoutIsa);
  const cursorProject = projectCursor(inputWithoutIsa);
  const grok = projectGrokHome(inputWithoutIsa, "/tmp/soma");
  expect(codex.files.map((f) => f.path)).not.toContain("memories/soma/active-isa.md");
  expect(piDev.files.map((f) => f.path)).not.toContain("agent/soma/active-isa.md");
  // Per #29 the claude home bundle now always contains the rules/soma/*
  // skeleton (README/CONTEXT/PROFILE/TELOS/MEMORY_LAYOUT/SKILLS/POLICY).
  // Only the ACTIVE_ISA file is conditional.
  expect(claude.files.map((f) => f.path)).not.toContain("rules/soma/ACTIVE_ISA.md");
  expect(claude.files.length).toBeGreaterThan(0);
  expect(claudeProject.files.map((f) => f.path)).not.toContain(".claude/soma/active-isa.md");
  expect(cursor.files.map((f) => f.path)).not.toContain(".cursor/rules/soma/ACTIVE_ISA.md");
  expect(cursorProject.files.map((f) => f.path)).not.toContain(".cursor/rules/soma/ACTIVE_ISA.md");
  expect(grok.files.map((f) => f.path)).not.toContain("skills/soma/active-isa.md");
});

test("AC-3: installSomaForCodex projects ISA skill source into ~/.codex/skills/ISA/", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const skillMd = await readFile(join(homeDir, ".codex/skills/ISA/SKILL.md"), "utf8");
    expect(skillMd).toContain("name: ISA");
    expect(skillMd).toMatch(/version:\s+\d+\.\d+\.\d+/);
  });
});

test("AC-3: installSomaForPiDev projects ISA skill source into Pi-safe ~/.pi/agent/skills/isa/", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForPiDev({ homeDir });
    const skillMd = await readFile(join(homeDir, ".pi/agent/skills/isa/SKILL.md"), "utf8");
    const skillDirs = await readdir(join(homeDir, ".pi/agent/skills"));
    expect(skillMd).toContain("name: isa");
    expect(skillDirs).toContain("isa");
    expect(skillDirs).not.toContain("ISA");
  });
});

test("AC-3: non-Claude ISA skill projections rewrite Claude-specific source paths", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    await installSomaForPiDev({ homeDir });

    const claudeHome = "~/" + ".claude";
    const codexScaffold = await readFile(join(homeDir, ".codex/skills/ISA/Workflows/Scaffold.md"), "utf8");
    const piScaffold = await readFile(join(homeDir, ".pi/agent/skills/isa/Workflows/Scaffold.md"), "utf8");
    const projected = `${codexScaffold}\n${piScaffold}`;

    expect(projected).not.toContain(claudeHome);
    expect(projected).toContain("<soma-home>/memory/WORK/{slug}/ISA.md");
    expect(projected).toContain("<soma-home>/memory/WORK/{slug}/_ephemeral/<feature>.md");
  });
});

test("AC-3: installSomaForPiDev removes legacy uppercase ISA projection", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".pi/agent/skills/ISA"), { recursive: true });
    await writeFile(join(homeDir, ".pi/agent/skills/ISA/SKILL.md"), "---\nname: ISA\n---\n", "utf8");

    await installSomaForPiDev({ homeDir });

    const skillDirs = await readdir(join(homeDir, ".pi/agent/skills"));
    expect(skillDirs).not.toContain("ISA");
    expect(skillDirs).toContain("isa");
    await expect(readFile(join(homeDir, ".pi/agent/skills/isa/SKILL.md"), "utf8")).resolves.toContain("name: isa");
  });
});

test("AC-3: installSomaForClaudeCode projects ISA skill source into ~/.claude/skills/ISA/", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const skillMd = await readFile(join(homeDir, ".claude/skills/ISA/SKILL.md"), "utf8");
    expect(skillMd).toContain("name: ISA");
  });
});

test("AC-3: installSomaForClaudeCode projects shared Soma ISA work-home instructions", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const scaffold = await readFile(join(homeDir, ".claude/skills/ISA/Workflows/Scaffold.md"), "utf8");
    expect(scaffold).toContain("<soma-home>/memory/WORK/{slug}/ISA.md");
    expect(scaffold).toContain("<soma-home>/memory/WORK/{slug}/_ephemeral/<feature>.md");
    expect(scaffold).not.toContain("PAI/MEMORY/WORK");
  });
});

test("AC-3: installSomaForCursor projects ISA skill source into Cursor rules", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCursor({ homeDir });
    const skillMd = await readFile(join(homeDir, ".cursor/rules/soma/skills/ISA/SKILL.md"), "utf8");
    expect(skillMd).toContain("name: ISA");
  });
});

test("AC-4: byte-portable active-ISA across all four substrate installs", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await scaffoldIsa({
      homeDir,
      slug: "portability",
      goal: "Adapters render the same bytes across substrates.",
      effort: "E3",
      initialCriteria: [
        { id: "C1", text: "Codex projection equals pi-dev projection equals claude projection.", status: "open" },
      ],
    });
    await setActiveIsa("portability", { homeDir });
    const ctx = await loadActiveIsaForBundle({ homeDir });
    expect(ctx).not.toBeNull();
    // Run all five substrate installers against the same soma home.
    await installSomaForCodex({ homeDir });
    await installSomaForPiDev({ homeDir });
    await installSomaForClaudeCode({ homeDir });
    await installSomaForCursor({ homeDir });
    await installSomaForGrok({ homeDir });

    const codexFile = await readFile(join(homeDir, ".codex/memories/soma/active-isa.md"), "utf8");
    const piFile = await readFile(join(homeDir, ".pi/agent/soma/active-isa.md"), "utf8");
    const claudeFile = await readFile(join(homeDir, ".claude/rules/soma/ACTIVE_ISA.md"), "utf8");
    const cursorFile = await readFile(join(homeDir, ".cursor/rules/soma/ACTIVE_ISA.md"), "utf8");
    const grokFile = await readFile(join(homeDir, ".grok/skills/soma/active-isa.md"), "utf8");

    // BYTE equality — the renderer-of-record is serializeIsa.
    expect(codexFile).toBe(piFile);
    expect(piFile).toBe(claudeFile);
    expect(claudeFile).toBe(cursorFile);
    expect(cursorFile).toBe(grokFile);
    expect(codexFile).toBe(renderActiveIsaFile(ctx!));
  });
});

test("AC-4: portability holds when the active ISA is updated", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    await setActiveIsa("demo", { homeDir });
    await installSomaForCodex({ homeDir });
    await installSomaForPiDev({ homeDir });
    await installSomaForClaudeCode({ homeDir });
    await installSomaForCursor({ homeDir });
    await installSomaForGrok({ homeDir });
    const a = await readFile(join(homeDir, ".codex/memories/soma/active-isa.md"), "utf8");
    const b = await readFile(join(homeDir, ".pi/agent/soma/active-isa.md"), "utf8");
    const c = await readFile(join(homeDir, ".claude/rules/soma/ACTIVE_ISA.md"), "utf8");
    const d = await readFile(join(homeDir, ".cursor/rules/soma/ACTIVE_ISA.md"), "utf8");
    const e = await readFile(join(homeDir, ".grok/skills/soma/active-isa.md"), "utf8");
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
    expect(d).toBe(e);
  });
});

test("AC-5: skill installer baselines track each substrate independently", async () => {
  await withTempHome(async (homeDir) => {
    // Two installs into different substrates should both succeed with the
    // skill present at their respective dest, without one's drift detection
    // interfering with the other.
    await installSomaForCodex({ homeDir });
    await installSomaForPiDev({ homeDir });
    const baselines = JSON.parse(
      await readFile(join(homeDir, ".soma/memory/STATE/skill-baselines.json"), "utf8"),
    ) as Record<string, unknown>;
    // The default key remains, plus per-substrate keys exist.
    expect(baselines.ISA).toBeDefined();
    const substrateKeys = Object.keys(baselines).filter((k) => k.startsWith("ISA@"));
    expect(substrateKeys.length).toBe(2);
  });
});

test("claude-code home install writes rules/soma skeleton even without active ISA (#29)", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installClaudeCodeHomeProjection(
      { ...portableProjectionInput, activeIsa: undefined },
      { homeDir },
    );
    // Skeleton files are always written; ACTIVE_ISA only when set.
    expect(result.files.some((p) => p.endsWith("rules/soma/README.md"))).toBe(true);
    expect(result.files.some((p) => p.endsWith("rules/soma/CONTEXT.md"))).toBe(true);
    expect(result.files.some((p) => p.endsWith("rules/soma/ACTIVE_ISA.md"))).toBe(false);
  });
});

test("codex/pi-dev installs without active ISA still succeed (active-isa omitted)", async () => {
  await withTempHome(async (homeDir) => {
    const codex = await installCodexHomeProjection({ ...portableProjectionInput, activeIsa: undefined }, { homeDir });
    const piDev = await installPiDevHomeProjection({ ...portableProjectionInput, activeIsa: undefined }, { homeDir });
    expect(codex.files.some((p) => p.endsWith("active-isa.md"))).toBe(false);
    expect(piDev.files.some((p) => p.endsWith("active-isa.md"))).toBe(false);
  });
});
