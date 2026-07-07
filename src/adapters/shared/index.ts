import { basename } from "node:path";
import type { ProjectionInput, SomaSkill, SubstrateId } from "../../types";
import { getCriteria, getGoal } from "../../vsa-accessors";
import { VSA_SKILL_NAME } from "../../vsa-skill-installer";
import { rewriteSubstrateProjectionContent } from "../../substrate-projection-rewrites";

export { renderAlgorithmRenderingContract } from "./algorithm-rendering-contract";
export {
  OVERLAY_BEGIN,
  OVERLAY_END,
  PROVENANCE_MARKER,
  extractOverlay,
  hasProvenanceHeader,
  provenanceHeader,
  renderOverlay,
  stripProvenance,
  withProvenance,
} from "./provenance";

/**
 * The portable skills a home projection should emit files for. `skills.md`
 * (renderSkills) still lists every skill, but the VSA skill is excluded here:
 * it has a dedicated, managed per-substrate projection (installVsaSkillProjection
 * — baseline tracking, drift detection, skillNameOverride), so re-emitting its
 * files through the generic portable-skill loop would double-write the same
 * bytes that installer owns. Without this, a first install (which reloads the
 * Soma home after writing the VSA baseline) would project VSA twice.
 *
 * The managed VSA skill is identified by BOTH its frontmatter name and its
 * canonical directory basename (`skills/VSA/`). Matching on name alone would
 * let a locally renamed SKILL.md frontmatter slip back into the generic loop
 * and double-write the dedicated projection.
 */
export function projectableSkills(skills: SomaSkill[], bundledNames?: readonly string[]): SomaSkill[] {
  return skills.filter((skill) => {
    // VSA is always excluded (dedicated managed installer) — matched on BOTH
    // frontmatter name and canonical dir basename so a renamed SKILL.md cannot
    // slip its dedicated projection back into the generic loop.
    if (skill.name === VSA_SKILL_NAME || basename(skill.path) === VSA_SKILL_NAME) return false;
    // When install supplies the repo-bundled skill set, project ONLY those
    // (src/skills/*): principal-authored/registry skills reach a substrate
    // through `soma install --skills` symlinks, not this always-on loop, so a 100-skill home
    // projects two bundled dirs, not a hundred, and never collides with the
    // selective symlink flow. Absent (direct projection callers/tests) → legacy
    // behavior: all non-VSA skills, so pure-projection unit tests are unaffected.
    //
    // Matched on `basename(skill.path)` (the on-disk dir the install copied) —
    // the authoritative membership key for the repo bundle — NOT `skill.name`
    // (frontmatter). The projection below still uses `skill.name` for the OUTPUT
    // dir; if a principal edits the home copy's frontmatter name, the projected
    // dir would follow that edit, but bundle membership stays anchored to the
    // repo-owned dir. A SINGLE key suffices here, unlike VSA's two-key guard
    // above, whose second (name) key stops a locally-renamed VSA frontmatter
    // from slipping past its dedicated managed installer.
    if (bundledNames && !bundledNames.includes(basename(skill.path))) return false;
    return true;
  });
}

/**
 * Build the portable-skill projection files an adapter's home projection emits:
 * one `<skillsDirPrefix><skill.name>/<file>` entry per file of each projectable
 * (bundled, non-VSA) skill, with content run through the substrate rewrite.
 * Shared by the four adapters whose loop is identical (claude-code, codex, grok,
 * cursor) — cursor differs only in `skillsDirPrefix`. `substrate` drives
 * `rewriteSubstrateProjectionContent`: `claude-code` is a verbatim passthrough,
 * every other substrate (codex, grok, cursor) takes the memory-root rewrite +
 * Claude-only-line strip. pi-dev is NOT a caller — it normalizes skill names to
 * ids via its own `buildPiDevPortableSkillFiles`.
 */
export function buildPortableSkillFiles(
  skills: SomaSkill[],
  bundledNames: readonly string[] | undefined,
  substrate: SubstrateId,
  options: { skillsDirPrefix?: string } = {},
): { path: string; content: string }[] {
  const prefix = options.skillsDirPrefix ?? "skills/";
  return projectableSkills(skills, bundledNames).flatMap((skill) =>
    (skill.files ?? []).map((file) => ({
      path: `${prefix}${skill.name}/${file.path}`,
      content: rewriteSubstrateProjectionContent({ substrate, path: file.path, content: file.content }),
    })),
  );
}

export function formatList(items: string[]): string {
  return items.length === 0 ? "- None declared" : items.map((item) => `- ${item}`).join("\n");
}

