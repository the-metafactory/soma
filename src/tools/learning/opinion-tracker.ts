import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathsForLearningOptions } from "./paths";
import type {
  EvidenceType,
  LearningToolOptions,
  Opinion,
  OpinionCategory,
  OpinionEvidence,
  OpinionEvidenceResult,
} from "./types";

const CATEGORIES: OpinionCategory[] = ["communication", "technical", "relationship", "work_style"];
const CONFIDENCE_ADJUSTMENTS: Record<EvidenceType, number> = {
  supporting: 0.02,
  counter: -0.05,
  confirmation: 0.10,
  contradiction: -0.20,
};
const NOTIFICATION_THRESHOLD = 0.15;

function assertEvidenceType(type: EvidenceType): asserts type is EvidenceType {
  if (!Object.hasOwn(CONFIDENCE_ADJUSTMENTS, type)) {
    throw new Error(`Unknown opinion evidence type: ${type}`);
  }
}

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function parseOpinionsMarkdown(content: string): Opinion[] {
  const machineDataIndex = content.indexOf("## Machine Data");
  const machineData = machineDataIndex === -1 ? content : content.slice(machineDataIndex);
  const parsed = machineData.match(/```json\n([\s\S]*?)\n```/);
  if (parsed?.[1]) {
    const value = JSON.parse(parsed[1]) as { opinions?: Opinion[] };
    return Array.isArray(value.opinions) ? value.opinions : [];
  }
  return [];
}

export function formatOpinionsMarkdown(opinions: Opinion[]): string {
  const sorted = [...opinions].sort((a, b) => a.category.localeCompare(b.category) || a.statement.localeCompare(b.statement));
  const grouped = CATEGORIES.map((category) => ({
    category,
    opinions: sorted.filter((opinion) => opinion.category === category),
  }));

  const human = grouped.flatMap(({ category, opinions: categoryOpinions }) => [
    `## ${category} Opinions`,
    "",
    ...(categoryOpinions.length === 0
      ? ["No opinions recorded.", ""]
      : categoryOpinions.flatMap((opinion) => [
        `### ${opinion.statement}`,
        "",
        `- Confidence: ${opinion.confidence.toFixed(2)}`,
        `- Created: ${opinion.created}`,
        `- Last updated: ${opinion.lastUpdated}`,
        `- Evidence: ${opinion.evidence.length}`,
        "",
      ])),
  ]);

  return [
    "# Soma Opinions",
    "",
    "This file is both human-readable and machine-readable. The fenced JSON block is the source of truth.",
    "",
    ...human,
    "## Machine Data",
    "",
    "```json",
    JSON.stringify({ schema: "soma-opinions-v1", opinions: sorted }, null, 2),
    "```",
    "",
  ].join("\n");
}

async function readOpinions(options: LearningToolOptions): Promise<Opinion[]> {
  const paths = pathsForLearningOptions(options);
  const content = await readFile(paths.opinions(), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  return parseOpinionsMarkdown(content);
}

async function writeOpinions(opinions: Opinion[], options: LearningToolOptions): Promise<string> {
  const path = pathsForLearningOptions(options).opinions();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatOpinionsMarkdown(opinions), "utf8");
  return path;
}

async function logRelationshipEvent(options: LearningToolOptions, eventType: string, data: Record<string, unknown>): Promise<void> {
  const now = options.now ?? new Date();
  const paths = pathsForLearningOptions(options);
  const month = now.toISOString().slice(0, 7);
  const date = today(now);
  const dir = join(paths.relationship(), month);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${date}.jsonl`);
  await appendFile(path, `${JSON.stringify({ timestamp: now.toISOString(), event_type: eventType, ...data })}\n`, "utf8");
}

export async function addOpinion(
  statement: string,
  category: OpinionCategory = "relationship",
  options: LearningToolOptions & { initialConfidence?: number } = {},
): Promise<Opinion> {
  if (!statement.trim()) throw new Error("Opinion statement is required.");
  if (/[\r\n]|```/.test(statement)) throw new Error("Opinion statement must be a single Markdown-safe line.");
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown opinion category: ${category}`);
  const opinions = await readOpinions(options);
  const existing = opinions.find((opinion) => opinion.statement.toLowerCase() === statement.toLowerCase());
  if (existing) return existing;

  const now = options.now ?? new Date();
  const opinion: Opinion = {
    statement,
    confidence: options.initialConfidence ?? 0.5,
    category,
    evidence: [],
    created: today(now),
    lastUpdated: today(now),
  };
  opinions.push(opinion);
  await writeOpinions(opinions, options);
  await logRelationshipEvent(options, "opinion_created", { statement, category, confidence: opinion.confidence });
  return opinion;
}

export async function addOpinionEvidence(
  statement: string,
  type: EvidenceType,
  description: string,
  options: LearningToolOptions & { sessionId?: string } = {},
): Promise<OpinionEvidenceResult> {
  if (!description.trim()) throw new Error("Evidence description is required.");
  assertEvidenceType(type);
  const opinions = await readOpinions(options);
  const opinion = opinions.find((candidate) => candidate.statement.toLowerCase() === statement.toLowerCase());
  if (!opinion) throw new Error(`Opinion not found: ${statement}`);

  const oldConfidence = opinion.confidence;
  opinion.confidence = Math.max(0.01, Math.min(0.99, opinion.confidence + CONFIDENCE_ADJUSTMENTS[type]));
  opinion.lastUpdated = today(options.now ?? new Date());
  const evidence: OpinionEvidence = {
    date: opinion.lastUpdated,
    type,
    description,
    sessionId: options.sessionId,
  };
  opinion.evidence.push(evidence);
  await writeOpinions(opinions, options);
  await logRelationshipEvent(options, "opinion_evidence", {
    statement,
    evidence_type: type,
    old_confidence: oldConfidence,
    new_confidence: opinion.confidence,
    description,
  });

  return {
    opinion,
    oldConfidence,
    confidenceChange: opinion.confidence - oldConfidence,
    needsNotification: Math.abs(opinion.confidence - oldConfidence) >= NOTIFICATION_THRESHOLD,
  };
}

export async function listOpinions(options: LearningToolOptions = {}): Promise<Opinion[]> {
  return readOpinions(options);
}

export async function showOpinion(statement: string, options: LearningToolOptions = {}): Promise<Opinion | undefined> {
  const opinions = await readOpinions(options);
  return opinions.find((candidate) => candidate.statement.toLowerCase() === statement.toLowerCase());
}
