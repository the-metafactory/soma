/**
 * #115 — `soma migrate claude-skills` (Phase 1).
 *
 * Fixture-based tests for the portability classifier + migration
 * orchestrator. Patterned after `pai-memory-migrator.test.ts`:
 * temp-home lifecycle, deterministic SHAs, idempotency on rerun.
 *
 * Coverage:
 *   - Classifier (portable / needs-adapt / claude-specific): pure
 *     function tested via the exported `classifySkillPortability`
 *     entrypoint to keep tests independent of the FS layer.
 *   - Plan-mode: lists outcomes with no writes; refuses non-flat
 *     trees loud.
 *   - Apply-mode: writes payloads under <somaHome>/skills/<kebab>/,
 *     emits manifest + portability report, applies rewrites for
 *     needs-adapt, skips claude-specific without override.
 *   - Override: `--include-claude-specific` lands the skipped set
 *     with the audit trail intact.
 *   - Idempotency: re-run with unchanged source = 0 writes,
 *     manifest `importedAt` preserved.
 *   - Mixed tree: per-skill routing decision is independent.
 *   - Manifest schema invariants.
 */
import { mkdir, readFile, readdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  classifySkillPortability,
  migrateClaudeSkills,
  planClaudeSkillsMigration,
  readClaudeSkillsMigrationStatus,
} from "../src/claude-skills-migrator";
import type { ClaudeSkillsMigrationManifest } from "../src/types";
import { withTempHome } from "./fixtures/pai-migration-fixtures";

interface SkillFile {
  // POSIX-style path relative to the skill directory.
  relPath: string;
  content: string;
}

interface WriteSkillOptions {
  // Body of `SKILL.md`. Frontmatter is optional — the migrator never
  // parses it; tests can pass plain body content.
  skillMd: string;
  // Optional extra payload files under the skill dir.
  extra?: SkillFile[];
}

async function writeFlatSkillsFixture(
  fromDir: string,
  skills: Record<string, WriteSkillOptions>,
): Promise<void> {
  await mkdir(fromDir, { recursive: true });
  for (const [name, opts] of Object.entries(skills)) {
    const dir = join(fromDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), opts.skillMd, "utf8");
    for (const extra of opts.extra ?? []) {
      const target = join(dir, ...extra.relPath.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, extra.content, "utf8");
    }
  }
}

// ---------------------------------------------------------------------
// classifier (pure-function layer)
// ---------------------------------------------------------------------

test("classifySkillPortability: clean SKILL.md → portable", () => {
  const result = classifySkillPortability([
    {
      relPath: "SKILL.md",
      source: "/tmp/SKILL.md",
      content: Buffer.from("# Clean skill\n\nPure prose. No paths.\n"),
    },
  ]);
  expect(result.tag).toBe("portable");
  expect(result.reason).toBe("clean");
});

test("classifySkillPortability: ~/.claude/PAI/DOCUMENTATION ref → needs-adapt", () => {
  const result = classifySkillPortability([
    {
      relPath: "SKILL.md",
      source: "/tmp/SKILL.md",
      content: Buffer.from(
        "# Skill\n\nSee `~/.claude/PAI/DOCUMENTATION/Skills/SkillSystem.md` for the spec.\n",
      ),
    },
  ]);
  expect(result.tag).toBe("needs-adapt");
  expect(result.reason).toContain("~/.claude/* reference");
});

test("classifySkillPortability: hook binding (Stop:) in body → claude-specific", () => {
  const result = classifySkillPortability([
    {
      relPath: "SKILL.md",
      source: "/tmp/SKILL.md",
      content: Buffer.from(
        "# Skill\n\nLifecycle hook:\n\nStop: run the cleanup\n",
      ),
    },
  ]);
  expect(result.tag).toBe("claude-specific");
  expect(result.reason).toContain("hook binding");
});

test("classifySkillPortability: slash-command in markdown prose → claude-specific", () => {
  const result = classifySkillPortability([
    {
      relPath: "SKILL.md",
      source: "/tmp/SKILL.md",
      content: Buffer.from("# Skill\n\nRun /grill-me to start.\n"),
    },
  ]);
  expect(result.tag).toBe("claude-specific");
  expect(result.reason).toContain("slash-command reference");
});

