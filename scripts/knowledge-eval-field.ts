/**
 * Knowledge-orientation eval: field observation of principal corrections.
 *
 *   bun run knowledge-eval field [--window <days>] [--projects-dir <dir>] [--soma-home <dir>] [--json]
 *   bun run knowledge-eval field --sample <n> --seed <n> [--window <days>] ...
 *   bun run knowledge-eval field --agree <labels.json> [--projects-dir <dir>]
 *
 * Reads Claude Code transcripts (`<projects-dir>/<project>/<session>.jsonl`)
 * and `feedback.candidate` events, and reports principal corrections per
 * session. Field data is observation only: it never gates acceptance.
 *
 * The correction classifier is the learning session harvester's
 * (`harvestSessionFile`, type "correction"), applied to principal turns only.
 * A principal turn is a user entry that carries typed text: tool results,
 * meta and sidechain entries and machine prompts are not the principal's.
 *
 * `--sample` writes a labelling sheet of sessions drawn across the soma,
 * ranger and ranger-worker project directories; `--agree` scores the
 * classifier against the completed sheet. The arm is kept only when both
 * precision and recall reach 0.7. The only thing written is the sheet, under
 * $SOMA_HOME/evals/knowledge-orientation/field/; an existing sheet is never
 * overwritten.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { streamEventLines } from "../src/events/index";
import { isSomaFeedbackMachinePrompt, somaMemoryEventsPath } from "../src/events/index";
import { harvestSessionFile } from "../src/flows/session-harvester";
import { isoTimestamp, transcriptContentToText } from "../src/tools/index";

export const DEFAULT_WINDOW_DAYS = 60;
export const AGREEMENT_THRESHOLD = 0.7;
export const SAMPLE_GROUPS = ["soma", "ranger", "ranger-worker"] as const;
export type SampleGroup = (typeof SAMPLE_GROUPS)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HARVEST_CONTENT_LENGTH = 500;
const SHEET_TEXT_LENGTH = 400;

export class FieldUsageError extends Error {}

export function storeRoot(somaHome: string): string {
  return join(resolve(somaHome), "evals", "knowledge-orientation");
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export interface FieldTurn {
  turn: number;
  timestamp: string;
  text: string;
  correction: boolean;
}

export interface FieldSession {
  sessionId: string;
  project: string;
  path: string;
  lastActivity: string;
  turns: FieldTurn[];
  corrections: number;
  feedbackCandidates: number;
}

interface RawTurn {
  timestamp: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "tool_result");
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function principalTurn(entry: Record<string, unknown>): RawTurn | undefined {
  if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return undefined;
  const message = entry.message;
  if (!isRecord(message) || (message.role !== undefined && message.role !== "user")) return undefined;
  if (hasToolResult(message.content)) return undefined;
  const text = transcriptContentToText(message.content);
  if (text === "" || isSomaFeedbackMachinePrompt(text)) return undefined;
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
  let iso: string;
  try {
    iso = isoTimestamp(timestamp);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
  return { timestamp: iso, text };
}

interface ParsedTranscript {
  turns: RawTurn[];
  lastActivity: string | undefined;
}

function parseTranscript(path: string): ParsedTranscript {
  const turns: RawTurn[] = [];
  let lastActivity: string | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (!isRecord(entry)) continue;
    const stamp = parseTimestamp(entry.timestamp);
    if (stamp !== undefined && (lastActivity === undefined || stamp > lastActivity)) lastActivity = stamp;
    const turn = principalTurn(entry);
    if (turn !== undefined) turns.push(turn);
  }
  return { turns, lastActivity };
}

function correctionKey(timestamp: string, text: string): string {
  return `${timestamp}\u0000${text.slice(0, HARVEST_CONTENT_LENGTH)}`;
}

export async function readFieldSession(path: string, project: string): Promise<FieldSession | undefined> {
  const parsed = parseTranscript(path);
  if (parsed.turns.length === 0) return undefined;
  const learnings = await harvestSessionFile(path);
  const flagged = new Set(
    learnings.filter((learning) => learning.type === "correction").map((learning) => correctionKey(learning.timestamp, learning.content)),
  );
  const turns = parsed.turns.map((turn, index): FieldTurn => ({
    turn: index + 1,
    timestamp: turn.timestamp,
    text: turn.text,
    correction: flagged.has(correctionKey(turn.timestamp, turn.text)),
  }));
  return {
    sessionId: basename(path, ".jsonl"),
    project,
    path,
    lastActivity: parsed.lastActivity ?? statSync(path).mtime.toISOString(),
    turns,
    corrections: turns.filter((turn) => turn.correction).length,
    feedbackCandidates: 0,
  };
}

export interface LoadOptions {
  now: Date;
  windowDays?: number;
}

export async function loadFieldSessions(projectsDir: string, options: LoadOptions): Promise<FieldSession[]> {
  if (!existsSync(projectsDir)) throw new FieldUsageError(`No transcripts directory: ${projectsDir}`);
  const since = options.windowDays === undefined ? undefined : new Date(options.now.getTime() - options.windowDays * MS_PER_DAY).toISOString();
  const sessions: FieldSession[] = [];
  const projects = readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const project of projects) {
    const files = readdirSync(join(projectsDir, project), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort();
    for (const file of files) {
      const session = await readFieldSession(join(projectsDir, project, file), project);
      if (session === undefined) continue;
      if (since !== undefined && session.lastActivity < since) continue;
      sessions.push(session);
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// feedback.candidate events
// ---------------------------------------------------------------------------

export interface FeedbackCandidates {
  total: number;
  bySession: Map<string, number>;
}

export async function readFeedbackCandidates(somaHome: string, since: Date): Promise<FeedbackCandidates> {
  const result: FeedbackCandidates = { total: 0, bySession: new Map() };
  const eventsPath = somaMemoryEventsPath(somaHome);
  if (!existsSync(eventsPath)) return result;
  for await (const line of streamEventLines(eventsPath)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (!isRecord(event) || event.kind !== "feedback.candidate") continue;
    const stamp = parseTimestamp(event.timestamp);
    if (stamp === undefined || stamp < since.toISOString()) continue;
    result.total++;
    const metadata = isRecord(event.metadata) ? event.metadata : {};
    const sessionId = metadata.sessionId;
    if (typeof sessionId === "string" && sessionId !== "") {
      result.bySession.set(sessionId, (result.bySession.get(sessionId) ?? 0) + 1);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface FieldSummary {
  project: string;
  sessions: number;
  corrections: number;
  correctionsPerSession: number;
  feedbackCandidates: number;
  sessionIds: string[];
}

export interface FieldReport {
  windowDays: number;
  since: string;
  generatedAt: string;
  projects: FieldSummary[];
  overall: FieldSummary;
  unmatchedFeedbackCandidates: number;
}

function summarise(project: string, sessions: readonly FieldSession[]): FieldSummary {
  const corrections = sessions.reduce((sum, session) => sum + session.corrections, 0);
  return {
    project,
    sessions: sessions.length,
    corrections,
    correctionsPerSession: sessions.length === 0 ? 0 : corrections / sessions.length,
    feedbackCandidates: sessions.reduce((sum, session) => sum + session.feedbackCandidates, 0),
    sessionIds: sessions.map((session) => session.sessionId),
  };
}

export function buildFieldReport(
  sessions: readonly FieldSession[],
  candidates: FeedbackCandidates,
  options: { now: Date; windowDays: number },
): FieldReport {
  const withCandidates = sessions.map((session) => ({ ...session, feedbackCandidates: candidates.bySession.get(session.sessionId) ?? 0 }));
  const byProject = new Map<string, FieldSession[]>();
  for (const session of withCandidates) byProject.set(session.project, [...(byProject.get(session.project) ?? []), session]);
  const overall = summarise("(all)", withCandidates);
  return {
    windowDays: options.windowDays,
    since: new Date(options.now.getTime() - options.windowDays * MS_PER_DAY).toISOString(),
    generatedAt: options.now.toISOString(),
    projects: [...byProject.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([project, group]) => summarise(project, group)),
    overall,
    unmatchedFeedbackCandidates: candidates.total - overall.feedbackCandidates,
  };
}

function summaryLines(summary: FieldSummary): string[] {
  return [
    summary.project,
    `  sessions: ${summary.sessions}`,
    `  corrections detected: ${summary.corrections}`,
    `  corrections per session: ${summary.correctionsPerSession.toFixed(2)}`,
    `  feedback.candidate events: ${summary.feedbackCandidates}`,
    `  session ids: ${summary.sessionIds.join(", ") || "none"}`,
  ];
}

export function formatFieldReport(report: FieldReport): string {
  return [
    `field report: trailing ${report.windowDays} days (since ${report.since})`,
    "",
    ...report.projects.flatMap((summary) => [...summaryLines(summary), ""]),
    ...summaryLines(report.overall),
    `  feedback.candidate events not matched to a listed session: ${report.unmatchedFeedbackCandidates}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Labelling sheet
// ---------------------------------------------------------------------------

export function sampleGroup(project: string): SampleGroup | undefined {
  if (project.includes("-worktrees-")) return "ranger-worker";
  if (project.endsWith("-ranger")) return "ranger";
  if (project.endsWith("-soma")) return "soma";
  return undefined;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]] as [T, T];
  }
  return copy;
}

export function drawSample(sessions: readonly FieldSession[], count: number, seed: number): FieldSession[] {
  const random = seededRandom(seed);
  const pools = SAMPLE_GROUPS.map((group) =>
    shuffled(sessions.filter((session) => sampleGroup(session.project) === group), random),
  );
  const drawn: FieldSession[] = [];
  while (drawn.length < count && pools.some((pool) => pool.length > 0)) {
    for (const pool of pools) {
      const next = pool.shift();
      if (next !== undefined && drawn.length < count) drawn.push(next);
    }
  }
  return drawn.sort((left, right) => left.project.localeCompare(right.project) || left.sessionId.localeCompare(right.sessionId));
}

const LabelSheetSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      project: z.string().optional(),
      turns: z.array(
        z.object({
          turn: z.number().int().positive(),
          text: z.string().optional(),
          correction: z.boolean().nullable().optional(),
        }),
      ),
    }),
  ),
});

export type LabelSheet = z.infer<typeof LabelSheetSchema>;

export function buildLabellingSheet(sample: readonly FieldSession[], meta: { seed: number; windowDays: number; now: Date }) {
  return {
    seed: meta.seed,
    windowDays: meta.windowDays,
    generatedAt: meta.now.toISOString(),
    instructions: "Set correction to true when the principal turn corrects, redirects or rejects what the assistant did; otherwise false. Leave nothing null.",
    sessions: sample.map((session) => ({
      sessionId: session.sessionId,
      project: session.project,
      turns: session.turns.map((turn) => ({
        turn: turn.turn,
        text: turn.text.length > SHEET_TEXT_LENGTH ? `${turn.text.slice(0, SHEET_TEXT_LENGTH)}...` : turn.text,
        correction: null,
      })),
    })),
  };
}

export function writeLabellingSheet(somaHome: string, sheet: ReturnType<typeof buildLabellingSheet>): string {
  const dir = join(storeRoot(somaHome), "field");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `labelling-sheet-seed${sheet.seed}-n${sheet.sessions.length}.json`);
  if (existsSync(path)) {
    throw new FieldUsageError(`Refusing to overwrite an existing labelling sheet: ${path}. Move it aside or pick another seed.`);
  }
  writeFileSync(path, `${JSON.stringify(sheet, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

export interface Agreement {
  sessions: number;
  turns: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number | undefined;
  recall: number | undefined;
  keep: boolean;
}

export function parseLabelSheet(raw: unknown, source: string): LabelSheet {
  const parsed = LabelSheetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FieldUsageError(`Invalid labels file ${source}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  if (parsed.data.sessions.length === 0) throw new FieldUsageError(`Labels file ${source} labels no sessions`);
  return parsed.data;
}

export function computeAgreement(sheet: LabelSheet, sessions: readonly FieldSession[]): Agreement {
  const byId = new Map<string, FieldSession>();
  for (const session of sessions) if (!byId.has(session.sessionId)) byId.set(session.sessionId, session);
  const tally = { tp: 0, fp: 0, fn: 0, tn: 0 };
  let turns = 0;
  for (const labelled of sheet.sessions) {
    const session = byId.get(labelled.sessionId);
    if (session === undefined) throw new FieldUsageError(`Unknown session id in labels: ${labelled.sessionId}`);
    for (const label of labelled.turns) {
      const turn = session.turns.at(label.turn - 1);
      if (turn === undefined) throw new FieldUsageError(`Unknown turn ${label.turn} in session ${labelled.sessionId}`);
      if (typeof label.correction !== "boolean") {
        throw new FieldUsageError(`Unlabelled turn ${label.turn} in session ${labelled.sessionId}`);
      }
      turns++;
      if (turn.correction && label.correction) tally.tp++;
      else if (turn.correction) tally.fp++;
      else if (label.correction) tally.fn++;
      else tally.tn++;
    }
  }
  const precision = tally.tp + tally.fp === 0 ? undefined : tally.tp / (tally.tp + tally.fp);
  const recall = tally.tp + tally.fn === 0 ? undefined : tally.tp / (tally.tp + tally.fn);
  return {
    sessions: sheet.sessions.length,
    turns,
    truePositives: tally.tp,
    falsePositives: tally.fp,
    falseNegatives: tally.fn,
    trueNegatives: tally.tn,
    precision,
    recall,
    keep: precision !== undefined && recall !== undefined && precision >= AGREEMENT_THRESHOLD && recall >= AGREEMENT_THRESHOLD,
  };
}

function ratio(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(3);
}

export function formatAgreement(agreement: Agreement): string {
  return [
    `sessions labelled: ${agreement.sessions}`,
    `turns labelled: ${agreement.turns}`,
    `true positives: ${agreement.truePositives}, false positives: ${agreement.falsePositives}, false negatives: ${agreement.falseNegatives}, true negatives: ${agreement.trueNegatives}`,
    `precision: ${ratio(agreement.precision)}`,
    `recall: ${ratio(agreement.recall)}`,
    `field arm: ${agreement.keep ? "keep" : "drop"}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface FieldArgs {
  window: number;
  projectsDir: string;
  somaHome: string;
  sample: number | undefined;
  seed: number | undefined;
  agree: string | undefined;
  json: boolean;
}

function positiveInteger(flag: string, value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new FieldUsageError(`${flag} needs a positive integer`);
  }
  return Number(value);
}

export function parseFieldArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): FieldArgs {
  const args: FieldArgs = {
    window: DEFAULT_WINDOW_DAYS,
    projectsDir: join(homedir(), ".claude", "projects"),
    somaHome: env.SOMA_HOME ?? join(homedir(), ".soma"),
    sample: undefined,
    seed: undefined,
    agree: undefined,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv.at(index + 1);
    switch (flag) {
      case "--window": args.window = positiveInteger(flag, value); index++; break;
      case "--sample": args.sample = positiveInteger(flag, value); index++; break;
      case "--seed": {
        if (value === undefined || !/^\d+$/.test(value)) throw new FieldUsageError("--seed needs a non-negative integer");
        args.seed = Number(value);
        index++;
        break;
      }
      case "--agree":
      case "--projects-dir":
      case "--soma-home": {
        if (value === undefined || value.startsWith("--")) throw new FieldUsageError(`${flag} needs a value`);
        if (flag === "--agree") args.agree = value;
        else if (flag === "--projects-dir") args.projectsDir = resolve(value);
        else args.somaHome = resolve(value);
        index++;
        break;
      }
      case "--json": args.json = true; break;
      default: throw new FieldUsageError(`Unknown option for field: ${flag}`);
    }
  }
  if (args.sample !== undefined && args.seed === undefined) throw new FieldUsageError("--sample needs --seed");
  if (args.sample !== undefined && args.agree !== undefined) throw new FieldUsageError("--sample and --agree are separate runs");
  return args;
}

export interface FieldDeps {
  now: Date;
  write: (line: string) => void;
}

export async function runField(argv: readonly string[], deps: FieldDeps, env: Record<string, string | undefined> = process.env): Promise<void> {
  const args = parseFieldArgs(argv, env);

  if (args.agree !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(args.agree, "utf8"));
    } catch (error) {
      if (error instanceof Error) throw new FieldUsageError(`Cannot read labels file ${args.agree}: ${error.message}`);
      throw error;
    }
    const sheet = parseLabelSheet(raw, args.agree);
    const sessions = await loadFieldSessions(args.projectsDir, { now: deps.now });
    const agreement = computeAgreement(sheet, sessions);
    deps.write(args.json ? JSON.stringify(agreement, null, 2) : formatAgreement(agreement));
    return;
  }

  const sessions = await loadFieldSessions(args.projectsDir, { now: deps.now, windowDays: args.window });

  if (args.sample !== undefined && args.seed !== undefined) {
    const sample = drawSample(sessions, args.sample, args.seed);
    if (sample.length === 0) throw new FieldUsageError("No soma, ranger or ranger-worker sessions in the window to sample");
    const path = writeLabellingSheet(args.somaHome, buildLabellingSheet(sample, { seed: args.seed, windowDays: args.window, now: deps.now }));
    const perGroup = SAMPLE_GROUPS.map((group) => `${group}: ${sample.filter((session) => sampleGroup(session.project) === group).length}`);
    deps.write(`labelling sheet: ${path}`);
    deps.write(`sessions drawn: ${sample.length} of ${args.sample} requested (${perGroup.join(", ")})`);
    return;
  }

  const since = new Date(deps.now.getTime() - args.window * MS_PER_DAY);
  const candidates = await readFeedbackCandidates(args.somaHome, since);
  const report = buildFieldReport(sessions, candidates, { now: deps.now, windowDays: args.window });
  deps.write(args.json ? JSON.stringify(report, null, 2) : formatFieldReport(report));
}
