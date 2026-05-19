import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { isoTimestamp, pathsForLearningOptions, safeFileToken } from "./paths";
import { transcriptContentToText } from "./transcript";
import type { HarvestOptions, HarvestedLearning } from "./types";

const CORRECTION_PATTERNS = [/actually,?\s+/i, /wait,?\s+/i, /no,?\s+i meant/i, /let me clarify/i, /you misunderstood/i];
const ERROR_PATTERNS = [/error:/i, /failed:/i, /exception:/i, /stderr:/i, /command failed/i, /permission denied/i, /not found/i];
const INSIGHT_PATTERNS = [/learned that/i, /realized that/i, /discovered that/i, /key insight/i, /important:/i, /for next time/i, /lesson:/i];
const HARVEST_CONCURRENCY = 4;

interface TranscriptEntry {
  sessionId?: string;
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

export function getLearningCategory(content: string): "SYSTEM" | "ALGORITHM" {
  const text = content.toLowerCase();
  if (/over.?engineer|wrong approach|should have asked|didn't follow|too complex|approach|method|strategy|reasoning/.test(text)) {
    return "ALGORITHM";
  }
  if (/hook|crash|broken|tool|config|deploy|path|typescript|javascript|npm|bun|module|file.*not.*found/.test(text)) {
    return "SYSTEM";
  }
  return "ALGORITHM";
}

export function isLearningCapture(text: string): boolean {
  const indicators = [/problem|issue|bug|error|failed|broken/i, /fixed|solved|resolved|discovered|realized|learned/i, /debug|investigate|root cause/i, /lesson|takeaway|next time/i];
  return indicators.filter((pattern) => pattern.test(text)).length >= 2;
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  return patterns.find((pattern) => pattern.test(text))?.source;
}

export async function discoverSessionFiles(options: HarvestOptions = {}): Promise<string[]> {
  const sessionDir = options.sessionDir ?? pathsForLearningOptions(options).resolve("memory", "STATE", "sessions");
  const entries = await readdir(sessionDir, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map(async (entry) => {
    const path = join(sessionDir, entry.name);
    return { path, mtime: (await stat(path)).mtimeMs };
  }));
  const sorted = files.sort((a, b) => b.mtime - a.mtime);
  if (options.sessionId) return sorted.filter((file) => basename(file.path).includes(options.sessionId!)).map((file) => file.path);
  if (options.all) return sorted.map((file) => file.path);
  return sorted.slice(0, options.recent ?? 10).map((file) => file.path);
}

export async function harvestSessionFile(sessionPath: string): Promise<HarvestedLearning[]> {
  const lines = createInterface({ input: createReadStream(sessionPath, { encoding: "utf8" }), crlfDelay: Infinity });
  const sessionId = safeFileToken(basename(sessionPath, ".jsonl"));
  const learnings: HarvestedLearning[] = [];
  let previousContext = "";

  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    const text = transcriptContentToText(entry.message?.content);
    if (text.length < 20) continue;
    let timestamp: string;
    try {
      timestamp = isoTimestamp(entry.timestamp);
    } catch {
      continue;
    }

    if (entry.type === "user") {
      const match = firstMatch(text, CORRECTION_PATTERNS);
      if (match) learnings.push({ sessionId, timestamp, category: getLearningCategory(text), type: "correction", context: previousContext.slice(0, 200), content: text.slice(0, 500), source: match });
    }
    if (entry.type === "assistant") {
      const error = firstMatch(text, ERROR_PATTERNS);
      if (error && isLearningCapture(text)) learnings.push({ sessionId, timestamp, category: getLearningCategory(text), type: "error", context: previousContext.slice(0, 200), content: text.slice(0, 500), source: error });
      const insight = firstMatch(text, INSIGHT_PATTERNS);
      if (insight) learnings.push({ sessionId, timestamp, category: getLearningCategory(text), type: "insight", context: previousContext.slice(0, 200), content: text.slice(0, 500), source: insight });
    }
    previousContext = text;
  }

  return learnings;
}

function formatLearning(learning: HarvestedLearning): string {
  return `# ${learning.type} learning

**Session:** ${learning.sessionId}
**Timestamp:** ${learning.timestamp}
**Category:** ${learning.category}
**Source:** ${learning.source}

## Context

${learning.context}

## Learning

${learning.content}
`;
}

async function writeLearning(learning: HarvestedLearning, options: HarvestOptions): Promise<string> {
  const paths = pathsForLearningOptions(options);
  const timestamp = isoTimestamp(learning.timestamp);
  const month = timestamp.slice(0, 7);
  const dir = paths.resolve("memory", "LEARNING", learning.category, month);
  await mkdir(dir, { recursive: true });
  const safeTime = timestamp.slice(0, 16).replace(/[:T]/g, "");
  const file = join(dir, `${safeTime}_${learning.type}_${safeFileToken(learning.sessionId).slice(0, 8)}.md`);
  await writeFile(file, formatLearning(learning), "utf8");
  return file;
}

async function mapLimited<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  for (let index = 0; index < items.length; index += limit) {
    results.push(...await Promise.all(items.slice(index, index + limit).map(fn)));
  }
  return results;
}

export async function harvestSessions(options: HarvestOptions = {}): Promise<HarvestedLearning[]> {
  const files = await discoverSessionFiles(options);
  const learnings = (await mapLimited(files, HARVEST_CONCURRENCY, harvestSessionFile)).flat();
  if (options.dryRun) return learnings;
  await mapLimited(learnings, HARVEST_CONCURRENCY, async (learning) => {
    learning.path = await writeLearning(learning, options);
  });
  return learnings;
}