test("classifySkillPortability: slash-command in non-prose file (.ts) does NOT classify", () => {
  // Phase 1 contract: slash-command detection only fires on .md/.txt/
  // .mdx. Code files routinely embed `/path` fragments and would
  // otherwise false-positive.
  const result = classifySkillPortability([
    {
      relPath: "Lib/client.ts",
      source: "/tmp/client.ts",
      content: Buffer.from('const cmd = "/imagine prompt";\n'),
    },
  ]);
  expect(result.tag).toBe("portable");
});

test("classifySkillPortability: hook binding in non-prose file still fires", () => {
  // Hook bindings outside markdown are still substantive — they're
  // a runtime contract. The classifier fires on any payload file.
  const result = classifySkillPortability([
    {
      relPath: "Tools/hooks.yaml",
      source: "/tmp/hooks.yaml",
      content: Buffer.from("UserPromptSubmit: tools/run.ts\n"),
    },
  ]);
  expect(result.tag).toBe("claude-specific");
});

test("classifySkillPortability: slash inside fenced code block does NOT classify", () => {
  const result = classifySkillPortability([
    {
      relPath: "SKILL.md",
      source: "/tmp/SKILL.md",
      content: Buffer.from(
        "# Skill\n\n```bash\ncurl https://api.example.com/v1/things\n```\n",
      ),
    },
  ]);
  expect(result.tag).toBe("portable");
});

test("classifySkillPortability: bare ~/.claude (no segment after) → needs-adapt", () => {
  const result = classifySkillPortability([
    {
      relPath: "SKILL.md",
      source: "/tmp/SKILL.md",
      content: Buffer.from(
        "# Skill\n\nFiles never leave `~/.claude`.\n",
      ),
    },
  ]);
  expect(result.tag).toBe("needs-adapt");
});

test("classifySkillPortability: claude-specific outranks needs-adapt", () => {
  // A skill with BOTH a hook binding AND a `~/.claude/` ref must
  // classify as claude-specific — the hook binding signal wins.
  const result = classifySkillPortability([
    {
      relPath: "SKILL.md",
      source: "/tmp/SKILL.md",
      content: Buffer.from(
        "# Skill\n\nStop: run the cleanup\n\nAlso see ~/.claude/PAI/DOCUMENTATION/X.md\n",
      ),
    },
  ]);
  expect(result.tag).toBe("claude-specific");
  expect(result.reason).toContain("hook binding");
});

// ---------------------------------------------------------------------
// plan-mode
// ---------------------------------------------------------------------

test("planClaudeSkillsMigration on non-flat tree → isFlatSkillsTree=false", async () => {
  await withTempHome(async (home) => {
    // No skills under the dir — treat as non-flat.
    const fromDir = join(home, "EmptyDir");
    await mkdir(fromDir, { recursive: true });
    const plan = await planClaudeSkillsMigration({
      from: fromDir,
      homeDir: home,
    });
    expect(plan.isFlatSkillsTree).toBe(false);
    expect(plan.outcomes).toEqual([]);
  });
});

test("planClaudeSkillsMigration on flat tree lists outcomes per skill", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeFlatSkillsFixture(fromDir, {
      Portable: { skillMd: "# Portable\n\nclean.\n" },
      NeedsAdapt: {
        skillMd: "# NeedsAdapt\n\nsee ~/.claude/PAI/DOCUMENTATION/X.md\n",
      },
      ClaudeSpecific: {
        skillMd: "# ClaudeSpecific\n\nStop: run cleanup\n",
      },
    });

    const plan = await planClaudeSkillsMigration({
      from: fromDir,
      homeDir: home,
    });

    expect(plan.isFlatSkillsTree).toBe(true);
    expect(plan.apply).toBe(false);
    expect(plan.outcomes.map((o) => o.tag).sort()).toEqual([
      "claude-specific",
      "needs-adapt",
      "portable",
    ]);
    // ClaudeSpecific must be skipped by default (no override).
    const cs = plan.outcomes.find((o) => o.sourceName === "ClaudeSpecific");
    expect(cs?.disposition).toBe("skipped-claude-specific");
    // The two safe ones must plan as imported.
    expect(
      plan.outcomes.find((o) => o.sourceName === "Portable")?.disposition,
    ).toBe("imported");
    expect(
      plan.outcomes.find((o) => o.sourceName === "NeedsAdapt")?.disposition,
    ).toBe("imported");
  });
});

