import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readAllWisdomFrames } from "./frame";
import { pathsForWisdomOptions } from "./paths";
import type { CrossFramePrinciple, FrameHealth, WisdomFrame, WisdomSynthesisResult, WisdomToolOptions } from "./types";

function principleWords(principle: string): Set<string> {
  return new Set((principle.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
    .filter((word) => !["the", "and", "for", "with", "that", "this", "from", "into"].includes(word)));
}

interface ScoredPrinciple {
  text: string;
  words: Set<string>;
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

export function jaccardSimilarity(left: string, right: string): number {
  const a = principleWords(left);
  const b = principleWords(right);
  return similarity(a, b);
}

function daysSince(date: string | undefined, now: Date): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - parsed.getTime()) / 86_400_000);
}

export function assessFrameHealth(frame: WisdomFrame, now = new Date()): FrameHealth {
  const age = daysSince(frame.lastUpdated, now);
  const status = age <= 7 && frame.observationCount >= 10 ? "growing" : age <= 30 ? "stable" : "stale";
  return { domain: frame.domain, status, observationCount: frame.observationCount, lastUpdated: frame.lastUpdated };
}

function synthesizeFramePair(left: WisdomFrame, right: WisdomFrame, threshold: number): CrossFramePrinciple[] {
  const principles: CrossFramePrinciple[] = [];
  const leftPrinciples = left.principles.map((text): ScoredPrinciple => ({ text, words: principleWords(text) }));
  const rightPrinciples = right.principles.map((text): ScoredPrinciple => ({ text, words: principleWords(text) }));
  for (const leftPrinciple of leftPrinciples) {
    for (const rightPrinciple of rightPrinciples) {
      const score = similarity(leftPrinciple.words, rightPrinciple.words);
      if (score >= threshold) {
        principles.push({
          domains: [left.domain, right.domain].sort((a, b) => a.localeCompare(b)),
          principle: leftPrinciple.text.length <= rightPrinciple.text.length ? leftPrinciple.text : rightPrinciple.text,
          similarity: score,
        });
      }
    }
  }
  return principles;
}

export function synthesizeCrossFramePrinciples(frames: WisdomFrame[], threshold = 0.3): CrossFramePrinciple[] {
  const principles: CrossFramePrinciple[] = [];
  for (let leftIndex = 0; leftIndex < frames.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < frames.length; rightIndex += 1) {
      principles.push(...synthesizeFramePair(frames[leftIndex], frames[rightIndex], threshold));
    }
  }
  return principles.sort((a, b) => b.similarity - a.similarity || a.domains.join(",").localeCompare(b.domains.join(",")));
}

export function normalizeSimilarityThreshold(value: number | undefined, label = "similarityThreshold"): number {
  if (value === undefined) return 0.3;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1.`);
  }
  return value;
}

function renderPrinciples(result: WisdomSynthesisResult, now: Date): string {
  return `# Verified Cross-Frame Wisdom Principles

Generated: ${now.toISOString().slice(0, 10)}

${result.principles.length === 0 ? "No cross-frame principles met the verification threshold." : result.principles.map((principle) =>
    `- [${principle.domains.join(" + ")}] ${principle.principle} (similarity ${principle.similarity.toFixed(2)})`,
  ).join("\n")}
`;
}

function renderHealth(result: WisdomSynthesisResult, now: Date): string {
  return `# Wisdom Frame Health

Generated: ${now.toISOString().slice(0, 10)}

${result.health.map((health) =>
    `- ${health.domain}: ${health.status} (${health.observationCount} observations, last updated ${health.lastUpdated ?? "unknown"})`,
  ).join("\n")}
`;
}

export async function synthesizeWisdom(options: WisdomToolOptions & { dryRun?: boolean; healthOnly?: boolean } = {}): Promise<WisdomSynthesisResult> {
  const now = options.now ?? new Date();
  const frames = await readAllWisdomFrames(options);
  const threshold = normalizeSimilarityThreshold(options.similarityThreshold);
  const result: WisdomSynthesisResult = {
    principles: options.healthOnly ? [] : synthesizeCrossFramePrinciples(frames, threshold),
    health: frames.map((frame) => assessFrameHealth(frame, now)),
  };

  if (options.dryRun) return result;

  const root = pathsForWisdomOptions(options).wisdom();
  const healthPath = join(root, "META", "frame-health.md");
  await mkdir(dirname(healthPath), { recursive: true });
  await writeFile(healthPath, renderHealth(result, now), "utf8");
  result.healthPath = healthPath;

  if (!options.healthOnly) {
    const principlesPath = join(root, "PRINCIPLES", "verified.md");
    await mkdir(dirname(principlesPath), { recursive: true });
    await writeFile(principlesPath, renderPrinciples(result, now), "utf8");
    result.principlesPath = principlesPath;
  }

  return result;
}
