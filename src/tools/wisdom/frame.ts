import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathsForWisdomOptions, safeDomain } from "./paths";
import type { FrameUpdateInput, FrameUpdateResult, WisdomFrame, WisdomFrameSummary, WisdomObservationType, WisdomToolOptions } from "./types";

const SECTION_BY_TYPE: Record<WisdomObservationType, string> = {
  principle: "Crystallized Principles",
  "contextual-rule": "Contextual Rules",
  prediction: "Predictive Model",
  "anti-pattern": "Anti-Patterns",
  evolution: "Evolution Log",
};

function titleCaseDomain(domain: string): string {
  return domain.split(/[-_]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

export function emptyFrameMarkdown(domain: string, now = new Date()): string {
  const title = titleCaseDomain(domain);
  const date = now.toISOString().slice(0, 10);
  return `# ${title} Wisdom Frame

## Crystallized Principles

No crystallized principles recorded.

## Contextual Rules

No contextual rules recorded.

## Predictive Model

No predictions recorded.

## Anti-Patterns

No anti-patterns recorded.

## Cross-Frame Connections

No cross-frame connections recorded.

## Evolution Log

- ${date}: Frame created (type: evolution)

## Metadata

- Observation Count: 0
- Last Crystallized: ${date}
`;
}

function framePath(domain: string, options: WisdomToolOptions): string {
  return join(pathsForWisdomOptions(options).wisdom(), "FRAMES", `${safeDomain(domain)}.md`);
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function readdirIfExists(path: string) {
  return readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
}

function readObservationCount(content: string): number {
  const match = /^- Observation Count:\s*(\d+)/m.exec(content);
  return match ? Number(match[1]) : 0;
}

function readLastUpdated(content: string): string | undefined {
  return (/^- Last Crystallized:\s*(\d{4}-\d{2}-\d{2})/m.exec(content))?.[1];
}

function sectionBullet(type: WisdomObservationType, observation: string, date: string): string {
  if (type === "principle") return `- [CRYSTAL] ${observation}`;
  if (type === "evolution") return `- ${date}: ${observation} (type: evolution)`;
  return `- ${observation}`;
}

function appendToSection(content: string, section: string, bullet: string): string {
  const heading = `## ${section}`;
  const index = content.indexOf(heading);
  if (index === -1) return `${content.trim()}\n\n${heading}\n\n${bullet}\n`;

  const start = index + heading.length;
  const next = content.slice(start).search(/\n## /);
  const end = next === -1 ? content.length : start + next;
  const before = content.slice(0, start);
  const body = content.slice(start, end).replace(/\nNo [^\n]+ recorded\.\n?/i, "\n");
  const after = content.slice(end);
  return `${before}${body.trimEnd()}\n${bullet}\n${after}`;
}

function updateMetadata(content: string, count: number, date: string): string {
  return content
    .replace(/^- Observation Count:\s*\d+/m, `- Observation Count: ${count}`)
    .replace(/^- Last Crystallized:\s*\d{4}-\d{2}-\d{2}/m, `- Last Crystallized: ${date}`);
}

export function parseWisdomFrame(domain: string, path: string, content: string): WisdomFrame {
  const principles = [...content.matchAll(/\[CRYSTAL\]\s*(.+)/g)].map((match) => match[1].trim());
  return {
    domain,
    path,
    content,
    observationCount: readObservationCount(content),
    lastUpdated: readLastUpdated(content),
    principles,
  };
}

export async function readWisdomFrame(domain: string, options: WisdomToolOptions = {}): Promise<WisdomFrame | undefined> {
  const safe = safeDomain(domain);
  const path = framePath(safe, options);
  const content = await readFileIfExists(path);
  return content === undefined ? undefined : parseWisdomFrame(safe, path, content);
}

export async function readAllWisdomFrames(options: WisdomToolOptions = {}): Promise<WisdomFrame[]> {
  const framesDir = join(pathsForWisdomOptions(options).wisdom(), "FRAMES");
  const entries = await readdirIfExists(framesDir);
  const frames = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map(async (entry) => {
      const domain = safeDomain(basename(entry.name, ".md"));
      const path = join(framesDir, entry.name);
      const content = await readFile(path, "utf8");
      return parseWisdomFrame(domain, path, content);
    }));
  return frames.sort((a, b) => a.domain.localeCompare(b.domain));
}

export async function listFrames(options: WisdomToolOptions = {}): Promise<WisdomFrameSummary[]> {
  return (await readAllWisdomFrames(options)).map((frame) => ({
    domain: frame.domain,
    path: frame.path,
    observationCount: frame.observationCount,
    lastUpdated: frame.lastUpdated,
  }));
}

export async function updateFrame(input: FrameUpdateInput): Promise<FrameUpdateResult> {
  const domain = safeDomain(input.domain);
  if (!input.observation.trim()) throw new Error("Wisdom observation is required.");
  if (!(input.type in SECTION_BY_TYPE)) throw new Error(`Unknown wisdom observation type: ${input.type}`);

  const path = framePath(domain, input);
  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const existing = await readFileIfExists(path);
  const created = existing === undefined;
  const base = existing ?? emptyFrameMarkdown(domain, now);
  const nextCount = readObservationCount(base) + 1;
  let content = appendToSection(base, SECTION_BY_TYPE[input.type], sectionBullet(input.type, input.observation.trim(), date));
  if (input.type !== "evolution") {
    content = appendToSection(content, "Evolution Log", `- ${date}: ${input.observation.trim()} (type: ${input.type})`);
  }
  content = updateMetadata(content, nextCount, date);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return { domain, path, created, observationCount: nextCount };
}