test("planClaudeSkillsMigration requires --from", async () => {
  await expect(
    planClaudeSkillsMigration({ homeDir: "/tmp" }),
  ).rejects.toThrow(/requires --from/);
});

// ---------------------------------------------------------------------
// apply-mode + manifest + report
// ---------------------------------------------------------------------

test("migrateClaudeSkills writes payload + manifest + portability report", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const somaHome = join(home, "soma");
    await writeFlatSkillsFixture(fromDir, {
      Portable: {
        skillMd: "# Portable\n\nclean prose.\n",
        extra: [
          { relPath: "Workflows/Run.md", content: "# Run\n\nstep 1\n" },
          { relPath: "Tools/helper.ts", content: "export const x = 1;\n" },
        ],
      },
      NeedsAdapt: {
        skillMd: "# NeedsAdapt\n\nsee ~/.claude/PAI/DOCUMENTATION/X.md\n",
      },
      ClaudeSpecific: {
        skillMd: "# ClaudeSpecific\n\nStop: run cleanup\n",
      },
    });

    const result = await migrateClaudeSkills({ from: fromDir, somaHome });

    expect(result.apply).toBe(true);
    expect(result.writtenCount).toBe(2);
    expect(result.skippedClaudeSpecificCount).toBe(1);
    expect(result.skippedIdempotentCount).toBe(0);

    // Payload files for the two imported skills landed.
    const portableSkillMd = await readFile(
      join(somaHome, "skills/portable/SKILL.md"),
      "utf8",
    );
    expect(portableSkillMd).toContain("clean prose");
    const portableWorkflow = await readFile(
      join(somaHome, "skills/portable/Workflows/Run.md"),
      "utf8",
    );
    expect(portableWorkflow).toContain("step 1");
    // needs-adapt skill: rewriter swapped the `~/.claude/PAI/DOCUMENTATION/` path.
    const adaptedSkillMd = await readFile(
      join(somaHome, "skills/needs-adapt/SKILL.md"),
      "utf8",
    );
    expect(adaptedSkillMd).toContain("~/.soma/PAI/DOCUMENTATION/");
    expect(adaptedSkillMd).not.toContain("~/.claude/PAI/DOCUMENTATION/");

    // claude-specific skill must NOT land.
    const csExists = await readdir(join(somaHome, "skills")).then((names) =>
      names.includes("claude-specific"),
    );
    expect(csExists).toBe(false);

    // Manifest + report present.
    const manifestRaw = await readFile(result.manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as ClaudeSkillsMigrationManifest;
    expect(manifest.schema).toBe("soma.claude-skills-migration.v1");
    expect(manifest.skills.length).toBe(2);
    expect(manifest.skills.map((s) => s.kebabName).sort()).toEqual([
      "needs-adapt",
      "portable",
    ]);
    // Each manifest entry has a sourceSha + per-file SHAs.
    for (const entry of manifest.skills) {
      expect(entry.sourceSha).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.keys(entry.fileShas).length).toBeGreaterThan(0);
      for (const sha of Object.values(entry.fileShas)) {
        expect(sha).toMatch(/^[a-f0-9]{64}$/);
      }
    }

    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("# Claude Skills Portability Report");
    expect(report).toContain("portable | portable | imported");
    expect(report).toContain("needs-adapt | needs-adapt | imported");
    expect(report).toContain("claude-specific | claude-specific | skipped-claude-specific");
    // AC-4 transparency — report documents the heuristic.
    expect(report).toContain("Classifier rules (Phase 1, heuristic)");
  });
});

