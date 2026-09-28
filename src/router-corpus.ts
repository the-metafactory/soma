import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createPaths } from "./paths";

/**
 * Router corpus: the prompts the principal actually typed, each with the tail of
 * the reply it answered, extracted from Claude Code session transcripts. This is
 * step 2 of Plans/2026-09-28-front-door-router-design.md — the labelled set a
 * learned router is trained and scored on. Synthetic prompts are not a
 * substitute (the design's lesson L2).
 *
 * The corpus is private: it holds prompt text and is written only under the
 * Soma home's STATE directory. Nothing here prints a prompt.
 */

export const ROUTER_CORPUS_REPLY_TAIL_CHARS = 800;
export const ROUTER_CORPUS_DEFAULT_SAMPLE = 1000;
export const ROUTER_CORPUS_DEFAULT_SEED = "soma-router-v1";

export type RouterCorpusMode = "minimal" | "native" | "algorithm";

export interface RouterCorpusClassification {
  mode: RouterCorpusMode;
  effort?: string;
}

export interface RouterCorpusRow {
  /** Transcript uuid of the prompt entry; unique across the corpus. */
  id: string;
  sessionId: string;
  /** The Claude Code project directory the session belongs to. */
  project: string;
  ts: string;
  /** `typed` = a submitted prompt; `queued` = typed while a turn was running. */
  source: "typed" | "queued";
  prompt: string;
  /** Last characters of the visible assistant text before this prompt. */
  replyTail: string;
  hasPreviousReply: boolean;
  /**
   * What the mode hook decided for the previous prompt of this session. Biased
   * toward `algorithm` before the native-by-default fix (D1).
   */
  previousMode: RouterCorpusMode | null;
  /** The effort the mode hook gave the previous prompt, when it chose Algorithm. */
  previousEffort: string | null;
  /**
   * What the mode hook decided for this prompt at the time. Historical only:
   * never the regex baseline, which is re-run with the current classifier.
   */
  regexAtTime: RouterCorpusClassification | null;
}

export const ROUTER_CORPUS_SKIP_REASONS = [
  "malformed-json",
  "non-interactive",
  "no-entrypoint",
  "meta",
  "sidechain",
  "tool-result",
  "task-notification",
  "slash-command",
  "local-command",
  "bash",
  "caveat",
  "interrupt",
  "compact-summary",
  "peer-message",
  "tagged",
  "empty",
  "queued-non-human",
  "duplicate",
] as const;

export type RouterCorpusSkipReason = (typeof ROUTER_CORPUS_SKIP_REASONS)[number];

export type RouterCorpusSkipCounts = Record<RouterCorpusSkipReason, number>;

function emptySkipCounts(): RouterCorpusSkipCounts {
  return Object.fromEntries(ROUTER_CORPUS_SKIP_REASONS.map((reason) => [reason, 0])) as RouterCorpusSkipCounts;
}

const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Hook attachments chain off each other; this bounds the walk back to the prompt. */
const MAX_ATTACHMENT_HOPS = 64;
const COMPACT_SUMMARY_PREFIX = "This session is being continued from a previous conversation";
const MODE_CONTEXT = /Soma MODE: (MINIMAL|NATIVE|ALGORITHM)(?: (E[1-5]))?/;

type TranscriptEntry = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Classify a string prompt body: a skip reason, or the cleaned prompt text. */
function classifyPromptText(raw: string): { skip: RouterCorpusSkipReason } | { text: string } {
  const text = raw.replace(SYSTEM_REMINDER_BLOCK, "").trim();
  if (text.length === 0) return { skip: "empty" };
  if (text.startsWith("<task-notification>")) return { skip: "task-notification" };
  if (/^<command-(name|message|args)>/.test(text)) return { skip: "slash-command" };
  if (/^<local-command-[a-z]+>/.test(text)) return { skip: "local-command" };
  if (/^<bash-(input|stdout|stderr)>/.test(text)) return { skip: "bash" };
  if (text.startsWith("Caveat:")) return { skip: "caveat" };
  if (text.startsWith("[Request interrupted")) return { skip: "interrupt" };
  if (text.startsWith(COMPACT_SUMMARY_PREFIX)) return { skip: "compact-summary" };
  // Another agent session delivering a message into this one: not the principal.
  if (text.startsWith("Another Claude session sent a message:") || text.includes("<teammate-message")) return { skip: "peer-message" };
  // Any other substrate-generated leading tag is injected, not typed.
  if (/^<[a-z][a-z0-9_-]*>/.test(text)) return { skip: "tagged" };
  return { text };
}

