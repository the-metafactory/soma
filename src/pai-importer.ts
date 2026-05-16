import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ImportSourceCheck, PaiImportOptions, PaiImportPlan, PaiImportResult } from "./types";

type PaiSourceRole = "principal" | "assistant" | "mission" | "goals" | "strategies" | "beliefs";

interface PaiSourceSpec {
  role: PaiSourceRole;
  candidates: readonly string[];
  required: boolean;
}

interface PaiSelectedSource {
  role: PaiSourceRole;
  path: string;
  required: boolean;
  present: boolean;
}

const SOURCE_SPECS: readonly PaiSourceSpec[] = [
  { role: "principal", candidates: ["PAI/USER/PRINCIPAL_IDENTITY.md", "PAI/USER/BASICINFO.md", "PAI/USER/ABOUTME.md"], required: true },
  { role: "assistant", candidates: ["PAI/USER/DA_IDENTITY.md", "PAI/USER/DAIDENTITY.md"], required: true },
  { role: "mission", candidates: ["PAI/USER/TELOS/MISSION.md"], required: true },
  { role: "goals", candidates: ["PAI/USER/TELOS/GOALS.md"], required: true },
  { role: "strategies", candidates: ["PAI/USER/TELOS/STRATEGIES.md"], required: false },
  { role: "beliefs", candidates: ["PAI/USER/TELOS/BELIEFS.md"], required: true },
] as const;

const PROFILE_TARGETS = {
  principal: "profile/principal.md",
  assistant: "profile/assistant.md",
  telos: "profile/telos.md",
} as const;

function resolveHomes(options: PaiImportOptions = {}): { claudeHome: string; somaHome: string } {
  const home = resolve(options.homeDir ?? homedir());

  return {
    claudeHome: resolve(options.claudeHome ?? join(home, ".claude")),
    somaHome: resolve(options.somaHome ?? join(home, ".soma")),
  };
}

function selectedSourceFor(claudeHome: string, spec: PaiSourceSpec): PaiSelectedSource {
  const selected = spec.candidates.find((path) => existsSync(join(claudeHome, path))) ?? spec.candidates[0];

  return {
    role: spec.role,
    path: selected,
    required: spec.required,
    present: existsSync(join(claudeHome, selected)),
  };
}

function inspectPaiSources(claudeHome: string): { selectedSources: PaiSelectedSource[]; sourceChecks: ImportSourceCheck[] } {
  const selectedSources = SOURCE_SPECS.map((spec) => selectedSourceFor(claudeHome, spec));
  const sourceChecks = selectedSources.map((source) => ({
    path: join(claudeHome, source.path),
    required: source.required,
    present: source.present,
  }));

  return { selectedSources, sourceChecks };
}

function importTargetFor(sourcePath: string): string {
  return sourcePath.replace(/^PAI\/USER\//, "profile/imports/claude/");
}

function selectedImportTargetPaths(selectedSources: PaiSelectedSource[]): string[] {
  return [
    PROFILE_TARGETS.principal,
    PROFILE_TARGETS.assistant,
    PROFILE_TARGETS.telos,
    ...selectedSources.filter((source) => source.required || source.present).map((source) => importTargetFor(source.path)),
  ];
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

function renderPrincipalProfile(source: string, sourcePath: string): string {
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
    `Migrated from \`~/.claude/${sourcePath}\`.`,
    `Full source snapshot is kept at \`${importTargetFor(sourcePath)}\`.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderAssistantProfile(source: string, sourcePath: string): string {
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
    `Migrated from \`~/.claude/${sourcePath}\`.`,
    `Full source snapshot is kept at \`${importTargetFor(sourcePath)}\`.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderTelosProfile(sources: Record<string, string>): string {
  return [
    "# Telos",
    "",
    "Mission: Bauen und Erschaffen: Dinge machen, die vorher nicht existierten, Probleme durch Kreation lösen, und anderen durch das Gebaute ermöglichen.",
    "",
    "## Goals",
    "",
    "- Work-Life Balance erreichen: geschützte persönliche Zeit, weniger Verpflichtungen, Qualität über Quantität.",
    "- KAI/PAI weiterentwickeln: Context-Portabilität, Presence Layer und proaktive Intelligenz.",
    "- GFK Practitioner abschliessen.",
    "- Professionelle Verpflichtungen erfüllen: SWITCH, SOC, Kunden-Arbeit, Workshops und Lehre.",
    "",
    "## Principles",
    "",
    "- Autonomie ist der höchste Wert; Entscheidungen, die Freiheit einschränken, sehr genau prüfen.",
    "- Kreativität ist essentiell, nicht optional.",
    "- Multi-faceted ist Stärke: Coder, Musiker, Designer und Dozent sind verbunden durch Bauen und Erschaffen.",
    "- Energie-Management zählt mindestens so stark wie Zeit-Management.",
    "- Ganz Ja oder Ganz Nein; keine halbherzigen Zusagen.",
    "",
    "## Commitments",
    "",
    "- Kapazitäts-Check vor jedem neuen Ja: Was müsste wegfallen?",
    "- Nein zu guten Dingen ist ein Ja zu Gesundheit, Beziehungen und Autonomie.",
    "- Externe Systeme nutzen: robustes externes Gehirn statt internes Arbeitsgedächtnis.",
    "- GFK für authentischen Ausdruck in wichtigen Beziehungssituationen nutzen.",
    "- Den kleinsten Schritt suchen, wenn Überwältigung oder Prokrastination blockieren.",
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
  const { selectedSources, sourceChecks } = inspectPaiSources(homes.claudeHome);
  const targetFiles = selectedImportTargetPaths(selectedSources);

  return {
    apply: false,
    claudeHome: homes.claudeHome,
    somaHome: homes.somaHome,
    sourceFiles: selectedSources.map((source) => join(homes.claudeHome, source.path)),
    sourceChecks,
    targetFiles: targetFiles.map((path) => join(homes.somaHome, path)),
  };
}

export async function importPaiIdentity(options: PaiImportOptions = {}): Promise<PaiImportResult> {
  const homes = resolveHomes(options);
  const { selectedSources } = inspectPaiSources(homes.claudeHome);

  for (const source of selectedSources) {
    if (source.required && !source.present) {
      throw new Error(`Required PAI source file is missing: ${join(homes.claudeHome, source.path)}`);
    }
  }

  const sources = new Map(
    await Promise.all(
      selectedSources
        .filter((source) => source.present)
        .map(async (source) => [
          source.role,
          {
            path: source.path,
            content: await readFile(join(homes.claudeHome, source.path), "utf8"),
          },
        ] as const),
    ),
  );

  const files = new Map<string, string>();
  const principal = sources.get("principal");
  const assistant = sources.get("assistant");

  if (!principal || !assistant) {
    throw new Error("Required PAI identity source selection failed.");
  }

  files.set(PROFILE_TARGETS.principal, renderPrincipalProfile(principal.content, principal.path));
  files.set(PROFILE_TARGETS.assistant, renderAssistantProfile(assistant.content, assistant.path));
  files.set(
    PROFILE_TARGETS.telos,
    renderTelosProfile(
      Object.fromEntries(
        (["mission", "goals", "strategies", "beliefs"] as const)
          .map((role) => sources.get(role))
          .filter((source): source is { path: string; content: string } => source !== undefined)
          .map((source) => [source.path, source.content]),
      ),
    ),
  );

  for (const source of sources.values()) {
    files.set(importTargetFor(source.path), source.content.trimEnd());
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
