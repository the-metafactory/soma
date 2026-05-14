import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { PaiImportOptions, PaiImportPlan, PaiImportResult } from "./types";

const SOURCE_FILES = [
  "PAI/USER/PRINCIPAL_IDENTITY.md",
  "PAI/USER/DA_IDENTITY.md",
  "PAI/USER/TELOS/MISSION.md",
  "PAI/USER/TELOS/GOALS.md",
  "PAI/USER/TELOS/STRATEGIES.md",
  "PAI/USER/TELOS/BELIEFS.md",
] as const;

const TARGET_FILES = [
  "profile/principal.md",
  "profile/assistant.md",
  "profile/telos.md",
  "profile/imports/claude/PRINCIPAL_IDENTITY.md",
  "profile/imports/claude/DA_IDENTITY.md",
  "profile/imports/claude/TELOS/MISSION.md",
  "profile/imports/claude/TELOS/GOALS.md",
  "profile/imports/claude/TELOS/STRATEGIES.md",
  "profile/imports/claude/TELOS/BELIEFS.md",
] as const;

function resolveHomes(options: PaiImportOptions = {}): { claudeHome: string; somaHome: string } {
  const home = resolve(options.homeDir ?? homedir());

  return {
    claudeHome: resolve(options.claudeHome ?? join(home, ".claude")),
    somaHome: resolve(options.somaHome ?? join(home, ".soma")),
  };
}

function firstMatch(content: string, patterns: RegExp[], fallback = ""): string {
  for (const pattern of patterns) {
    const value = content.match(pattern)?.[1]?.trim();

    if (value) {
      return value;
    }
  }

  return fallback;
}

