import { basename } from "node:path";
import type { ProjectionInput, SomaSkill } from "../../types";
import { getCriteria, getGoal } from "../../isa-accessors";
import { ISA_SKILL_NAME } from "../../isa-skill-installer";

/**
 * The portable skills a home projection should emit files for. `skills.md`
 * (renderSkills) still lists every skill, but the ISA skill is excluded here:
 * it has a dedicated, managed per-substrate projection (installIsaSkillProjection
 * — baseline tracking, drift detection, skillNameOverride), so re-emitting its
 * files through the generic portable-skill loop would double-write the same
 * bytes that installer owns. Without this, a first install (which reloads the
 * Soma home after writing the ISA baseline) would project ISA twice.
 *
 * The managed ISA skill is identified by BOTH its frontmatter name and its
 * canonical directory basename (`skills/ISA/`). Matching on name alone would
 * let a locally renamed SKILL.md frontmatter slip back into the generic loop
 * and double-write the dedicated projection.
 */
export function projectableSkills(skills: SomaSkill[]): SomaSkill[] {
  return skills.filter(
    (skill) => skill.name !== ISA_SKILL_NAME && basename(skill.path) !== ISA_SKILL_NAME,
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

export function renderActiveIsa(input: ProjectionInput): string {
  if (!input.activeIsa) {
    return "No active ISA was provided.";
  }

  const criteria = getCriteria(input.activeIsa)
    .map((criterion) => {
      const verification = criterion.verification ? ` Verification: ${criterion.verification}` : "";
      return `- [${criterion.status}] ${criterion.id}: ${criterion.text}${verification}`;
    })
    .join("\n");

  return [
    `Slug: ${input.activeIsa.slug}`,
    `Phase: ${input.activeIsa.frontmatter.phase}`,
    `Goal: ${getGoal(input.activeIsa) ?? ""}`,
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
    "## Telos",
    profile.telos.mission ? `Mission: ${profile.telos.mission}` : "Mission: None declared",
    "",
    "Goals:",
    formatList(profile.telos.goals),
    "",
    "Principles:",
    formatList(profile.telos.principles),
    "",
    "Commitments:",
    formatList(profile.telos.commitments),
    "",
    "## Active ISA",
    renderActiveIsa(input),
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

export function renderSkills(input: ProjectionInput): string {
  const skills = input.profile.skills.map((skill) =>
    [`## ${skill.name}`, "", skill.description, "", `Path: ${skill.path}`, "", "Triggers:", formatList(skill.triggers)].join("\n"),
  );

  return ["# Soma Skills", "", skills.length === 0 ? "No Soma skills were declared." : skills.join("\n\n")].join("\n");
}

export function renderPolicyProjection(substrate: string, enforceable: string[], advisory: string[]): string {
  return [
    "# Soma Policy Projection",
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
