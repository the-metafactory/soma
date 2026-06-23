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
  // soma#329: Soma's own Purpose compartment file (the source PAI/USER/TELOS/*
  // read paths below keep PAI's name; this is the Soma write target).
  purpose: "profile/purpose.md",
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
    PROFILE_TARGETS.purpose,
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
  const name = firstMatch(source, [/(?:- )?\*\*Name:\*\*\s*([^|\n]+)/, /^Name:\s*(.+)$/m], "principal");
  const pronunciation = firstMatch(source, [/(?:- )?\*\*Pronunciation:\*\*\s*([^|\n]+)/]);
  const location = firstMatch(source, [/(?:- )?\*\*Location:\*\*\s*([^|\n]+)/]);
  const timezone = firstMatch(source, [/(?:- )?\*\*Timezone:\*\*\s*([^|\n]+)/]);
  const role = firstMatch(source, [/(?:- )?\*\*Role:\*\*\s*([^|\n]+)/]);
  const focus = firstMatch(source, [/(?:- )?\*\*Focus:\*\*\s*([^|\n]+)/]);

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
  // Captures stop at `|` or newline; firstMatch() trims the captured value before defaulting.
  const fullName = firstMatch(source, [/(?:- )?\*\*Full Name:\*\*\s*([^|\n]+)/], "Ivy - Personal AI Assistant");
  const name = firstMatch(source, [/(?:- )?\*\*Name:\*\*\s*([^|\n]+)/], "Ivy");
  const displayName = firstMatch(source, [/(?:- )?\*\*Display Name:\*\*\s*([^|\n]+)/], name);
  const color = firstMatch(source, [/(?:- )?\*\*Color:\*\*\s*([^|\n]+)/]);
  const voiceId = firstMatch(source, [/(?:- )?\*\*Voice ID:\*\*\s*([^|\n]+)/]);
  const role = firstMatch(source, [/(?:- )?\*\*Role:\*\*\s*([^|\n]+)/]);
  const environment = firstMatch(source, [/(?:- )?\*\*Operating Environment:\*\*\s*([^|\n]+)/]);

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

function stripMarkdownPrefix(line: string): string {
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^>\s+/, "")
    .trim();
}

function meaningfulMarkdownLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const result: string[] = [];
  let inFrontmatter = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "---" && result.length === 0) {
      inFrontmatter = !inFrontmatter;
      continue;
    }

    if (inFrontmatter || line === "" || line.startsWith("#")) {
      continue;
    }

    const cleaned = stripMarkdownPrefix(line);
    if (cleaned) {
      result.push(cleaned);
    }
  }

  return result;
}

function sourceContent(sources: Record<string, string>, role: PaiSourceRole): string | undefined {
  const spec = SOURCE_SPECS.find((candidate) => candidate.role === role);
  if (!spec) {
    return undefined;
  }

  return Object.entries(sources).find(([path]) => spec.candidates.includes(path))?.[1];
}

function sourceLines(sources: Record<string, string>, role: PaiSourceRole): string[] {
  const source = sourceContent(sources, role);
  return source ? meaningfulMarkdownLines(source) : [];
}

function firstSourceLine(sources: Record<string, string>, role: PaiSourceRole, fallback: string): string {
  return sourceLines(sources, role)[0] ?? fallback;
}

function renderBulletSection(title: string, items: string[]): string[] {
  return [
    `## ${title}`,
    "",
    ...(items.length === 0 ? ["- None declared"] : items.map((item) => `- ${item}`)),
  ];
}

function renderPurposeProfile(sources: Record<string, string>): string {
  const mission = firstSourceLine(sources, "mission", "Imported from Claude PAI TELOS mission.");
  const goals = sourceLines(sources, "goals");
  const principles = sourceLines(sources, "beliefs");
  const commitments = sourceLines(sources, "strategies");

  return [
    "# Purpose",
    "",
    `Mission: ${mission}`,
    "",
    ...renderBulletSection("Goals", goals),
    "",
    ...renderBulletSection("Principles", principles),
    "",
    ...renderBulletSection("Commitments", commitments),
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
    PROFILE_TARGETS.purpose,
    renderPurposeProfile(
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