test("migrateClaudeSkills --include-claude-specific lands the skipped set", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const somaHome = join(home, "soma");
    await writeFlatSkillsFixture(fromDir, {
      ClaudeSpecific: {
        skillMd: "# ClaudeSpecific\n\nStop: run cleanup\n",
      },
    });

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      includeClaudeSpecific: true,
    });

    expect(result.writtenCount).toBe(1);
    expect(result.skippedClaudeSpecificCount).toBe(0);
    expect(result.includeClaudeSpecific).toBe(true);
    // Payload landed.
    const body = await readFile(
      join(somaHome, "skills/claude-specific/SKILL.md"),
      "utf8",
    );
    expect(body).toContain("Stop:");
    // Manifest reflects the override.
    const manifest = JSON.parse(
      await readFile(result.manifestPath, "utf8"),
    ) as ClaudeSkillsMigrationManifest;
    expect(manifest.includeClaudeSpecific).toBe(true);
    expect(manifest.skills[0]?.tag).toBe("claude-specific");
    // Report carries the audit trail.
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Include claude-specific: yes");
    expect(report).toContain("claude-specific | claude-specific | imported");
  });
});

test("migrateClaudeSkills is idempotent: re-run with unchanged source writes nothing", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const somaHome = join(home, "soma");
    await writeFlatSkillsFixture(fromDir, {
      Portable: { skillMd: "# Portable\n\nclean.\n" },
      NeedsAdapt: {
        skillMd: "# NeedsAdapt\n\nsee ~/.claude/PAI/DOCUMENTATION/X.md\n",
      },
    });

    const first = await migrateClaudeSkills({ from: fromDir, somaHome });
    expect(first.writtenCount).toBe(2);
    expect(first.skippedIdempotentCount).toBe(0);

    const second = await migrateClaudeSkills({ from: fromDir, somaHome });
    expect(second.writtenCount).toBe(0);
    expect(second.skippedIdempotentCount).toBe(2);
    // Manifest importedAt preserved — byte-stable rerun.
    expect(second.importedAt).toBe(first.importedAt);

    // Manifest contents byte-stable.
    const manifest1 = await readFile(first.manifestPath, "utf8");
    const manifest2 = await readFile(second.manifestPath, "utf8");
    expect(manifest2).toBe(manifest1);
  });
});

test("migrateClaudeSkills handles mixed tree: per-skill routing is independent", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const somaHome = join(home, "soma");
    await writeFlatSkillsFixture(fromDir, {
      Alpha: { skillMd: "# Alpha\n\nclean.\n" },
      Beta: {
        skillMd: "# Beta\n\nsee ~/.claude/PAI/DOCUMENTATION/B.md\n",
      },
      Gamma: { skillMd: "# Gamma\n\nStop: run cleanup\n" },
      Delta: { skillMd: "# Delta\n\nclean too.\n" },
    });

    const result = await migrateClaudeSkills({ from: fromDir, somaHome });
    expect(result.outcomes.length).toBe(4);
    const tagBySource = Object.fromEntries(
      result.outcomes.map((o) => [o.sourceName, o.tag]),
    );
    expect(tagBySource.Alpha).toBe("portable");
    expect(tagBySource.Beta).toBe("needs-adapt");
    expect(tagBySource.Gamma).toBe("claude-specific");
    expect(tagBySource.Delta).toBe("portable");
    expect(result.writtenCount).toBe(3);
    expect(result.skippedClaudeSpecificCount).toBe(1);
  });
});

test("migrateClaudeSkills refuses non-flat tree on apply", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "empty");
    await mkdir(fromDir, { recursive: true });
    await expect(
      migrateClaudeSkills({ from: fromDir, somaHome: join(home, "soma") }),
    ).rejects.toThrow(/not a flat skills tree/);
  });
});

// ---------------------------------------------------------------------
// #118 — symlink handling: follow user-owned, refuse out-of-home,
// per-skill log-and-continue, full path in error messages.
// ---------------------------------------------------------------------

