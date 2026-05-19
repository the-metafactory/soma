import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathsForLearningOptions } from "./paths";
import type { LearningToolOptions, PatternGroup, Rating, SynthesisResult } from "./types";

const FRUSTRATION_PATTERNS: Record<string, RegExp> = {
  "Time/Performance Issues": /time|slow|delay|hang|wait|long|minutes|hours|performance/i,
  "Incomplete Work": /incomplete|missing|partial|didn't finish|not done|unfinished/i,
  "Wrong Approach": /wrong|incorrect|not what|misunderstand|mistake|wrong direction/i,
  "Over-engineering": /over-?engineer|too complex|unnecessary|bloat/i,
  "Tool/System Failures": /fail|error|broken|crash|bug|issue|tool/i,
  "Communication Problems": /unclear|confus|didn't ask|should have asked/i,
  "Repetitive Issues": /again|repeat|still|same problem/i,
};

const SUCCESS_PATTERNS: Record<string, RegExp> = {
  "Quick Resolution": /quick|fast|efficient|smooth/i,
  "Good Understanding": /understood|clear|exactly|perfect/i,
  "Proactive Help": /proactive|anticipat|helpful|above and beyond/i,
  "Clean Implementation": /clean|simple|elegant|well done/i,
};

const RECOMMENDATION_RULES = [
  { pattern: "Time/Performance Issues", recommendation: "Set clearer time expectations and give progress updates on long tasks." },
  { pattern: "Wrong Approach", recommendation: "Restate the intended approach before starting ambiguous implementation work." },
  { pattern: "Over-engineering", recommendation: "Default to the smallest complete solution before adding abstraction." },
  { pattern: "Communication Problems", recommendation: "Ask targeted clarifying questions when requirements conflict or are underspecified." },
];

export function parseRatingsJsonl(content: string): Rating[] {
  return content.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Rating)
    .filter((rating) => Number.isFinite(rating.rating) && typeof rating.sentiment_summary === "string");
}

async function readRatings(options: LearningToolOptions): Promise<Rating[]> {
  const paths = pathsForLearningOptions(options);
  const content = await readFile(paths.ratings(), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  return parseRatingsJsonl(content);
}

function detectPatterns(ratings: Rating[], patterns: Record<string, RegExp>): PatternGroup[] {
  return Object.entries(patterns)
    .map(([pattern, matcher]) => {
      const matches = ratings.filter((rating) => matcher.test(`${rating.sentiment_summary} ${rating.comment ?? ""}`));
      const avgRating = matches.length === 0 ? 0 : matches.reduce((sum, rating) => sum + rating.rating, 0) / matches.length;
      const avgConfidence = matches.length === 0
        ? 0
        : matches.reduce((sum, rating) => sum + (rating.confidence ?? 0.5), 0) / matches.length;
      return {
        pattern,
        count: matches.length,
        avgRating,
        avgConfidence,
        examples: matches.slice(0, 3).map((rating) => rating.sentiment_summary),
      };
    })
    .filter((group) => group.count > 0)
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}

export function analyzeRatings(ratings: Rating[], period: SynthesisResult["period"]): SynthesisResult {
  const avgRating = ratings.length === 0 ? 0 : ratings.reduce((sum, rating) => sum + rating.rating, 0) / ratings.length;
  const frustrations = detectPatterns(ratings.filter((rating) => rating.rating <= 4), FRUSTRATION_PATTERNS);
  const successes = detectPatterns(ratings.filter((rating) => rating.rating >= 7), SUCCESS_PATTERNS);
  const topIssues = frustrations.slice(0, 3)
    .map((group) => `${group.pattern} (${group.count} occurrences, avg rating ${group.avgRating.toFixed(1)})`);
  const recommendations: string[] = [];

  for (const rule of RECOMMENDATION_RULES) {
    if (frustrations.some((group) => group.pattern === rule.pattern)) recommendations.push(rule.recommendation);
  }
  if (recommendations.length === 0) {
    recommendations.push("Continue current patterns; no recurring issue crossed the synthesis threshold.");
  }

  return { period, totalRatings: ratings.length, avgRating, frustrations, successes, topIssues, recommendations };
}

export function formatSynthesisReport(result: SynthesisResult, generatedAt = new Date()): string {
  const lines = [
    "# Learning Pattern Synthesis",
    "",
    `**Period:** ${result.period}`,
    `**Generated:** ${generatedAt.toISOString().slice(0, 10)}`,
    `**Total Ratings:** ${result.totalRatings}`,
    `**Average Rating:** ${result.avgRating.toFixed(1)}/10`,
    "",
    "## Top Issues",
    "",
    result.topIssues.length > 0 ? result.topIssues.map((issue, index) => `${index + 1}. ${issue}`).join("\n") : "No significant issues detected",
    "",
    "## Frustration Patterns",
    "",
    formatGroups(result.frustrations),
    "## Success Patterns",
    "",
    formatGroups(result.successes),
    "## Recommendations",
    "",
    result.recommendations.map((recommendation, index) => `${index + 1}. ${recommendation}`).join("\n"),
    "",
    "## Contract",
    "",
    "Input ratings come from `memory/LEARNING/SIGNALS/ratings.jsonl` using the Soma ratings JSONL contract.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function formatGroups(groups: PatternGroup[]): string {
  if (groups.length === 0) return "No patterns detected\n";
  return groups.map((group) => [
    `### ${group.pattern}`,
    "",
    `- Occurrences: ${group.count}`,
    `- Average rating: ${group.avgRating.toFixed(1)}`,
    `- Average confidence: ${group.avgConfidence.toFixed(2)}`,
    "- Examples:",
    ...group.examples.map((example) => `  - ${example}`),
    "",
  ].join("\n")).join("\n");
}

export async function synthesizeLearningPatterns(
  period: "week" | "month" | "all" = "week",
  options: LearningToolOptions & { dryRun?: boolean } = {},
): Promise<SynthesisResult> {
  const now = options.now ?? new Date();
  const periodName: SynthesisResult["period"] = period === "month" ? "Monthly" : period === "all" ? "All Time" : "Weekly";
  const cutoff = new Date(now);
  if (period === "week") cutoff.setDate(cutoff.getDate() - 7);
  if (period === "month") cutoff.setDate(cutoff.getDate() - 30);
  if (period === "all") cutoff.setTime(0);

  const ratings = (await readRatings(options)).filter((rating) => new Date(rating.timestamp) >= cutoff);
  const result = analyzeRatings(ratings, periodName);
  result.report = formatSynthesisReport(result, now);

  if (!options.dryRun) {
    const paths = pathsForLearningOptions(options);
    const month = now.toISOString().slice(0, 7);
    const dir = paths.resolve("memory", "LEARNING", "SYNTHESIS", month);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${now.toISOString().slice(0, 10)}_${period}-patterns.md`);
    await writeFile(file, result.report, "utf8");
    result.path = file;
  }

  return result;
}
