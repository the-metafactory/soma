import { addOpinion, addOpinionEvidence, captureFailure, completeSessionProgress, createSessionProgress, formatCountsShell, getSomaCounts, harvestSessions, listOpinions, listSessionProgress, recordSessionBlocker, recordSessionDecision, recordSessionHandoff, recordSessionNextStep, recordSessionWork, resumeSessionProgress, showOpinion, synthesizeLearningPatterns } from "./index";
import type { EvidenceType, LearningToolOptions, OpinionCategory } from "./types";

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function commonOptions(args: string[]): LearningToolOptions {
  const options: LearningToolOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--home-dir") options.homeDir = readOption(args, index, "--home-dir");
    if (args[index] === "--soma-home") options.somaHome = readOption(args, index, "--soma-home");
  }
  return options;
}

function stripCommon(args: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--home-dir" || args[index] === "--soma-home") {
      index += 1;
      continue;
    }
    stripped.push(args[index]);
  }
  return stripped;
}

export async function runLearningCli(args: string[]): Promise<string> {
  const options = commonOptions(args);
  const local = stripCommon(args);
  const action = local[0];
  if (action === "synthesize") {
    const period = local.includes("--month") ? "month" : local.includes("--all") ? "all" : "week";
    const result = await synthesizeLearningPatterns(period, { ...options, dryRun: local.includes("--dry-run") });
    return [
      `soma learning synthesize - ${result.period}`,
      `ratings: ${result.totalRatings}`,
      `average: ${result.avgRating.toFixed(1)}`,
      `frustrations: ${result.frustrations.length}`,
      `successes: ${result.successes.length}`,
      result.path ? `report: ${result.path}` : "dry-run: report not written",
      "",
    ].join("\n");
  }
  if (action === "capture-failure") {
    const allowRemoteInference = local.includes("--allow-remote-inference");
    const [transcriptPath, ratingValue, sentimentSummary, detailedContext] = local.slice(1).filter((item) => item !== "--allow-remote-inference");
    if (!transcriptPath || !ratingValue || !sentimentSummary) {
      throw new Error("Usage: soma learning capture-failure <transcript-path> <rating> <summary> [detailed-context] [--allow-remote-inference]");
    }
    const rating = Number(ratingValue);
    if (!Number.isFinite(rating)) {
      throw new Error("capture-failure rating must be a finite number.");
    }
    const result = await captureFailure({
      ...options,
      transcriptPath,
      rating,
      sentimentSummary,
      detailedContext,
      allowRemoteInference,
    });
    return result.path ? `${result.path}\n` : "failure capture skipped\n";
  }
  if (action === "harvest") {
    const recentIndex = local.indexOf("--recent");
    const sessionIndex = local.indexOf("--session");
    const sessionDirIndex = local.indexOf("--session-dir");
    const recent = recentIndex === -1 ? undefined : Number(readOption(local, recentIndex, "--recent"));
    if (recent !== undefined && (!Number.isFinite(recent) || recent < 0)) {
      throw new Error("--recent must be a non-negative finite number.");
    }
    const learnings = await harvestSessions({
      ...options,
      recent,
      all: local.includes("--all"),
      dryRun: local.includes("--dry-run"),
      sessionId: sessionIndex === -1 ? undefined : readOption(local, sessionIndex, "--session"),
      sessionDir: sessionDirIndex === -1 ? undefined : readOption(local, sessionDirIndex, "--session-dir"),
    });
    return `soma learning harvest - ${learnings.length} learning(s)\n${learnings.map((learning) => learning.path ?? `${learning.category}/${learning.type}/${learning.sessionId}`).join("\n")}${learnings.length ? "\n" : ""}`;
  }
  throw new Error("Usage: soma learning <synthesize|capture-failure|harvest> ...");
}