function userContentText(content: unknown): { skip: RouterCorpusSkipReason } | { text: string } {
  if (typeof content === "string") return classifyPromptText(content);
  if (!Array.isArray(content)) return { skip: "empty" };
  const blocks = content.map(asRecord).filter((block): block is Record<string, unknown> => block !== undefined);
  if (blocks.some((block) => block.type === "tool_result")) return { skip: "tool-result" };
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  return classifyPromptText(text);
}

function assistantVisibleText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map(asRecord)
    .filter((block): block is Record<string, unknown> => block !== undefined && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function parseModeContext(content: unknown): RouterCorpusClassification | null {
  const match = MODE_CONTEXT.exec(typeof content === "string" ? content : JSON.stringify(content ?? ""));
  if (!match) return null;
  const mode = match[1].toLowerCase() as RouterCorpusMode;
  return match[2] ? { mode, effort: match[2] } : { mode };
}

/**
 * Headless runs (`claude -p`: review bots, workers) carry an `sdk-*` entrypoint;
 * their prompts are written by programs, not the principal. Transcripts too old
 * to record an entrypoint cannot be told apart, so they are left out rather than
 * guessed.
 */
function entrypointSkipReason(entry: TranscriptEntry): RouterCorpusSkipReason | null {
  if (typeof entry.entrypoint !== "string") return "no-entrypoint";
  if (entry.entrypoint.startsWith("sdk")) return "non-interactive";
  return null;
}

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(text.length - chars);
}

export interface RouterCorpusTranscriptResult {
  rows: RouterCorpusRow[];
  skipped: RouterCorpusSkipCounts;
}

/**
 * Extract the human prompts of one transcript, in file order. `seenIds` is shared
 * across transcripts so a resumed session that replays history cannot put the
 * same prompt in the corpus twice.
 */
export function extractRouterCorpusTranscript(
  raw: string,
  meta: { project: string; sessionId: string },
  seenIds: Set<string> = new Set(),
): RouterCorpusTranscriptResult {
  const skipped = emptySkipCounts();
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (parsed) entries.push(parsed);
      else skipped["malformed-json"] += 1;
    } catch {
      skipped["malformed-json"] += 1;
    }
  }

  // The mode hook's context arrives as an attachment after the prompt it
  // classified. Other hooks' attachments usually sit between the two, so walk
  // the parentUuid chain through attachments until it reaches the prompt.
  const byUuid = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    if (typeof entry.uuid === "string") byUuid.set(entry.uuid, entry);
  }
  const modeByPrompt = new Map<string, RouterCorpusClassification>();
  for (const entry of entries) {
    const attachment = asRecord(entry.attachment);
    if (entry.type !== "attachment" || attachment?.type !== "hook_additional_context") continue;
    const mode = parseModeContext(attachment.content);
    if (!mode) continue;
    let parent = typeof entry.parentUuid === "string" ? byUuid.get(entry.parentUuid) : undefined;
    for (let hops = 1; parent?.type === "attachment" && hops < MAX_ATTACHMENT_HOPS; hops += 1) {
      parent = typeof parent.parentUuid === "string" ? byUuid.get(parent.parentUuid) : undefined;
    }
    if (parent?.type === "user" && typeof parent.uuid === "string") modeByPrompt.set(parent.uuid, mode);
  }

  const rows: RouterCorpusRow[] = [];
  let reply = "";
  let previousMode: RouterCorpusMode | null = null;
  let previousEffort: string | null = null;

  // Every accepted prompt is a turn boundary, including one already in the
  // corpus from another transcript: only the row is deduplicated, never the
  // context that the next prompt's reply tail and previous mode are built from.
  const emit = (id: string, ts: string, source: RouterCorpusRow["source"], prompt: string): void => {
    const regexAtTime = modeByPrompt.get(id) ?? null;
    if (seenIds.has(id)) {
      skipped.duplicate += 1;
    } else {
      seenIds.add(id);
      rows.push({
        id,
        sessionId: meta.sessionId,
        project: meta.project,
        ts,
        source,
        prompt,
        replyTail: tail(reply.trim(), ROUTER_CORPUS_REPLY_TAIL_CHARS),
        hasPreviousReply: reply.trim().length > 0,
        previousMode,
        previousEffort,
        regexAtTime,
      });
    }
    if (regexAtTime) {
      previousMode = regexAtTime.mode;
      previousEffort = regexAtTime.effort ?? null;
    }
    reply = "";
  };

  for (const entry of entries) {
    const id = typeof entry.uuid === "string" ? entry.uuid : undefined;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
    const message = asRecord(entry.message);

    if (entry.type === "assistant") {
      if (entry.isSidechain === true) continue;
      const text = assistantVisibleText(message?.content);
      if (text.trim().length > 0) reply = reply.length > 0 ? `${reply}\n${text}` : text;
      continue;
    }

    if (entry.type === "attachment") {
      const attachment = asRecord(entry.attachment);
      if (attachment?.type !== "queued_command" || !id) continue;
      const entrypointSkip = entrypointSkipReason(entry);
      if (entrypointSkip) {
        skipped[entrypointSkip] += 1;
        continue;
      }
      const origin = asRecord(attachment.origin);
      if (attachment.commandMode !== "prompt" || origin?.kind !== "human" || attachment.isMeta === true) {
        skipped["queued-non-human"] += 1;
        continue;
      }
      const result = typeof attachment.prompt === "string" ? classifyPromptText(attachment.prompt) : { skip: "empty" as const };
      if ("skip" in result) skipped[result.skip] += 1;
      else emit(id, typeof attachment.timestamp === "string" ? attachment.timestamp : ts, "queued", result.text);
      continue;
    }

    if (entry.type !== "user" || !id) continue;
    const entrypointSkip = entrypointSkipReason(entry);
    if (entrypointSkip) {
      skipped[entrypointSkip] += 1;
      continue;
    }
    if (entry.isMeta === true) {
      skipped.meta += 1;
      continue;
    }
    if (entry.isSidechain === true) {
      skipped.sidechain += 1;
      continue;
    }
    if (entry.isCompactSummary === true) {
      skipped["compact-summary"] += 1;
      continue;
    }
    const result = userContentText(message?.content);
    if ("skip" in result) skipped[result.skip] += 1;
    else emit(id, ts, "typed", result.text);
  }

  return { rows, skipped };
}

