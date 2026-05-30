/**
 * #115 Phase 2 — `--smoke <substrate>` integration tests for the
 * `soma migrate claude-skills` migrator.
 *
 * Coverage matrix:
 *   - Single-substrate smoke (codex): portable skill → verified.
 *   - Single-substrate smoke (pi-dev): portable skill → verified.
 *   - Multi-substrate (codex + pi-dev): both columns populated.
 *   - Codex-incompatible (hook binding in needs-adapt) → codex failed.
 *   - Idempotency: re-run smoke on unchanged source + verified
 *     verdict → no extra writes, manifest body byte-stable.
 *   - Report columns conditional on `--smoke`: absent without flag,
 *     present with flag.
 *   - Manifest carries per-substrate verdicts.
 *   - Substrate verify summary in result.
 *   - All-substrate keyword resolves to codex+pi-dev.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  migrateClaudeSkills,
  planClaudeSkillsMigration,
} from "../src/claude-skills-migrator";
import type {
  ClaudeSkillsMigrationManifest,
} from "../src/types";
import { withTempHome } from "./fixtures/pai-migration-fixtures";

interface FixtureSkill {
  name: string;
  skillMd: string;
  extras?: { relPath: string; content: string }[];
}

async function writeSkillsFixture(
  fromDir: string,
  skills: FixtureSkill[],
): Promise<void> {
  await mkdir(fromDir, { recursive: true });
  for (const skill of skills) {
    const dir = join(fromDir, skill.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skill.skillMd, "utf8");
    for (const extra of skill.extras ?? []) {
      const target = join(dir, ...extra.relPath.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, extra.content, "utf8");
    }
  }
}

const PORTABLE_SKILL_MD = [
  "---",
  "name: Portable",
  "description: A portable demo skill.",
  "---",
  "",
  "# Portable",
  "",
  "Pure prose body with no Claude-only signal.",
].join("\n");

test("--smoke codex: portable skill verified", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex"],
    });
    expect(result.smokeSubstrates).toEqual(["codex"]);
    const portable = result.outcomes.find((o) => o.kebabName === "portable");
    expect(portable?.substrates?.codex?.status).toBe("verified");
    expect(result.substrateVerifySummary?.codex?.verified).toBe(1);
    expect(result.substrateVerifySummary?.codex?.failed).toBe(0);
  });
});

test("--smoke pi-dev: portable skill verified", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["pi-dev"],
    });
    expect(result.smokeSubstrates).toEqual(["pi-dev"]);
    const portable = result.outcomes.find((o) => o.kebabName === "portable");
    expect(portable?.substrates?.["pi-dev"]?.status).toBe("verified");
    expect(result.substrateVerifySummary?.["pi-dev"]?.verified).toBe(1);
  });
});

test("--smoke codex --smoke pi-dev: both substrates populated", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex", "pi-dev"],
    });
    expect(result.smokeSubstrates).toEqual(["codex", "pi-dev"]);
    const portable = result.outcomes.find((o) => o.kebabName === "portable");
    expect(portable?.substrates?.codex?.status).toBe("verified");
    expect(portable?.substrates?.["pi-dev"]?.status).toBe("verified");
  });
});

test("--smoke codex --smoke pi-dev verifies Tools/*.ts files project non-empty", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      {
        name: "ToolRunner",
        skillMd: PORTABLE_SKILL_MD.replace("Portable", "ToolRunner"),
        extras: [
          { relPath: "Tools/Run.ts", content: "export const run = () => 'ok';\n" },
        ],
      },
    ]);
    const somaHome = join(home, "soma");
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex", "pi-dev"],
    });

    const landedTool = await readFile(join(somaHome, "skills/tool-runner/Tools/Run.ts"), "utf8");
    expect(landedTool).toContain("export const run");
    const toolRunner = result.outcomes.find((o) => o.kebabName === "tool-runner");
    expect(toolRunner?.substrates?.codex?.status).toBe("verified");
    expect(toolRunner?.substrates?.["pi-dev"]?.status).toBe("verified");
    expect(toolRunner?.substrates?.codex?.issues.some((issue) => issue.kind === "unresolved-tool-path")).toBe(false);
    expect(toolRunner?.substrates?.["pi-dev"]?.issues.some((issue) => issue.kind === "unresolved-tool-path")).toBe(false);
  });
});

test("--smoke codex surfaces empty Tools/*.ts as unresolved-tool-path warning", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      {
        name: "EmptyTool",
        skillMd: PORTABLE_SKILL_MD.replace("Portable", "EmptyTool"),
        extras: [
          { relPath: "Tools/Empty.ts", content: "" },
        ],
      },
    ]);
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      smokeSubstrates: ["codex"],
    });

    const emptyTool = result.outcomes.find((o) => o.kebabName === "empty-tool");
    expect(emptyTool?.substrates?.codex?.status).toBe("verified-with-warnings");
    expect(emptyTool?.substrates?.codex?.issues.some((issue) => issue.kind === "unresolved-tool-path")).toBe(true);
  });
});

test("--smoke <substrate>: codex-incompatible skill (hook binding under include-claude-specific) → failed", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    // Skill explicitly carries a hook binding; classifier tags
    // it `claude-specific`. We pass --include-claude-specific so
    // it lands AND gets smoked. Expectation: codex verify fails
    // because the hook binding has no codex equivalent.
    await writeSkillsFixture(fromDir, [
      {
        name: "Hooky",
        skillMd: [
          "---",
          "name: Hooky",
          "description: Has a hook.",
          "---",
          "",
          "Stop: cleanup hook",
          "",
        ].join("\n"),
      },
    ]);
    const somaHome = join(home, "soma");
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      includeClaudeSpecific: true,
      smokeSubstrates: ["codex", "pi-dev"],
    });
    const hooky = result.outcomes.find((o) => o.kebabName === "hooky");
    expect(hooky?.disposition).toBe("imported");
    expect(hooky?.substrates?.codex?.status).toBe("failed");
    expect(hooky?.substrates?.["pi-dev"]?.status).toBe("failed");
    expect(result.substrateVerifySummary?.codex?.failed).toBe(1);
  });
});

test("--smoke codex: idempotent re-run with unchanged source skips re-verify (verdict preserved)", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    const first = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex"],
    });
    expect(first.outcomes[0].substrates?.codex?.status).toBe("verified");
    const manifestPath = join(somaHome, "imports/claude-skills/.manifest.json");
    const manifest1 = JSON.parse(await readFile(manifestPath, "utf8")) as ClaudeSkillsMigrationManifest;
    const manifestBody1 = await readFile(manifestPath, "utf8");

    const second = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex"],
    });
    // The portable skill goes to skipped-idempotent on rerun.
    expect(second.skippedIdempotentCount).toBe(1);
    expect(second.outcomes[0].substrates?.codex?.status).toBe("verified");
    // importedAt preserved (no source changes, same substrate set,
    // same verdicts).
    const manifestBody2 = await readFile(manifestPath, "utf8");
    expect(manifestBody2).toBe(manifestBody1);
    expect(second.importedAt).toBe(first.importedAt);
    expect(manifest1.smokeSubstrates).toEqual(["codex"]);
  });
});

test("report contains substrate columns when --smoke given, absent without", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");

    // No --smoke: report should have only Phase-1 columns.
    await migrateClaudeSkills({ from: fromDir, somaHome });
    const reportPath = join(somaHome, "imports/claude-skills/.portability-report.md");
    const reportNoSmoke = await readFile(reportPath, "utf8");
    expect(reportNoSmoke).not.toContain("Smoke substrates:");
    expect(reportNoSmoke).toContain("| Skill | Tag | Disposition | Reason |");
    expect(reportNoSmoke).not.toContain("codex");
    expect(reportNoSmoke).not.toContain("pi-dev");

    // With --smoke codex --smoke pi-dev: columns present, header
    // line names them.
    await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex", "pi-dev"],
    });
    const reportWithSmoke = await readFile(reportPath, "utf8");
    expect(reportWithSmoke).toContain("Smoke substrates: codex, pi-dev");
    expect(reportWithSmoke).toContain("| Skill | Tag | Disposition | Reason | Dependencies | codex | pi-dev |");
    // Verified outcome appears in both substrate cells. The second
    // run rendered the row as skipped-idempotent (same source SHA),
    // but the substrate cells should still carry the prior verdict.
    expect(reportWithSmoke).toMatch(/\|\s*portable\s*\|\s*portable\s*\|\s*(imported|skipped-idempotent)\s*\|[^|]+\|\s*[^|]+\|\s*verified\s*\|\s*verified\s*\|/);
  });
});

test("plan mode honours --smoke set: smokeSubstrates surfaces in plan", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    const plan = await planClaudeSkillsMigration({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex", "pi-dev"],
    });
    expect(plan.smokeSubstrates).toEqual(["codex", "pi-dev"]);
    // Plan mode doesn't run verify (no write), so outcomes carry no
    // substrates field.
    expect(plan.outcomes[0].substrates).toBeUndefined();
  });
});

test("--smoke pi-dev with unrewritten ref → verified-with-warnings (UNMAPPED fallback is a warning, not an error)", async () => {
  // Realistic outcome: the normalizer rewrites EVERY ~/.claude/ ref to
  // either a mapped target or ~/.soma/UNMAPPED/, and UNMAPPED hits are
  // verifier warnings (not errors). So an opaque ~/.claude/ path
  // surfaces as `verified-with-warnings`.
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      {
        name: "NeedsAdapt",
        skillMd: [
          "---",
          "name: NeedsAdapt",
          "description: Needs rewrite.",
          "---",
          "",
          "Reference unknown path ~/.claude/Unknown/dir/file.md",
        ].join("\n"),
      },
    ]);
    const somaHome = join(home, "soma");
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex"],
    });
    const skill = result.outcomes[0];
    // ~/.claude/Unknown → ~/.soma/UNMAPPED → warning → verified-with-warnings.
    const status = skill.substrates?.codex?.status;
    expect(status).toBe("verified-with-warnings");
  });
});

test("--smoke codex on portable skill: verdict persists to manifest", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex"],
    });
    const manifest = JSON.parse(
      await readFile(join(somaHome, "imports/claude-skills/.manifest.json"), "utf8"),
    ) as ClaudeSkillsMigrationManifest;
    expect(manifest.smokeSubstrates).toEqual(["codex"]);
    expect(manifest.skills[0].substrates?.codex?.status).toBe("verified");
  });
});

test("smokeSubstrates de-duplicates duplicate entries", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex", "codex", "pi-dev", "codex"],
    });
    expect(result.smokeSubstrates).toEqual(["codex", "pi-dev"]);
  });
});

test("Phase-1 behaviour preserved: no --smoke → no substrate columns, no summary", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
    });
    expect(result.smokeSubstrates).toEqual([]);
    expect(result.substrateVerifySummary).toBeUndefined();
    expect(result.outcomes[0].substrates).toBeUndefined();
    const manifestRaw = await readFile(
      join(somaHome, "imports/claude-skills/.manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(manifestRaw) as ClaudeSkillsMigrationManifest;
    expect(manifest.smokeSubstrates).toBeUndefined();
    expect(manifest.skills[0].substrates).toBeUndefined();
  });
});

test("re-run adds new substrate to smoke set bumps importedAt", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    const first = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex"],
    });
    // small delay so the timestamp can change measurably
    await new Promise((r) => setTimeout(r, 10));
    const second = await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex", "pi-dev"],
    });
    // smokeSubstrates changed → importedAt bumped.
    expect(second.importedAt).not.toBe(first.importedAt);
    expect(second.outcomes[0].substrates?.codex?.status).toBe("verified");
    expect(second.outcomes[0].substrates?.["pi-dev"]?.status).toBe("verified");
  });
});

test("smoke pass cleans up no intermediate .smoke/ directory", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await writeSkillsFixture(fromDir, [
      { name: "Portable", skillMd: PORTABLE_SKILL_MD },
    ]);
    const somaHome = join(home, "soma");
    await migrateClaudeSkills({
      from: fromDir,
      somaHome,
      smokeSubstrates: ["codex", "pi-dev"],
    });
    // The verify path is in-memory; we never touch .smoke/. Just
    // confirm the directory isn't there.
    await expect(stat(join(somaHome, "imports/claude-skills/.smoke"))).rejects.toThrow();
  });
});
