import type { SomaContextInput } from "../../types";
import { getCriteria, getGoal } from "../../isa-accessors";

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

export function renderActiveIsa(input: SomaContextInput): string {
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

export function renderAssistantCore(input: SomaContextInput): string {
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

export function renderMemoryLayout(input: SomaContextInput): string {
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

export function renderSkills(input: SomaContextInput): string {
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