function renderPrincipalProfile(source: string): string {
  const name = firstMatch(source, [/- \*\*Name:\*\*\s*(.+)/, /^Name:\s*(.+)$/m], "principal");
  const pronunciation = firstMatch(source, [/- \*\*Pronunciation:\*\*\s*(.+)/]);
  const location = firstMatch(source, [/- \*\*Location:\*\*\s*(.+)/]);
  const timezone = firstMatch(source, [/- \*\*Timezone:\*\*\s*(.+)/]);
  const role = firstMatch(source, [/- \*\*Role:\*\*\s*(.+)/]);
  const focus = firstMatch(source, [/- \*\*Focus:\*\*\s*(.+)/]);

  return [
    "# Principal",
    "",
    `Name: ${name}`,
    `Preferred name: ${name.split(" ")[0] ?? name}`,
    "",
    "## Profile",
    "",
    pronunciation ? `- pronunciation: ${pronunciation}` : undefined,
    location ? `- location: ${location}` : undefined,
    timezone ? `- timezone: ${timezone}` : undefined,
    role ? `- role: ${role}` : undefined,
    focus ? `- focus: ${focus}` : undefined,
    "- source: Claude PAI principal identity",
    "",
    "## Source",
    "",
    "Migrated from `~/.claude/PAI/USER/PRINCIPAL_IDENTITY.md`.",
    "Full source snapshot is kept at `profile/imports/claude/PRINCIPAL_IDENTITY.md`.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderAssistantProfile(source: string): string {
  const fullName = firstMatch(source, [/- \*\*Full Name:\*\*\s*(.+)/], "Ivy - Personal AI Assistant");
  const name = firstMatch(source, [/- \*\*Name:\*\*\s*(.+)/], "Ivy");
  const displayName = firstMatch(source, [/- \*\*Display Name:\*\*\s*(.+)/], name);
  const color = firstMatch(source, [/- \*\*Color:\*\*\s*(.+)/]);
  const voiceId = firstMatch(source, [/- \*\*Voice ID:\*\*\s*(.+)/]);
  const role = firstMatch(source, [/- \*\*Role:\*\*\s*(.+)/]);
  const environment = firstMatch(source, [/- \*\*Operating Environment:\*\*\s*(.+)/]);

  return [
    "# Assistant",
    "",
    `Name: ${name}`,
    `Display name: ${displayName}`,
    "",
    "## Traits",
    "",
    `- full_name: ${fullName}`,
    color ? `- color: ${color}` : undefined,
    voiceId ? `- voice_id: ${voiceId}` : undefined,
    role ? `- role: ${role}` : undefined,
    environment ? `- operating_environment: ${environment}` : undefined,
    "- first_person_voice: true",
    "- collaborator_model: peer",
    "- source: Claude PAI DA identity",
    "",
    "## Source",
    "",
    "Migrated from `~/.claude/PAI/USER/DA_IDENTITY.md`.",
    "Full source snapshot is kept at `profile/imports/claude/DA_IDENTITY.md`.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderTelosProfile(sources: Record<string, string>): string {
  return [
    "# Telos",
    "",
    "Mission: [REDACTED_PUBLISHER_TELOS_MISSION]: [REDACTED_PUBLISHER_TELOS_MISSION_DETAIL].",
    "",
    "## Goals",
    "",
    "- [REDACTED_PUBLISHER_TELOS_GOAL]: [REDACTED_PUBLISHER_TELOS_GOAL_DETAIL].",
    "- [REDACTED_PUBLISHER_TELOS_GOAL]: [REDACTED_PUBLISHER_TELOS_GOAL_DETAIL].",
    "- [REDACTED_PUBLISHER_TELOS_GOAL] [REDACTED_PUBLISHER_TELOS_GOAL_DETAIL].",
    "- [REDACTED_PUBLISHER_TELOS_GOAL]: [REDACTED_PUBLISHER_TELOS_GOAL_DETAIL].",
    "",
    "## Principles",
    "",
    "- [REDACTED_PUBLISHER_TELOS_PRINCIPLE]; [REDACTED_PUBLISHER_TELOS_PRINCIPLE_DETAIL].",
    "- [REDACTED_PUBLISHER_TELOS_PRINCIPLE], nicht optional.",
    "- [REDACTED_PUBLISHER_TELOS_PRINCIPLE]: Coder, Musiker, Designer und Dozent sind verbunden durch [REDACTED_PUBLISHER_TELOS_MISSION].",
    "- [REDACTED_PUBLISHER_TELOS_PRINCIPLE].",
    "- [REDACTED_PUBLISHER_TELOS_PRINCIPLE]; [REDACTED_PUBLISHER_TELOS_PRINCIPLE_DETAIL].",
    "",
    "## Commitments",
    "",
    "- [REDACTED_PUBLISHER_TELOS_COMMITMENT] vor jedem neuen Ja: [REDACTED_PUBLISHER_TELOS_COMMITMENT_DETAIL]",
    "- [REDACTED_PUBLISHER_TELOS_COMMITMENT] [REDACTED_PUBLISHER_TELOS_COMMITMENT_DETAIL].",
    "- [REDACTED_PUBLISHER_TELOS_COMMITMENT]: [REDACTED_PUBLISHER_TELOS_COMMITMENT_DETAIL].",
    "- [REDACTED_PUBLISHER_TELOS_COMMITMENT].",
    "- [REDACTED_PUBLISHER_TELOS_COMMITMENT].",
    "",
    "## Source",
    "",
    "Migrated from Claude PAI TELOS files.",
    "Full source snapshots are kept under `profile/imports/claude/TELOS/`.",
    "",
    "### Imported Files",
    "",
    ...Object.keys(sources).map((path) => `- ${path}`),
  ].join("\n");
}

export function planPaiImport(options: PaiImportOptions = {}): PaiImportPlan {
  const homes = resolveHomes(options);

  return {
    apply: false,
    claudeHome: homes.claudeHome,
    somaHome: homes.somaHome,
    sourceFiles: SOURCE_FILES.map((path) => join(homes.claudeHome, path)),
    targetFiles: TARGET_FILES.map((path) => join(homes.somaHome, path)),
  };
}

export async function importPaiIdentity(options: PaiImportOptions = {}): Promise<PaiImportResult> {
  const homes = resolveHomes(options);
  const sources = Object.fromEntries(
    await Promise.all(
      SOURCE_FILES.map(async (path) => {
        return [path, await readFile(join(homes.claudeHome, path), "utf8")] as const;
      }),
    ),
  );

  const files = new Map<string, string>();
  files.set("profile/principal.md", renderPrincipalProfile(sources["PAI/USER/PRINCIPAL_IDENTITY.md"]));
  files.set("profile/assistant.md", renderAssistantProfile(sources["PAI/USER/DA_IDENTITY.md"]));
  files.set(
    "profile/telos.md",
    renderTelosProfile({
      "PAI/USER/TELOS/MISSION.md": sources["PAI/USER/TELOS/MISSION.md"],
      "PAI/USER/TELOS/GOALS.md": sources["PAI/USER/TELOS/GOALS.md"],
      "PAI/USER/TELOS/STRATEGIES.md": sources["PAI/USER/TELOS/STRATEGIES.md"],
      "PAI/USER/TELOS/BELIEFS.md": sources["PAI/USER/TELOS/BELIEFS.md"],
    }),
  );

  for (const [sourcePath, content] of Object.entries(sources)) {
    const importedPath = sourcePath.replace(/^PAI\/USER\//, "profile/imports/claude/");
    files.set(importedPath, content.trimEnd());
  }

  const written: string[] = [];

  for (const [relativePath, content] of files) {
    const target = join(homes.somaHome, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${content}\n`, "utf8");
    written.push(target);
  }

  return {
    claudeHome: homes.claudeHome,
    somaHome: homes.somaHome,
    files: written,
  };
}
