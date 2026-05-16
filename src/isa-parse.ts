import type {
  AlgorithmEffortTier,
  AlgorithmMode,
  AlgorithmPhase,
  AuthoredFrontmatter,
  DerivedFrontmatter,
  IdealStateArtifact,
  IsaFrontmatter,
  IsaSection,
} from "./types";
import { getCriteria, progressFromCriteria, verifiedFromCriteria } from "./isa-accessors";

/**
 * Round-trip contract: parseIsa → serializeIsa produces **semantic equivalence**
 * with the original markdown. Byte preservation is a best-effort optimization
 * — when no structural mutation has occurred between parse and serialize,
 * the raw input buffer is reused so whitespace is byte-identical.
 *
 * In-flight Algorithm runs that go through `{ ...isa, ... }` spreads create
 * a new object identity, orphaning the raw-spans cache. Those runs will
 * always get semantic equivalence, never byte preservation. This is expected.
 */

const RAW_INPUT = new WeakMap<IdealStateArtifact, string>();

const AUTHORED_KEYS: ReadonlySet<keyof AuthoredFrontmatter> = new Set([
  "task",
  "effort",
  "mode",
  "iteration",
  "started",
  "algorithm_config",
  "custom",
]);

const DERIVED_KEYS: ReadonlySet<keyof DerivedFrontmatter> = new Set([
  "phase",
  "progress",
  "verified",
  "updated",
]);

const EFFORT_TIERS: readonly AlgorithmEffortTier[] = ["E1", "E2", "E3", "E4", "E5"];
const PHASES: readonly AlgorithmPhase[] = [
  "observe",
  "think",
  "plan",
  "build",
  "execute",
  "verify",
  "learn",
  "complete",
  "abandoned",
];
const MODES: readonly AlgorithmMode[] = ["minimal", "native", "algorithm"];

export function parseIsa(markdown: string, sourcePath?: string): IdealStateArtifact {
  const { frontmatterRaw, body } = splitFrontmatter(markdown);
  const frontmatter = parseFrontmatter(frontmatterRaw);
  const slug = typeof frontmatter.custom?.slug === "string" ? frontmatter.custom.slug : (sourcePath ? slugFromPath(sourcePath) : frontmatter.task || "isa");
  const sections = parseSections(body);
  const isa: IdealStateArtifact = { slug, frontmatter, sections, sourcePath };
  RAW_INPUT.set(isa, markdown);
  return isa;
}

/**
 * If `isa` is the exact identity returned by `parseIsa`, return the raw input
 * verbatim — no structural mutation occurred (the helpers in `isa-accessors`
 * that mutate sections — setSection, updateCriterion, etc. — return a NEW
 * object identity via spread, so the raw cache is only hit for true round-trip
 * read-then-serialize calls).
 *
 * Otherwise (new identity from a spread or hand-constructed), render fresh
 * with derived frontmatter recomputed.
 */
export function serializeIsa(isa: IdealStateArtifact): string {
  const previous = RAW_INPUT.get(isa);
  if (previous !== undefined) {
    return previous;
  }
  const frontmatter = withRecomputedDerived(isa);
  return renderIsa({ ...isa, frontmatter });
}

function renderIsa(isa: IdealStateArtifact): string {
  const fm = renderFrontmatter(isa.frontmatter);
  const body = isa.sections
    .filter((section) => section.content.trim().length > 0)
    .map((section) => renderSection(section))
    .join("\n\n");
  return body.length > 0 ? `${fm}\n\n${body}\n` : `${fm}\n`;
}

function renderSection(section: IsaSection): string {
  const content = section.content.replace(/\s+$/, "");
  return `## ${section.name}\n\n${content}`;
}

function withRecomputedDerived(isa: IdealStateArtifact): IsaFrontmatter {
  const criteria = getCriteria(isa);
  return {
    ...isa.frontmatter,
    progress: progressFromCriteria(criteria),
    verified: verifiedFromCriteria(criteria),
  };
}

interface FrontmatterSplit {
  frontmatterRaw: string;
  body: string;
}

function splitFrontmatter(markdown: string): FrontmatterSplit {
  if (!markdown.startsWith("---\n")) {
    return { frontmatterRaw: "", body: markdown };
  }
  // Scan line by line for a literal "---" closing delimiter line; "---foo"
  // or "------" must NOT match.
  let cursor = 4;
  while (cursor < markdown.length) {
    const lineEnd = markdown.indexOf("\n", cursor);
    const line = lineEnd === -1 ? markdown.slice(cursor) : markdown.slice(cursor, lineEnd);
    if (line === "---") {
      const frontmatterRaw = markdown.slice(4, cursor === 4 ? 4 : cursor - 1);
      const bodyStart = lineEnd === -1 ? markdown.length : lineEnd + 1;
      return { frontmatterRaw, body: markdown.slice(bodyStart) };
    }
    if (lineEnd === -1) break;
    cursor = lineEnd + 1;
  }
  return { frontmatterRaw: "", body: markdown };
}

