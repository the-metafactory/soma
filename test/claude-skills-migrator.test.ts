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

test("migrateClaudeSkills refuses non-editor-config symlinks loud", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    const skillDir = join(fromDir, "BadSkill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# BadSkill\n", "utf8");
    // Symlink that is NOT under an editor-config dir → must abort.
    await symlink("/etc/passwd", join(skillDir, "danger.md"));
    await expect(
      migrateClaudeSkills({
        from: fromDir,
        somaHome: join(home, "soma"),
      }),
    ).rejects.toThrow(/refused symlink/);
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
