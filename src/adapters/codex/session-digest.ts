import { constants as fsConstants, createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { registerSessionEndTranscriptHandler } from "../../lifecycle";
import { hasSessionDigest, writeSessionDigest } from "../../memory-episodic";
import type { SomaMemoryDigestResult, SubstrateId } from "../../types";

const FALLBACK_MIN_PROMPTS = 6;
const FALLBACK_MAX_PROMPT_LINES = 13;
const FALLBACK_HEAD_PROMPTS = Math.ceil((FALLBACK_MAX_PROMPT_LINES - 1) / 2);
const FALLBACK_TAIL_PROMPTS = FALLBACK_MAX_PROMPT_LINES - FALLBACK_HEAD_PROMPTS;
const FALLBACK_TAIL_WITH_ELISION = FALLBACK_MAX_PROMPT_LINES - 1 - FALLBACK_HEAD_PROMPTS;
const PROMPT_LINE_MAX_CHARS = 120;

const PROMPT_NOISE_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<local-command-",
  "<system-reminder>",
  "<user-prompt-submit-hook>",
  "caveat:",
];

function cleanLine(text: string): string {
  const collapsed = text.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > PROMPT_LINE_MAX_CHARS ? `${collapsed.slice(0, PROMPT_LINE_MAX_CHARS - 1)}...` : collapsed;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const object = objectValue(part);
      if (object?.type === "text" && typeof object.text === "string") return object.text;
      if (object?.type === "input_text" && typeof object.text === "string") return object.text;
      if (typeof object?.content === "string") return object.content;
      return "";
    })
    .filter((text) => text.length > 0)
    .join(" ");
}

function isTextOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((part) => {
    const object = objectValue(part);
    return object?.type === "text" || object?.type === "input_text";
  });
}

type ClassifiedEntry = { kind: "prompt"; text: string } | { kind: "assistant"; tools: string[] };
type DigestState = {
  promptCount: number;
  promptHead: string[];
  promptTail: string[];
  toolCounts: Map<string, number>;
  assistantTurns: number;
};

function roleOf(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): string | undefined {
  const role = message?.role ?? entry.role ?? entry.type;
  return typeof role === "string" ? role : undefined;
}

function contentOf(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): unknown {
  return message?.content ?? entry.content ?? entry.text;
}

function collectToolNames(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolNames(item, out);
    return;
  }
  const object = objectValue(value);
  if (object === undefined) return;
  if (object.type === "tool_use" || object.type === "function_call" || object.type === "tool_call") {
    const name = object.name ?? object.tool_name ?? object.function_name;
    if (typeof name === "string") {
      const clean = cleanLine(name);
      if (clean.length > 0) out.push(clean);
    }
  }
  collectToolNames(object.content, out);
  collectToolNames(object.tool_calls, out);
}

function parseTranscriptLine(raw: string): ClassifiedEntry | undefined {
  const line = raw.trim();
  if (line.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const entry = objectValue(parsed);
  if (entry === undefined || entry.isSidechain === true || entry.isMeta === true) return undefined;
  const message = objectValue(entry.message);
  const role = roleOf(entry, message);

  if (role === "user") {
    const content = contentOf(entry, message);
    if (typeof content !== "string" && !isTextOnlyContent(content)) return undefined;
    const text = cleanLine(messageText(content));
    if (text.length === 0) return undefined;
    const lower = text.toLowerCase();
    if (PROMPT_NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return undefined;
    return { kind: "prompt", text };
  }

  if (role === "assistant") {
    const tools: string[] = [];
    collectToolNames(contentOf(entry, message), tools);
    collectToolNames(entry.tool_calls, tools);
    return { kind: "assistant", tools };
  }

  return undefined;
}

function newDigestState(): DigestState {
  return { promptCount: 0, promptHead: [], promptTail: [], toolCounts: new Map<string, number>(), assistantTurns: 0 };
}

function sampledPrompts(input: DigestState): string[] {
  if (input.promptCount <= FALLBACK_MAX_PROMPT_LINES) return [...input.promptHead, ...input.promptTail];
  const tail = input.promptTail.slice(-FALLBACK_TAIL_WITH_ELISION);
  const omitted = input.promptCount - input.promptHead.length - tail.length;
  return [...input.promptHead, `... (${omitted} more prompts) ...`, ...tail];
}

function renderDigestBody(input: DigestState): string | undefined {
  if (input.promptCount < FALLBACK_MIN_PROMPTS) return undefined;

  const shown = sampledPrompts(input);
  const totalTools = [...input.toolCounts.values()].reduce((sum, n) => sum + n, 0);
  const topTools = [...input.toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, n]) => `${name}x${n}`)
    .join(", ");

  return [
    `- session: ${input.promptCount} principal prompts, ${input.assistantTurns} assistant turns, ${totalTools} tool calls`,
    ...shown.map((prompt) => `- principal prompt: ${JSON.stringify(prompt)}`),
    `- tools: ${topTools.length > 0 ? topTools : "none"}`,
  ].join("\n");
}