export async function runOpinionCli(args: string[]): Promise<string> {
  const options = commonOptions(args);
  const local = stripCommon(args);
  const action = local[0];
  if (action === "add") {
    const statement = local[1];
    const categoryIndex = local.indexOf("--category");
    if (!statement) throw new Error("Usage: soma opinion add <statement> [--category <category>]");
    const opinion = await addOpinion(statement, (categoryIndex === -1 ? "relationship" : readOption(local, categoryIndex, "--category")) as OpinionCategory, options);
    return `added opinion: ${opinion.statement} (${opinion.category}, ${opinion.confidence.toFixed(2)})\n`;
  }
  if (action === "evidence") {
    const statement = local[1];
    if (!statement) throw new Error("Usage: soma opinion evidence <statement> --supporting|--counter|--confirmation|--contradiction <description>");
    const flags: Array<[string, EvidenceType]> = [["--supporting", "supporting"], ["--counter", "counter"], ["--confirmation", "confirmation"], ["--contradiction", "contradiction"]];
    const found = flags.map(([flag, type]) => ({ flag, type, index: local.indexOf(flag) })).find((item) => item.index !== -1);
    if (!found) throw new Error("Opinion evidence requires --supporting, --counter, --confirmation, or --contradiction.");
    const result = await addOpinionEvidence(statement, found.type, readOption(local, found.index, found.flag), options);
    return `updated opinion: ${result.opinion.statement}\nconfidence: ${result.oldConfidence.toFixed(2)} -> ${result.opinion.confidence.toFixed(2)}\n`;
  }
  if (action === "list") {
    const opinions = await listOpinions(options);
    return `${opinions.map((opinion) => `${opinion.confidence.toFixed(2)} ${opinion.category} ${opinion.statement}`).join("\n")}${opinions.length ? "\n" : ""}`;
  }
  if (action === "show") {
    const statement = local[1];
    if (!statement) throw new Error("Usage: soma opinion show <statement>");
    const opinion = await showOpinion(statement, options);
    if (!opinion) throw new Error(`Opinion not found: ${statement}`);
    return JSON.stringify(opinion, null, 2) + "\n";
  }
  throw new Error("Usage: soma opinion <add|evidence|list|show> ...");
}

export async function runMetricsCli(args: string[]): Promise<string> {
  const options = commonOptions(args);
  const local = stripCommon(args);
  const counts = await getSomaCounts(options);
  const singleIndex = local.indexOf("--single");
  if (singleIndex !== -1) {
    const key = readOption(local, singleIndex, "--single") as keyof typeof counts;
    if (!(key in counts)) throw new Error(`Unknown metric: ${key}`);
    return `${counts[key]}\n`;
  }
  if (local.includes("--shell")) return formatCountsShell(counts);
  return JSON.stringify(counts) + "\n";
}

export async function runSessionCli(args: string[]): Promise<string> {
  const options = commonOptions(args);
  const local = stripCommon(args);
  const [action, project, ...rest] = local;
  if (action === "create" && project) {
    const progress = await createSessionProgress(project, rest, options);
    return `created session: ${progress.project}\n`;
  }
  if (action === "decision" && project && rest[0]) return `recorded decision: ${(await recordSessionDecision(project, rest[0], options)).project}\n`;
  if (action === "work" && project && rest[0]) return `recorded work: ${(await recordSessionWork(project, rest[0], options)).project}\n`;
  if (action === "blocker" && project && rest[0]) return `recorded blocker: ${(await recordSessionBlocker(project, rest[0], options)).project}\n`;
  if (action === "next" && project && rest[0]) return `recorded next step: ${(await recordSessionNextStep(project, rest[0], options)).project}\n`;
  if (action === "handoff" && project && rest[0]) return `recorded handoff: ${(await recordSessionHandoff(project, rest[0], options)).project}\n`;
  if (action === "resume" && project) return `${await resumeSessionProgress(project, options)}\n`;
  if (action === "complete" && project) return `completed session: ${(await completeSessionProgress(project, options)).project}\n`;
  if (action === "list") {
    const records = await listSessionProgress(options);
    return `${records.map((record) => `${record.project} ${record.status} ${record.updated}`).join("\n")}${records.length ? "\n" : ""}`;
  }
  throw new Error("Usage: soma session <create|decision|work|blocker|next|handoff|resume|list|complete> ...");
}