// AC-1: a symlink whose realpath stays within $HOME is FOLLOWED and
// its bytes are imported as if they lived at the symlink path. The
// containing skill imports cleanly with a `followed-user-owned-symlink`
// audit entry.
test("#118 migrateClaudeSkills follows user-owned symlink to FILE inside $HOME", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const skillDir = join(fromDir, "WithLink");
    await mkdir(skillDir, { recursive: true });
    await mkdir(join(skillDir, "Workflows"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# WithLink\n\nclean.\n", "utf8");
    // External (still inside $HOME) target file.
    const externalDir = join(home, "external");
    await mkdir(externalDir, { recursive: true });
    await writeFile(join(externalDir, "Run.md"), "# External Run\n\nfollowed!\n", "utf8");
    // Symlink Workflows/Run.md → ../../external/Run.md (relative form).
    await symlink(join(externalDir, "Run.md"), join(skillDir, "Workflows/Run.md"));

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      homeDir: home,
    });
    expect(result.writtenCount).toBe(1);
    const outcome = result.outcomes.find((o) => o.sourceName === "WithLink");
    expect(outcome?.disposition).toBe("imported");
    // Followed-symlink bytes landed at the symlink-source path.
    const landed = await readFile(
      join(home, "soma/skills/with-link/Workflows/Run.md"),
      "utf8",
    );
    expect(landed).toContain("followed!");
    // Audit entry recorded.
    expect(outcome?.audit?.some(
      (a) => a.kind === "followed-user-owned-symlink" && a.relPath === "Workflows/Run.md",
    )).toBe(true);
  });
});

// AC-1 (b): a symlink to a DIRECTORY inside $HOME is walked recursively.
// Matches user's real-world repro: ~/.claude/skills/Business/Accounting
// → ~/work/invisible/Accounting (dir with SKILL.md + Workflows/).
test("#118 migrateClaudeSkills walks user-owned symlinked DIRECTORY recursively", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const skillDir = join(fromDir, "Business");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Business\n\ntop-level skill.\n", "utf8");

    // External skill (private worktree) — has its own subtree.
    const externalAccounting = join(home, "work/invisible/Accounting");
    await mkdir(join(externalAccounting, "Workflows"), { recursive: true });
    await writeFile(join(externalAccounting, "SKILL.md"), "# Accounting\n\nprivate skill.\n", "utf8");
    await writeFile(join(externalAccounting, "Workflows/Compute.md"), "# Compute\n\nstep one\n", "utf8");

    // Symlink the Accounting subdir inside Business/.
    await symlink(externalAccounting, join(skillDir, "Accounting"));

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      homeDir: home,
    });
    expect(result.writtenCount).toBe(1);
    const business = result.outcomes.find((o) => o.sourceName === "Business");
    expect(business?.disposition).toBe("imported");
    // Followed subtree landed under Business kebab.
    expect(
      await readFile(
        join(home, "soma/skills/business/Accounting/SKILL.md"),
        "utf8",
      ),
    ).toContain("private skill");
    expect(
      await readFile(
        join(home, "soma/skills/business/Accounting/Workflows/Compute.md"),
        "utf8",
      ),
    ).toContain("step one");
    // Two audit entries — one for the symlinked dir, one not needed
    // since recursive walk happens after the dir resolve. We only
    // need to record the symlink point itself.
    const followed = business?.audit?.filter(
      (a) => a.kind === "followed-user-owned-symlink",
    ) ?? [];
    expect(followed.length).toBeGreaterThanOrEqual(1);
    expect(followed.some((a) => a.relPath === "Accounting")).toBe(true);
  });
});

// AC-1 (c): top-level <Name>/SKILL.md is itself a symlink to a file
// inside $HOME → followed + imported.
test("#118 migrateClaudeSkills follows user-owned symlinked top-level SKILL.md", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const skillDir = join(fromDir, "Linked");
    await mkdir(skillDir, { recursive: true });
    const realSkill = join(home, "external/Linked-SKILL.md");
    await mkdir(join(home, "external"), { recursive: true });
    await writeFile(realSkill, "# Linked\n\nfollowed top-level.\n", "utf8");
    await symlink(realSkill, join(skillDir, "SKILL.md"));

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      homeDir: home,
    });
    expect(result.writtenCount).toBe(1);
    const landed = await readFile(join(home, "soma/skills/linked/SKILL.md"), "utf8");
    expect(landed).toContain("followed top-level");
  });
});