function collectDigestEntry(entry: ClassifiedEntry | undefined, state: DigestState): void {
  if (entry === undefined) return;
  if (entry.kind === "prompt") {
    state.promptCount += 1;
    if (state.promptHead.length < FALLBACK_HEAD_PROMPTS) {
      state.promptHead.push(entry.text);
    } else {
      state.promptTail.push(entry.text);
      if (state.promptTail.length > FALLBACK_TAIL_PROMPTS) state.promptTail.shift();
    }
    return;
  }
  state.assistantTurns += 1;
  for (const name of entry.tools) state.toolCounts.set(name, (state.toolCounts.get(name) ?? 0) + 1);
}

function collectDigestLine(raw: string, state: DigestState): void {
  collectDigestEntry(parseTranscriptLine(raw), state);
}

export function extractCodexDigestBodyFromTranscript(transcript: string): string | undefined {
  const state = newDigestState();

  for (const raw of transcript.split("\n")) {
    collectDigestLine(raw, state);
  }

  return renderDigestBody(state);
}

async function extractCodexDigestBodyFromTranscriptFile(transcriptPath: string): Promise<string | undefined> {
  const state = newDigestState();
  const handle = await open(transcriptPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stream = createReadStream("", { fd: handle.fd, encoding: "utf8", autoClose: false });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const raw of lines) {
      collectDigestLine(raw, state);
    }
    return renderDigestBody(state);
  } finally {
    await handle.close();
  }
}

export interface CodexSessionDigestOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  sessionId: string;
  transcriptPath: string;
  transcriptRoot?: string;
  subagentId?: string;
  subagentType?: string;
  forcePrimary?: boolean;
  forceSubagent?: boolean;
}

export interface CodexSessionDigestResult {
  outcome: "written" | "duplicate" | "suppressed" | "skipped" | "unreadable" | "refused";
  digest?: SomaMemoryDigestResult;
  reason: string;
}

function hasSubagentMarker(options: CodexSessionDigestOptions): boolean {
  return (options.subagentId ?? "").trim().length > 0 || (options.subagentType ?? "").trim().length > 0;
}

async function isContainedRegularJsonl(options: CodexSessionDigestOptions): Promise<boolean> {
  if (!isAbsolute(options.transcriptPath) || !options.transcriptPath.endsWith(".jsonl")) return false;
  const root = resolve(options.transcriptRoot ?? join(options.homeDir ?? homedir(), ".codex", "sessions"));
  const target = resolve(options.transcriptPath);
  const rel = relative(root, target);
  if (rel === "" || rel.includes("/") || rel.includes("\\") || rel.startsWith("..") || isAbsolute(rel)) return false;

  const [rootReal, parentReal, targetStat] = await Promise.all([
    realpath(root).catch(() => undefined),
    realpath(resolve(target, "..")).catch(() => undefined),
    lstat(target).catch(() => undefined),
  ]);
  if (rootReal === undefined || parentReal === undefined || targetStat === undefined || !targetStat.isFile() || targetStat.isSymbolicLink()) return false;
  const realRel = relative(rootReal, parentReal);
  return realRel === "" || (!realRel.startsWith("..") && !isAbsolute(realRel));
}

export async function writeCodexSessionDigestFromTranscript(options: CodexSessionDigestOptions): Promise<CodexSessionDigestResult> {
  if (options.forceSubagent === true) {
    return { outcome: "suppressed", reason: "forced Codex sub-agent - no fallback digest written" };
  }
  if (options.forcePrimary !== true && hasSubagentMarker(options)) {
    return { outcome: "suppressed", reason: "Codex sub-agent session - no fallback digest written" };
  }

  if (!(await isContainedRegularJsonl(options))) {
    return { outcome: "refused", reason: `transcript path is outside the allowed Codex transcript root or not a regular .jsonl file: ${options.transcriptPath}` };
  }

  if (await hasSessionDigest({ homeDir: options.homeDir, somaHome: options.somaHome, sessionId: options.sessionId })) {
    return { outcome: "duplicate", reason: "a digest already exists for this session - no-op (no transcript read)" };
  }

  let body: string | undefined;
  try {
    body = await extractCodexDigestBodyFromTranscriptFile(options.transcriptPath);
  } catch {
    return { outcome: "unreadable", reason: `transcript could not be read at ${options.transcriptPath}` };
  }
  if (body === undefined) {
    return { outcome: "skipped", reason: "transcript has too few principal prompts for a fallback digest" };
  }

  const digest = await writeSessionDigest({
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrate: options.substrate,
    now: options.now,
    sessionId: options.sessionId,
    body,
    lifecycleEvent: "session-end",
    provenance: "tool:codex-session-end",
  });

  return {
    outcome: digest.created ? "written" : "duplicate",
    digest,
    reason: digest.created ? "wrote a deterministic Codex session-end fallback digest" : "a digest already exists for this session - no-op",
  };
}

registerSessionEndTranscriptHandler("codex", (input) =>
  writeCodexSessionDigestFromTranscript(input).then((result) => ({ outcome: result.outcome, path: result.digest?.path })),
);