/** Deterministic sample: rank by sha256(seed + id), keep the first `size`. */
export function sampleRouterCorpus(rows: RouterCorpusRow[], size: number, seed: string): RouterCorpusRow[] {
  return rows
    .map((row) => ({ row, rank: createHash("sha256").update(`${seed}\u0000${row.id}`).digest("hex") }))
    .sort((left, right) => left.rank.localeCompare(right.rank))
    .slice(0, Math.max(0, size))
    .map(({ row }) => row);
}

export interface RouterCorpusBuildResult {
  transcripts: number;
  candidates: number;
  sessions: number;
  rows: RouterCorpusRow[];
  skipped: RouterCorpusSkipCounts;
}

/**
 * Walk `<projectsDir>/<project>/<session>.jsonl`. Deeper files (a session's
 * `subagents/` transcripts) are agent-to-agent traffic and are never read.
 */
export async function buildRouterCorpus(options: { projectsDir: string; sample?: number; seed?: string }): Promise<RouterCorpusBuildResult> {
  const skipped = emptySkipCounts();
  const seenIds = new Set<string>();
  const candidates: RouterCorpusRow[] = [];
  let transcripts = 0;

  // A missing or unreadable source must fail loudly: an empty result would be
  // written over the existing corpus as if it were a real extraction.
  const projects = await readdir(options.projectsDir);
  for (const project of projects.sort()) {
    const projectDir = join(options.projectsDir, project);
    if (!(await stat(projectDir).catch(() => undefined))?.isDirectory()) continue;
    const files = (await readdir(projectDir).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl")).sort();
    for (const file of files) {
      const path = join(projectDir, file);
      if (!(await stat(path).catch(() => undefined))?.isFile()) continue;
      transcripts += 1;
      const result = extractRouterCorpusTranscript(await readFile(path, "utf8"), { project, sessionId: basename(file, ".jsonl") }, seenIds);
      candidates.push(...result.rows);
      for (const reason of ROUTER_CORPUS_SKIP_REASONS) skipped[reason] += result.skipped[reason];
    }
  }

  const rows = sampleRouterCorpus(candidates, options.sample ?? ROUTER_CORPUS_DEFAULT_SAMPLE, options.seed ?? ROUTER_CORPUS_DEFAULT_SEED);
  return {
    transcripts,
    candidates: candidates.length,
    sessions: new Set(rows.map((row) => row.sessionId)).size,
    rows,
    skipped,
  };
}

export function routerCorpusPath(somaHome: string): string {
  return createPaths(somaHome).state("router", "corpus.jsonl");
}

/**
 * The corpus holds prompt text, so it must end up owner-only whatever was at the
 * destination before. `writeFile`'s `mode` applies only when it creates the file,
 * so write a fresh 0600 file beside the destination and rename it over.
 */
export async function writeRouterCorpus(path: string, rows: RouterCorpusRow[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