// AC-2: an out-of-home symlink target still refuses. The surrounding
// skill is classified `refused-other`; other skills continue (AC-3).
test("#118 migrateClaudeSkills refuses out-of-home symlink as refused-other; others continue", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const somaHome = join(home, "soma");

    // BadSkill: symlinks /etc/passwd into the skill tree.
    const badDir = join(fromDir, "BadSkill");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "SKILL.md"), "# BadSkill\n", "utf8");
    await symlink("/etc/passwd", join(badDir, "danger.md"));

    // GoodSkill: clean import next to it.
    const goodDir = join(fromDir, "GoodSkill");
    await mkdir(goodDir, { recursive: true });
    await writeFile(join(goodDir, "SKILL.md"), "# GoodSkill\n\nclean.\n", "utf8");

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      homeDir: home,
    });
    const bad = result.outcomes.find((o) => o.sourceName === "BadSkill");
    expect(bad?.disposition).toBe("refused-other");
    // AC-4: refusal reason includes the source skill name + relpath.
    expect(bad?.refusalReason).toContain("BadSkill/danger.md");
    // GoodSkill still imports.
    const good = result.outcomes.find((o) => o.sourceName === "GoodSkill");
    expect(good?.disposition).toBe("imported");
    expect(result.writtenCount).toBe(1);
  });
});

// Holly R1 S1 — denylist regression: a symlink targeting a path
// inside `$HOME` but under a denylisted subpath (`.ssh`, `.aws`, etc.)
// is refused even though it would otherwise be a user-owned-symlink
// follow target. The denylist anchors the security boundary against
// credential exfiltration via skill content references.
test("#118 migrateClaudeSkills refuses denylisted home subpath (.ssh) as refused-other", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const somaHome = join(home, "soma");

    // Create a fake `.ssh/id_rsa` inside $HOME to symlink at.
    const sshDir = join(home, ".ssh");
    await mkdir(sshDir, { recursive: true });
    await writeFile(join(sshDir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n", "utf8");

    // SneakySkill: symlinks ~/.ssh/id_rsa into the skill tree.
    const sneakyDir = join(fromDir, "SneakySkill");
    await mkdir(sneakyDir, { recursive: true });
    await writeFile(join(sneakyDir, "SKILL.md"), "# SneakySkill\n", "utf8");
    await symlink(join(home, ".ssh/id_rsa"), join(sneakyDir, "creds.md"));

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      homeDir: home,
    });
    const sneaky = result.outcomes.find((o) => o.sourceName === "SneakySkill");
    expect(sneaky?.disposition).toBe("refused-other");
    // Refusal reason mentions the denylisted path so the principal
    // can locate the offending symlink without grep.
    expect(sneaky?.refusalReason).toContain("SneakySkill/creds.md");
    expect(sneaky?.refusalReason?.toLowerCase()).toContain("denylist");
  });
});

// AC-5 (c): symlink cycle (A → B → A) inside $HOME → detected and
// refused gracefully (refused-other), no infinite loop.
test("#118 migrateClaudeSkills detects symlink cycle and refuses gracefully", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const skillDir = join(fromDir, "Cyclic");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Cyclic\n", "utf8");
    // Build a cycle entirely inside $HOME: dirA → dirB → dirA.
    const dirA = join(home, "cycle/a");
    const dirB = join(home, "cycle/b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await symlink(dirB, join(dirA, "to-b"));
    await symlink(dirA, join(dirB, "to-a"));
    // Symlink Cyclic/loop → dirA. Walker enters loop/to-b → to-a → ...
    await symlink(dirA, join(skillDir, "loop"));

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      homeDir: home,
    });
    const outcome = result.outcomes.find((o) => o.sourceName === "Cyclic");
    expect(outcome?.disposition).toBe("refused-other");
    expect(outcome?.refusalReason).toContain("Cyclic/");
    expect(outcome?.refusalReason?.toLowerCase()).toContain("cycle");
  });
});

