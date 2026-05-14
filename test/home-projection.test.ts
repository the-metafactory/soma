import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  buildCodexHomeProjection,
  buildPiDevHomeProjection,
  installCodexHomeProjection,
  installPiDevHomeProjection,
  resolveHomeProjectionPaths,
} from "../src/index";
import { portableContextInput } from "./fixtures";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-home-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("resolves codex home projection paths from a home directory", () => {
  const paths = resolveHomeProjectionPaths("codex", { homeDir: "/tmp/soma-test-home" });

  expect(paths.substrate).toBe("codex");
  expect(paths.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(paths.substrateHome).toBe("/tmp/soma-test-home/.codex");
});

test("resolves pi.dev home projection paths from a home directory", () => {
  const paths = resolveHomeProjectionPaths("pi-dev", { homeDir: "/tmp/soma-test-home" });

  expect(paths.substrate).toBe("pi-dev");
  expect(paths.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(paths.substrateHome).toBe("/tmp/soma-test-home/.pi");
});

test("rejects unimplemented home projection substrates", () => {
  expect(() => resolveHomeProjectionPaths("claude-code", { homeDir: "/tmp/soma-test-home" })).toThrow("not implemented");
});

test("builds codex home projection bundle for default availability", () => {
  const projection = buildCodexHomeProjection(portableContextInput, { homeDir: "/tmp/soma-test-home" });

  expect(projection.substrateHome).toBe("/tmp/soma-test-home/.codex");
  expect(projection.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(projection.bundle.files.map((file) => file.path)).toEqual([
    "rules/soma.rules",
    "skills/soma/SKILL.md",
    "memories/soma/profile.md",
    "memories/soma/memory-layout.md",
    "memories/soma/pai-imports.md",
    "memories/soma/skills.md",
    "memories/soma/policy.md",
  ]);
  expect(projection.bundle.instructions).toContain("Soma default availability");
  expect(projection.bundle.instructions).toContain("/tmp/soma-test-home/.soma");
});

test("builds pi.dev home projection bundle for default availability", () => {
  const projection = buildPiDevHomeProjection(portableContextInput, { homeDir: "/tmp/soma-test-home" });

  expect(projection.substrateHome).toBe("/tmp/soma-test-home/.pi");
  expect(projection.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(projection.bundle.files.map((file) => file.path)).toEqual([
    "agent/extensions/soma.ts",
    "agent/soma/context.md",
    "agent/soma/profile.md",
    "agent/soma/memory-layout.md",
    "agent/soma/pai-imports.md",
    "agent/soma/tools.md",
    "agent/soma/skills.md",
    "agent/soma/policy.md",
    "agent/skills/soma/SKILL.md",
  ]);
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("before_agent_start");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("soma_context");
  expect(projection.bundle.files.find((file) => file.path === "agent/skills/soma/SKILL.md")?.content).toContain("name: soma");
});

test("installs codex home projection into a substrate home", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installCodexHomeProjection(portableContextInput, { homeDir });

    expect(result.substrate).toBe("codex");
    expect(result.rootDir).toBe(join(homeDir, ".codex"));
    expect(result.files).toHaveLength(7);

    const rules = await readFile(join(homeDir, ".codex/rules/soma.rules"), "utf8");
    const skill = await readFile(join(homeDir, ".codex/skills/soma/SKILL.md"), "utf8");
    const profile = await readFile(join(homeDir, ".codex/memories/soma/profile.md"), "utf8");
    const paiImports = await readFile(join(homeDir, ".codex/memories/soma/pai-imports.md"), "utf8");

    expect(rules).toContain("Use Soma as the portable personal assistant context");
    expect(rules.split("\n").filter((line) => line.trim() !== "")).toSatisfy((lines: string[]) =>
      lines.every((line) => line.startsWith("#")),
    );
    expect(skill).toContain("name: soma");
    expect(skill).toContain("pai-imports.md");
    expect(profile).toContain("ISC-PORTABLE-1");
    expect(paiImports).toContain(`${homeDir}/.soma/profile/imports/claude/DA_IDENTITY.md`);
  });
});

test("installs pi.dev home projection into a substrate home", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installPiDevHomeProjection(portableContextInput, { homeDir });

    expect(result.substrate).toBe("pi-dev");
    expect(result.rootDir).toBe(join(homeDir, ".pi"));
    expect(result.files).toHaveLength(9);

    const extension = await readFile(join(homeDir, ".pi/agent/extensions/soma.ts"), "utf8");
    const profile = await readFile(join(homeDir, ".pi/agent/soma/profile.md"), "utf8");
    const paiImports = await readFile(join(homeDir, ".pi/agent/soma/pai-imports.md"), "utf8");
    const skill = await readFile(join(homeDir, ".pi/agent/skills/soma/SKILL.md"), "utf8");

    expect(extension).toContain("registerTool");
    expect(extension).toContain("before_agent_start");
    expect(extension).toContain("soma_context");
    expect(profile).toContain("ISC-PORTABLE-1");
    expect(paiImports).toContain(`${homeDir}/.soma/profile/imports/claude/DA_IDENTITY.md`);
    expect(skill).toContain("name: soma");
  });
});