function parseFrontmatter(raw: string): IsaFrontmatter {
  const yaml = parseYamlObject(raw);
  const authored: AuthoredFrontmatter = {
    task: stringOrEmpty(yaml.task),
    effort: coerceEffort(yaml.effort),
  };
  if (typeof yaml.mode === "string" && (MODES as readonly string[]).includes(yaml.mode)) {
    authored.mode = yaml.mode as AlgorithmMode;
  }
  if (typeof yaml.iteration === "number") authored.iteration = yaml.iteration;
  if (typeof yaml.started === "string") authored.started = yaml.started;
  if (typeof yaml.algorithm_config === "object" && yaml.algorithm_config !== null) {
    authored.algorithm_config = yaml.algorithm_config as Record<string, unknown>;
  }
  if (typeof yaml.custom === "object" && yaml.custom !== null) {
    authored.custom = yaml.custom as Record<string, unknown>;
  }

  const customExtras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(yaml)) {
    if (AUTHORED_KEYS.has(key as keyof AuthoredFrontmatter)) continue;
    if (DERIVED_KEYS.has(key as keyof DerivedFrontmatter)) continue;
    customExtras[key] = value;
  }
  if (Object.keys(customExtras).length > 0) {
    authored.custom = { ...(authored.custom ?? {}), ...customExtras };
  }

  const derived: DerivedFrontmatter = {
    phase: coercePhase(yaml.phase),
    progress: typeof yaml.progress === "string" ? yaml.progress : "0/0",
    verified: yaml.verified === true,
    updated: typeof yaml.updated === "string" ? yaml.updated : new Date().toISOString(),
  };

  return { ...authored, ...derived };
}

function renderFrontmatter(frontmatter: IsaFrontmatter): string {
  const lines: string[] = ["---"];
  for (const key of ["task", "effort", "phase", "progress", "mode", "iteration", "started", "updated", "verified"] as const) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    lines.push(`${key}: ${renderYamlScalar(value)}`);
  }
  if (frontmatter.algorithm_config && Object.keys(frontmatter.algorithm_config).length > 0) {
    lines.push("algorithm_config:");
    for (const [key, value] of Object.entries(frontmatter.algorithm_config)) {
      lines.push(`  ${key}: ${renderYamlScalar(value)}`);
    }
  }
  if (frontmatter.custom) {
    for (const [key, value] of Object.entries(frontmatter.custom)) {
      if (isPlainObject(value)) {
        lines.push(`${key}:`);
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          lines.push(`  ${nestedKey}: ${renderYamlScalar(nestedValue)}`);
        }
      } else {
        lines.push(`${key}: ${renderYamlScalar(value)}`);
      }
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderYamlScalar(value: unknown): string {
  if (typeof value === "string") {
    if (/^[A-Za-z0-9_./:+-]+$/.test(value) && !/^(true|false|null)$/i.test(value)) {
      return value;
    }
    return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

const DANGEROUS_YAML_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isSafeYamlKey(key: string): boolean {
  return !DANGEROUS_YAML_KEYS.has(key);
}

function parseYamlObject(raw: string): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  let currentBlock: Record<string, unknown> | null = null;

  for (const rawLine of raw.split("\n")) {
    if (rawLine.trim().length === 0) continue;
    if (rawLine.startsWith("  ") && currentBlock !== null) {
      const match = /^\s+([^:\s][^:]*?)\s*:\s*(.*)$/.exec(rawLine);
      if (match && isSafeYamlKey(match[1])) currentBlock[match[1]] = parseYamlScalar(match[2]);
      continue;
    }
    const match = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(rawLine);
    if (!match) continue;
    const [, key, valueRaw] = match;
    if (!isSafeYamlKey(key)) {
      currentBlock = null;
      continue;
    }
    if (valueRaw === "") {
      currentBlock = Object.create(null) as Record<string, unknown>;
      result[key] = currentBlock;
      continue;
    }
    currentBlock = null;
    result[key] = parseYamlScalar(valueRaw);
  }
  return result;
}

function parseYamlScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (/^"(.*)"$/.test(trimmed)) {
    return trimmed.slice(1, -1).replaceAll("\\\"", "\"").replaceAll("\\\\", "\\");
  }
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  return trimmed;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function coerceEffort(value: unknown): AlgorithmEffortTier {
  if (typeof value === "string") {
    const normalized = value.toUpperCase();
    if ((EFFORT_TIERS as readonly string[]).includes(normalized)) {
      return normalized as AlgorithmEffortTier;
    }
  }
  return "E1";
}

function coercePhase(value: unknown): AlgorithmPhase {
  if (typeof value === "string" && (PHASES as readonly string[]).includes(value)) {
    return value as AlgorithmPhase;
  }
  return "observe";
}

function parseSections(body: string): readonly IsaSection[] {
  const sections: IsaSection[] = [];
  const lines = body.split("\n");
  let currentName: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (currentName !== null) {
        sections.push({ name: currentName, content: stripBlock(currentContent) });
      }
      currentName = match[1].trim();
      currentContent = [];
    } else if (currentName !== null) {
      currentContent.push(line);
    }
  }
  if (currentName !== null) {
    sections.push({ name: currentName, content: stripBlock(currentContent) });
  }
  return sections;
}

function stripBlock(lines: string[]): string {
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  return lines.join("\n");
}

function slugFromPath(path: string): string {
  const filename = path.split("/").at(-1) ?? "isa";
  return filename.replace(/\.md$/, "");
}
