/**
 * #29 Claude Code adapter — full install + projection (per soma#64 pivot).
 * Minimal-correct scope: rules/soma/ skeleton + ISA skill projection +
 * uninstaller. Hooks/settings.local.json patching/CLI integration land in
 * the follow-up issue tracked in the PR body.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  bootstrapSomaHome,
  buildClaudeCodeHomeContext,
  installSomaForClaudeCode,
  planSomaForClaudeCodeInstall,
  scaffoldIsa,
  setActiveIsa,
  uninstallSomaForClaudeCode,
} from "../src/index";
import { portableContextInput } from "./fixtures";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-29-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("AC-1: buildClaudeCodeHomeContext writes everything under rules/soma/", () => {
  const bundle = buildClaudeCodeHomeContext(portableContextInput);
  for (const f of bundle.files) {
    expect(f.path.startsWith("rules/soma/")).toBe(true);
  }
  const expected = [
    "rules/soma/README.md",
    "rules/soma/CONTEXT.md",
    "rules/soma/PROFILE.md",
    "rules/soma/TELOS.md",
    "rules/soma/MEMORY_LAYOUT.md",
    "rules/soma/SKILLS.md",
    "rules/soma/POLICY.md",
    "rules/soma/ACTIVE_ISA.md",
  ];
  expect(bundle.files.map((f) => f.path)).toEqual(expected);
});

test("AC-2: planSomaForClaudeCodeInstall lists every file written", () => {
  const plan = planSomaForClaudeCodeInstall({ homeDir: "/tmp/test-home" });
  expect(plan.substrate).toBe("claude-code");
  expect(plan.apply).toBe(false);
  expect(plan.substrateHome).toBe("/tmp/test-home/.claude");
  expect(plan.substrateFiles).toEqual([
    "/tmp/test-home/.claude/rules/soma/README.md",
    "/tmp/test-home/.claude/rules/soma/CONTEXT.md",
    "/tmp/test-home/.claude/rules/soma/PROFILE.md",
    "/tmp/test-home/.claude/rules/soma/TELOS.md",
    "/tmp/test-home/.claude/rules/soma/MEMORY_LAYOUT.md",
    "/tmp/test-home/.claude/rules/soma/SKILLS.md",
    "/tmp/test-home/.claude/rules/soma/POLICY.md",
    "/tmp/test-home/.claude/rules/soma/ACTIVE_ISA.md",
  ]);
});

test("AC-3: planSomaForClaudeCodeInstall does not write files (plan.apply === false)", async () => {
  await withTempHome(async (homeDir) => {
    planSomaForClaudeCodeInstall({ homeDir });
    // Nothing exists at the target path after planning.
    await expect(stat(join(homeDir, ".claude/rules/soma"))).rejects.toThrow();
  });
});

test("AC-4: installSomaForClaudeCode is idempotent (second install bytes-identical)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    const before = await readFile(join(homeDir, ".claude/rules/soma/CONTEXT.md"), "utf8");
    await installSomaForClaudeCode({ homeDir });
    const after = await readFile(join(homeDir, ".claude/rules/soma/CONTEXT.md"), "utf8");
    expect(after).toBe(before);
  });
});

test("AC-5: CLAUDE.md left untouched (pivot dropped @-import composition)", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    const distinctive = "# my hand-written CLAUDE.md\n\nUntouched by Soma.\n";
    await writeFile(join(homeDir, ".claude/CLAUDE.md"), distinctive, "utf8");
    await installSomaForClaudeCode({ homeDir });
    const after = await readFile(join(homeDir, ".claude/CLAUDE.md"), "utf8");
    expect(after).toBe(distinctive);
  });
});

test("AC-10: uninstallSomaForClaudeCode removes rules/soma/ and skills/ISA/ only", async () => {
  await withTempHome(async (homeDir) => {
    // User-owned sibling file that must survive uninstall.
    await mkdir(join(homeDir, ".claude/rules/user-rule"), { recursive: true });
    await writeFile(join(homeDir, ".claude/rules/user-rule/note.md"), "user note", "utf8");
    await mkdir(join(homeDir, ".claude/skills/UserSkill"), { recursive: true });
    await writeFile(join(homeDir, ".claude/skills/UserSkill/SKILL.md"), "user skill", "utf8");

    await installSomaForClaudeCode({ homeDir });
    const result = await uninstallSomaForClaudeCode({ homeDir });

    expect(result.removed.length).toBe(2);
    await expect(stat(join(homeDir, ".claude/rules/soma"))).rejects.toThrow();
    await expect(stat(join(homeDir, ".claude/skills/ISA"))).rejects.toThrow();
    // User-owned siblings survive.
    expect(await readFile(join(homeDir, ".claude/rules/user-rule/note.md"), "utf8")).toBe("user note");
    expect(await readFile(join(homeDir, ".claude/skills/UserSkill/SKILL.md"), "utf8")).toBe("user skill");
  });
});

test("uninstallSomaForClaudeCode rethrows non-ENOENT errors (sage r1)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    // Make rules/soma read-only AND remove write+execute on the parent
    // so rm cannot recurse into it. On a Bun/Posix runtime this surfaces
    // a non-ENOENT error from rm (EACCES). Uninstall must NOT silently
    // report success.
    const { chmod } = await import("node:fs/promises");
    const parent = join(homeDir, ".claude/rules");
    await chmod(parent, 0o500);
    try {
      await expect(uninstallSomaForClaudeCode({ homeDir })).rejects.toThrow();
    } finally {
      await chmod(parent, 0o700);
    }
  });
});

test("uninstallSomaForClaudeCode is idempotent (second run = no-op, removed=[])", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    await uninstallSomaForClaudeCode({ homeDir });
    const second = await uninstallSomaForClaudeCode({ homeDir });
    expect(second.removed).toEqual([]);
  });
});

test("AC-11: active ISA refreshed on install when one is set", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    await setActiveIsa("demo", { homeDir });
    await installSomaForClaudeCode({ homeDir });
    const isaContent = await readFile(join(homeDir, ".claude/rules/soma/ACTIVE_ISA.md"), "utf8");
    // serializeIsa drops the slug (filename is the slug) but keeps task + Goal.
    expect(isaContent).toContain("task: G");
    expect(isaContent).toContain("## Goal");
  });
});

test("active-ISA file is omitted from skeleton when no active ISA set", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    // No setActiveIsa called → installer must skip the ACTIVE_ISA file.
    await installSomaForClaudeCode({ homeDir });
    await expect(stat(join(homeDir, ".claude/rules/soma/ACTIVE_ISA.md"))).rejects.toThrow();
  });
});

test("README documents the directory contract for humans", () => {
  const bundle = buildClaudeCodeHomeContext(portableContextInput);
  const readme = bundle.files.find((f) => f.path === "rules/soma/README.md");
  expect(readme).toBeDefined();
  expect(readme!.content).toContain("Soma");
  expect(readme!.content).toContain("rules");
  expect(readme!.content).toContain("uninstall");
});
