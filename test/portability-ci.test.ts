import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { verifySubstrateProjection } from "../src/claude-skills-substrate-verify";
import {
  bootstrapSomaHome,
  buildClaudeCodeHomeProjection,
  buildCodexHomeProjection,
  buildCursorHomeProjection,
  buildPiDevHomeProjection,
  loadActiveIsaForBundle,
  loadSomaHome,
  projectClaudeCode,
  projectCodex,
  projectCursor,
  projectPiDev,
  recordIsaDecision,
  scaffoldIsa,
  setActiveIsa,
  type Projection,
} from "../src/index";
import type { ClaudeSkillsSmokeSubstrate, ProjectionInput, SomaSkill } from "../src/types";
import { portableProjectionInput } from "./fixtures";

const PORTABLE_NEEDLES = [
  "Soma",
  "JC",
  "Keep personal assistant context portable across substrates.",
  "Substrate adapters translate; they do not own core concepts",
  "MEMORY/LEARNING",
  "Ledger Update",
  "ISC-PORTABLE-1",
] as const;

function projectionText(bundle: Projection): string {
  return [bundle.instructions, ...bundle.files.map((file) => file.content)].join("\n\n");
}

function expectPortableNeedles(bundle: Projection): void {
  const text = projectionText(bundle);
  for (const needle of PORTABLE_NEEDLES) {
    expect(text).toContain(needle);
  }
}

function portableSkill(): SomaSkill {
  return {
    name: "Ledger Update",
    path: "skills/ledger-update",
    description: "Update a project ledger from verified work.",
    triggers: ["ledger", "status update"],
    files: [
      {
        path: "SKILL.md",
        content: [
          "---",
          "name: Ledger Update",
          "description: Update a project ledger from verified work.",
          "---",
          "",
          "# Ledger Update",
          "",
          "Read the active ISA, collect verified changes, and append a concise ledger entry.",
        ].join("\n"),
      },
    ],
  };
}

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-portability-ci-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function loadProjectionInput(homeDir: string): Promise<ProjectionInput> {
  const { somaHome } = await bootstrapSomaHome({ homeDir });
  const context = await loadSomaHome(somaHome);
  return {
    ...context,
    activeIsa: (await loadActiveIsaForBundle({ homeDir })) ?? undefined,
  };
}

function buildShippingHomeBundles(input: ProjectionInput, homeDir: string): Projection[] {
  return [
    buildCodexHomeProjection(input, { homeDir }).bundle,
    buildPiDevHomeProjection(input, { homeDir }).bundle,
    buildClaudeCodeHomeProjection(input, { homeDir }).bundle,
    buildCursorHomeProjection(input, { homeDir }).bundle,
  ];
}

test("portability CI: project projections preserve the same semantic content", () => {
  const bundles = [
    projectCodex(portableProjectionInput),
    projectPiDev(portableProjectionInput),
    projectClaudeCode(portableProjectionInput),
    projectCursor(portableProjectionInput),
  ];

  for (const bundle of bundles) {
    expectPortableNeedles(bundle);
  }
});

test("portability CI: portable skills pass static smoke verification for CI-supported substrates", () => {
  const skill = portableSkill();
  const substrates: ClaudeSkillsSmokeSubstrate[] = ["codex", "pi-dev"];

  for (const substrate of substrates) {
    const result = verifySubstrateProjection({
      skill,
      substrate,
      sourceDescription: skill.description,
    });
    expect(result.status).toBe("verified");
    expect(result.reason).toBe("ok");
    expect(result.issues).toHaveLength(0);
  }
});

test("portability CI: project, writeback, and reproject keep active ISA state consistent", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await scaffoldIsa({
      homeDir,
      slug: "portability-ci",
      goal: "Keep projections consistent across adapters.",
      effort: "E2",
      initialCriteria: [{ id: "ISC-CI-1", text: "Projection round-trip is deterministic.", status: "open" }],
    });
    await setActiveIsa("portability-ci", { homeDir });

    const before = await loadProjectionInput(homeDir);
    for (const bundle of buildShippingHomeBundles(before, homeDir)) {
      expect(projectionText(bundle)).toContain("ISC-CI-1");
    }

    await recordIsaDecision(
      "portability-ci",
      "2026-05-19T22:40:00.000Z | build | CI portability writeback recorded.",
      { homeDir, timestamp: "2026-05-19T22:40:00.000Z", phase: "build" },
    );

    const after = await loadProjectionInput(homeDir);
    for (const bundle of buildShippingHomeBundles(after, homeDir)) {
      const text = projectionText(bundle);
      expect(text).toContain("ISC-CI-1");
      expect(text).toContain("CI portability writeback recorded.");
    }
  });
});