// AC-5 (d): symlink-then-escape — target is itself a symlink to a path
// outside $HOME. realpath must resolve the full chain and reject.
test("#118 migrateClaudeSkills rejects symlink chain escaping $HOME", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const skillDir = join(fromDir, "Escape");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Escape\n", "utf8");
    // hop is inside $HOME but points OUTSIDE.
    const hop = join(home, "hop");
    await symlink("/etc/passwd", hop);
    // The skill's inner symlink targets `hop` (which is inside $HOME by
    // path string), but realpath resolves through to /etc/passwd.
    await symlink(hop, join(skillDir, "leak.md"));

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      homeDir: home,
    });
    const outcome = result.outcomes.find((o) => o.sourceName === "Escape");
    expect(outcome?.disposition).toBe("refused-other");
    expect(outcome?.refusalReason).toContain("Escape/leak.md");
  });
});

// AC-5 (f): symlinked top-level SKILL.md whose target is OUTSIDE $HOME
// → the whole <Name> skill classifies as refused-other; siblings continue.
test("#118 migrateClaudeSkills refuses out-of-home symlinked top-level SKILL.md; siblings continue", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const somaHome = join(home, "soma");
    const badDir = join(fromDir, "OutOfHome");
    await mkdir(badDir, { recursive: true });
    await symlink("/etc/passwd", join(badDir, "SKILL.md"));
    const goodDir = join(fromDir, "Sibling");
    await mkdir(goodDir, { recursive: true });
    await writeFile(join(goodDir, "SKILL.md"), "# Sibling\n\nclean.\n", "utf8");

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      homeDir: home,
    });
    const bad = result.outcomes.find((o) => o.sourceName === "OutOfHome");
    expect(bad?.disposition).toBe("refused-other");
    expect(bad?.refusalReason).toContain("OutOfHome/SKILL.md");
    expect(
      result.outcomes.find((o) => o.sourceName === "Sibling")?.disposition,
    ).toBe("imported");
  });
});

// Real-world repro of the issue: user's Business/Accounting symlinks
// to a private worktree. Imports must NOT abort the whole migrate.
test("#118 real-world repro: Business/Accounting → ~/work/invisible/Accounting imports cleanly", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, ".claude/skills");
    const somaHome = join(home, ".soma");
    // The user's Business top-level skill carries an Accounting symlink.
    const businessDir = join(fromDir, "Business");
    await mkdir(businessDir, { recursive: true });
    await writeFile(
      join(businessDir, "SKILL.md"),
      "# Business\n\nBusiness operations skill.\n",
      "utf8",
    );
    // Private worktree skill the user is developing.
    const privateAccounting = join(home, "work/invisible/Accounting");
    await mkdir(join(privateAccounting, "Workflows"), { recursive: true });
    await writeFile(
      join(privateAccounting, "SKILL.md"),
      "# Accounting\n\nPrivate accounting skill.\n",
      "utf8",
    );
    await writeFile(
      join(privateAccounting, "Workflows/Reconcile.md"),
      "# Reconcile\n",
      "utf8",
    );
    await symlink(privateAccounting, join(businessDir, "Accounting"));

    // A second top-level skill to verify the rest of the migrate still
    // proceeds (regression for the original abort behavior).
    const otherDir = join(fromDir, "Other");
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(otherDir, "SKILL.md"), "# Other\n", "utf8");

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      homeDir: home,
    });
    expect(result.writtenCount).toBe(2);
    expect(
      result.outcomes.find((o) => o.sourceName === "Business")?.disposition,
    ).toBe("imported");
    expect(
      result.outcomes.find((o) => o.sourceName === "Other")?.disposition,
    ).toBe("imported");
    // The followed private skill body landed under Business.
    expect(
      await readFile(
        join(somaHome, "skills/business/Accounting/SKILL.md"),
        "utf8",
      ),
    ).toContain("Private accounting");
    expect(
      await readFile(
        join(somaHome, "skills/business/Accounting/Workflows/Reconcile.md"),
        "utf8",
      ),
    ).toContain("Reconcile");
  });
});