export function formatRecord(record: Record<string, unknown> | undefined): string {
  if (!record || Object.keys(record).length === 0) {
    return "- None declared";
  }

  return Object.entries(record)
    .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

export function renderActiveVsa(input: ProjectionInput): string {
  if (!input.activeVsa) {
    return "No active VSA was provided.";
  }

  const criteria = getCriteria(input.activeVsa)
    .map((criterion) => {
      const verification = criterion.verification ? ` Verification: ${criterion.verification}` : "";
      return `- [${criterion.status}] ${criterion.id}: ${criterion.text}${verification}`;
    })
    .join("\n");

  return [
    `Slug: ${input.activeVsa.slug}`,
    `Phase: ${input.activeVsa.frontmatter.phase}`,
    `Goal: ${getGoal(input.activeVsa) ?? ""}`,
    "",
    "Criteria:",
    criteria || "- None declared",
  ].join("\n");
}

export function renderAssistantCore(input: ProjectionInput): string {
  const { profile } = input;

  return [
    "## Assistant",
    `Name: ${profile.assistant.name}`,
    profile.assistant.displayName ? `Display name: ${profile.assistant.displayName}` : undefined,
    "",
    "Traits:",
    formatRecord(profile.assistant.traits),
    "",
    "## Principal",
    `Name: ${profile.principal.name}`,
    profile.principal.preferredName ? `Preferred name: ${profile.principal.preferredName}` : undefined,
    "",
    "Profile:",
    formatRecord(profile.principal.profile),
    "",
    "## Purpose",
    profile.purpose.mission ? `Mission: ${profile.purpose.mission}` : "Mission: None declared",
    "",
    "Goals:",
    formatList(profile.purpose.goals),
    "",
    "Principles:",
    formatList(profile.purpose.principles),
    "",
    "Commitments:",
    formatList(profile.purpose.commitments),
    "",
    "## Active VSA",
    renderActiveVsa(input),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function renderMemoryLayout(input: ProjectionInput): string {
  const { memory } = input.profile;

  return [
    "# Soma Memory Layout",
    "",
    `Root: ${memory.root}`,
    `Work: ${memory.work}`,
    `Knowledge: ${memory.knowledge}`,
    `Learning: ${memory.learning}`,
    `Relationship: ${memory.relationship}`,
    `State: ${memory.state}`,
  ].join("\n");
}

export const SOMA_SKILLS_HEADING = "# Soma Skills";
export const SOMA_POLICY_PROJECTION_HEADING = "# Soma Policy Projection";

export function renderSkills(input: ProjectionInput): string {
  const skills = input.profile.skills.map((skill) =>
    [`## ${skill.name}`, "", skill.description, "", `Path: ${skill.path}`, "", "Triggers:", formatList(skill.triggers)].join("\n"),
  );

  return [SOMA_SKILLS_HEADING, "", skills.length === 0 ? "No Soma skills were declared." : skills.join("\n\n")].join("\n");
}

export function renderPolicyProjection(substrate: string, enforceable: string[], advisory: string[]): string {
  return [
    SOMA_POLICY_PROJECTION_HEADING,
    "",
    `Substrate: ${substrate}`,
    "",
    "## Enforceable",
    formatList(enforceable),
    "",
    "## Advisory",
    formatList(advisory),
  ].join("\n");
}

/**
 * Standard substrate context instructions shared by adapters whose
 * operating rules are identical (codex, grok). `substrate` is the display
 * name used in the title and execution-substrate line; `runtimeLabel` is
 * the phrase naming the runtime the agent is executing inside (for
 * example "Codex" or "the Grok CLI"). Adapters with diverging rules
 * (cursor, claude-code, pi-dev) keep their own renderers and should adopt
 * this helper only if their rules converge.
 */
export function renderSubstrateInstructions(
  options: { substrate: string; runtimeLabel: string },
  input: ProjectionInput,
): string {
  return [
    `# Soma ${options.substrate} Context`,
    "",
    `You are running inside ${options.runtimeLabel} with Soma-projected assistant context.`,
    "Treat Soma as the source of truth for personal assistant identity, purpose, memory layout, skills, policy, and active VSA context.",
    `Treat ${options.substrate} as the execution substrate. Keep substrate-specific behavior behind adapter boundaries.`,
    "",
    renderAssistantCore(input),
    "",
    "## Operating Rules",
    "- Use the active VSA as the verification contract when present.",
    "- Read memory from the declared file layout before inventing persistent facts.",
    "- Keep personal context out of public templates unless explicitly requested.",
    "- Report verification performed and any substrate limitation encountered.",
  ].join("\n");
}
