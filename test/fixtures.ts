import { expect } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Projection, ProjectionInput } from "../src/index";
import { SECTION_NAME_MAP, renderCriteriaMarkdown } from "../src/vsa-accessors";

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
