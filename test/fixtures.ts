import { expect } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Projection, ProjectionInput } from "../src/index";
import { SECTION_NAME_MAP, renderCriteriaMarkdown } from "../src/vsa-accessors";
import { listBundledSkills } from "../src/bundled-skills";
import { VSA_SKILL_NAME } from "../src/vsa-skill-installer";

/**
 * Repo-bundled portable skills (`src/skills/*` except VSA — the-algorithm,
 * Memory) are copied into the Soma home on install and project as dynamic
 * invocable skill dirs on every substrate. Like the active VSA, they are
 * DELIBERATELY excluded from the static install plan (`spec.homeFiles`), so
 * dry-run==apply tests assert `plan ⊆ apply` and that the only extra files are
 * these bundled-skill projections.
 */
export async function bundledPortableSkillNames(): Promise<string[]> {
  return (await listBundledSkills()).filter((name) => name !== VSA_SKILL_NAME);
}

/**
 * True when `path` is a projected file of a repo-bundled portable skill — a
 * `skills`/`<bundled-name>` segment pair, matched case/separator-insensitively
 * so it holds across substrate skill roots (codex `skills/`, cursor
 * `.cursor/rules/soma/skills/`, pi-dev `agent/skills/<normalized-id>/`).
 */
export function isBundledPortableSkillPath(path: string, names: string[]): boolean {
  const norm = (segment: string) => segment.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const wanted = new Set(names.map(norm));
  const segments = path.replace(/\\/g, "/").split("/");
  return segments.some((segment, index) => segment === "skills" && wanted.has(norm(segments[index + 1] ?? "")));
}

/**
 * Shared dry-run==apply contract for substrates that now project bundled
 * portable skills: every planned file is projected, and every projected file
 * NOT in the plan is a bundled-skill projection (the active VSA and bundled
 * skills are the only dynamic entries; a fresh test home has no active VSA).
 */
export async function expectPlanCoversApplyModuloBundledSkills(
  planFiles: readonly string[],
  applyFiles: readonly string[],
): Promise<void> {
  const names = await bundledPortableSkillNames();
  const normalize = (path: string) => path.replace(/\\/g, "/");
  const planSet = new Set(planFiles.map(normalize));
  const applySet = new Set(applyFiles.map(normalize));
  for (const file of planSet) {
    expect(applySet.has(file)).toBe(true);
  }
  for (const file of applySet) {
    if (planSet.has(file)) continue;
    expect(isBundledPortableSkillPath(file, names)).toBe(true);
  }
}

/**
 * soma#329: prove a renamed projection's stale file is pruned on REPROJECT/
 * UPGRADE, not just first install. `soma reproject`/`upgrade` re-run the same
 * `installSomaFor*` function, so the sequence is: install (real projection) →
 * a legacy `TELOS.md` appears (as if left by a pre-rename version) → install
 * again (= reproject) must delete it while writing the new `PURPOSE.md`.
 */
export async function expectReprojectPrunesStaleTelos(
  substrateRulesDir: string,
  install: () => Promise<unknown>,
): Promise<void> {
  await install();
  const stale = join(substrateRulesDir, "TELOS.md");
  await writeFile(stale, "# Soma Purpose Projection\n\nold frozen content\n", "utf8");
  await install();
  await expect(readFile(join(substrateRulesDir, "PURPOSE.md"), "utf8")).resolves.toContain("# Soma Purpose Projection");
  await expect(stat(stale)).rejects.toThrow();
}

export const portableProjectionInput: ProjectionInput = {
  profile: {
    assistant: {
      name: "soma",
      displayName: "Soma",
      traits: {
        concise: true,
      },
    },
    principal: {
      name: "principal",
      preferredName: "JC",
      profile: {
        timezone: "Europe/Zurich",
      },
    },
    purpose: {
      mission: "Keep personal assistant context portable across substrates.",
      goals: ["Prove context generation across substrates"],
      principles: ["Substrate adapters translate; they do not own core concepts"],
      commitments: ["Keep memory filesystem-native"],
    },
    memory: {
      root: "MEMORY",
      work: "MEMORY/WORK",
      knowledge: "MEMORY/KNOWLEDGE",
      learning: "MEMORY/LEARNING",
      relationship: "MEMORY/RELATIONSHIP",
      state: "MEMORY/STATE",
    },
    skills: [
      {
        name: "Ledger Update",
        path: "skills/ledger-update",
        description: "Update a project ledger from verified work.",
        triggers: ["ledger", "status update"],
      },
    ],
  },
  activeVsa: {
    slug: "portable-context",
    frontmatter: {
      task: "Build substrate context projections from one Soma input.",
      effort: "E3",
      mode: "algorithm",
      phase: "build",
      progress: "0/1",
      verified: false,
      updated: "2026-05-14T10:00:00.000Z",
    },
    sections: [
      { name: SECTION_NAME_MAP.goal, content: "Build substrate context projections from one Soma input." },
      {
        name: SECTION_NAME_MAP.criteria,
        content: renderCriteriaMarkdown([
          {
            id: "ISC-PORTABLE-1",
            text: "Adapters receive assistant identity, telos, memory, skills, and VSA.",
            status: "open",
            verification: "bun test",
          },
        ]),
      },
    ],
  },
};

/**
 * The portable-semantics contract every substrate bundle must satisfy:
 * markers that flow from the shared renderers fed portableProjectionInput.
 * Shared by substrate-adapters.test.ts and the per-adapter suites.
 */
export function expectPortableSemantics(bundle: Projection) {
  expect(bundle.instructions).toContain("Soma");
  expect(bundle.instructions).toContain("Keep personal assistant context portable across substrates.");
  expect(bundle.instructions).toContain("Substrate adapters translate; they do not own core concepts");
  expect(bundle.instructions).toContain("ISC-PORTABLE-1");
  expect(bundle.files.some((file) => file.content.includes("MEMORY/LEARNING"))).toBe(true);
  expect(bundle.files.some((file) => file.content.includes("Ledger Update"))).toBe(true);
  expect(bundle.files.some((file) => file.content.includes("Policy Projection"))).toBe(true);
}