// Followed user-owned worktree may carry a `.git/` directory (the
// principal's private skill is itself a worktree). The walker must
// silently skip it inside the followed branch instead of refusing
// the whole skill — matches the real-world repro from the bug
// report where `~/.claude/skills/Business/Accounting` is a symlink
// to a git-managed worktree.
test("#118 followed user-owned symlink that carries .git/ imports cleanly", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const skillDir = join(fromDir, "Business");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Business\n", "utf8");
    // External worktree: real skill files plus a .git/ marker that
    // would otherwise refuse the import.
    const ext = join(home, "work/private/Accounting");
    await mkdir(join(ext, "Workflows"), { recursive: true });
    await mkdir(join(ext, ".git"), { recursive: true });
    await writeFile(join(ext, "SKILL.md"), "# Accounting\n", "utf8");
    await writeFile(join(ext, "Workflows/Reconcile.md"), "# Reconcile\n", "utf8");
    await writeFile(join(ext, ".git/config"), "[core]\n", "utf8");
    await symlink(ext, join(skillDir, "Accounting"));

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      homeDir: home,
    });
    const outcome = result.outcomes.find((o) => o.sourceName === "Business");
    expect(outcome?.disposition).toBe("imported");
    // Skill body landed; .git/ did NOT.
    expect(
      await readFile(
        join(home, "soma/skills/business/Accounting/SKILL.md"),
        "utf8",
      ),
    ).toContain("Accounting");
    const accountingDir = await readdir(
      join(home, "soma/skills/business/Accounting"),
    );
    expect(accountingDir).not.toContain(".git");
  });
});

// A `.git/` at the TOP of a skill (no symlink in play) still refuses —
// that's the original anti-leak guarantee.
test("#118 .git inline in skill tree still refuses (no symlink)", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const skillDir = join(fromDir, "Bad");
    await mkdir(join(skillDir, ".git"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Bad\n", "utf8");
    await writeFile(join(skillDir, ".git/config"), "[core]\n", "utf8");

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      homeDir: home,
    });
    const outcome = result.outcomes.find((o) => o.sourceName === "Bad");
    expect(outcome?.disposition).toBe("refused-other");
    expect(outcome?.refusalReason).toContain("VCS metadata");
    expect(outcome?.refusalReason).toContain("Bad/.git");
  });
});

// Audit recorded in portability report (best-effort surface).
test("#118 portability report lists followed-user-owned-symlink audit entries", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const somaHome = join(home, "soma");
    const skillDir = join(fromDir, "Audit");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Audit\n", "utf8");
    const external = join(home, "ext.md");
    await writeFile(external, "# Ext\n", "utf8");
    await symlink(external, join(skillDir, "Ext.md"));

    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      homeDir: home,
    });
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("followed-user-owned-symlink");
  });
});

// ---------------------------------------------------------------------
// status
// ---------------------------------------------------------------------

test("readClaudeSkillsMigrationStatus returns null before first apply", async () => {
  await withTempHome(async (home) => {
    const status = await readClaudeSkillsMigrationStatus({
      somaHome: join(home, "soma"),
    });
    expect(status).toBeNull();
  });
});

test("readClaudeSkillsMigrationStatus returns the manifest after apply", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const somaHome = join(home, "soma");
    await writeFlatSkillsFixture(fromDir, {
      Portable: { skillMd: "# Portable\n\nclean.\n" },
    });
    await migrateClaudeSkills({ from: fromDir, somaHome });
    const status = await readClaudeSkillsMigrationStatus({ somaHome });
    expect(status).not.toBeNull();
    expect(status?.schema).toBe("soma.claude-skills-migration.v1");
    expect(status?.skills.length).toBe(1);
    expect(status?.skills[0]?.kebabName).toBe("portable");
  });
});
