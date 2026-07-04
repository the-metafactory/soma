import { readFile } from "node:fs/promises";
import { hasSessionDigest, writeSessionDigest } from "../../memory-episodic";
import { registerSessionEndTranscriptHandler } from "../../lifecycle";
import type { SomaMemoryDigestResult, SubstrateId } from "../../types";

/**
 * Claude Code SessionEnd digest FALLBACK (M5b) — adapter-owned.
 *
 * The transcript FORMAT (Claude Code session JSONL) is a substrate concept, so its
 * extraction lives here, NOT in the substrate-neutral core (docs/architecture.md#Core).
 * Core exposes only `writeSessionDigest` (takes a ready body + `hook:` marker) and the
 * neutral `hasSessionDigest` dedup check; this module turns a Claude transcript into a
 * body deterministically (no LLM) and writes it via core.
 */

// A deterministic fallback needs enough genuine prompts to make a useful 8–15-line
// digest — below this it returns undefined and the session is simply DROPPED (no
// fallback digest). A small session is only captured if the assistant self-authored
// one; the fallback neither checks nor guarantees that.
const FALLBACK_MIN_PROMPTS = 6;
const FALLBACK_MAX_PROMPT_LINES = 13; // + 2 structural (header + tools) = 15 max
const PROMPT_LINE_MAX_CHARS = 120;

/** Wrapper/noise prefixes that mark a "user" line as NOT a genuine principal prompt. */
const PROMPT_NOISE_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<local-command-",
  "<system-reminder>",
  "caveat:",
  "<user-prompt-submit-hook>",
];

/** Collapse control chars + whitespace and truncate — one clean digest pointer line. */
function cleanLine(text: string): string {
  const collapsed = text.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > PROMPT_LINE_MAX_CHARS ? `${collapsed.slice(0, PROMPT_LINE_MAX_CHARS - 1)}…` : collapsed;
}

/** The text of a transcript message's `content` (string, or joined `text` parts). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type?: unknown; text?: unknown } => part !== null && typeof part === "object")
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join(" ");
  }
  return "";
}

/** True only for array content that is purely text parts (never a tool_result). */
function isTextOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((part) => part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text");
}

/** Head+tail sample to `max` lines, inserting an elision marker when trimmed. */
function samplePrompts(prompts: string[], max: number): string[] {
  if (prompts.length <= max) return prompts;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return [...prompts.slice(0, head), `… (${prompts.length - head - tail} more prompts) …`, ...prompts.slice(prompts.length - tail)];
}

/** A classified transcript line: a genuine principal prompt, an assistant turn (with
 *  the tools it used), or nothing worth counting. */
type ClassifiedEntry = { kind: "prompt"; text: string } | { kind: "assistant"; tools: string[] };

/**
 * Classify ONE raw JSONL line. Returns `undefined` for a blank/non-JSON line, a
 * sidechain/meta entry, or a "user" line that isn't a genuine principal prompt
 * (tool_result content or a command/system wrapper). Keeps line-parsing, filtering,
 * and tool-collection out of the extraction loop.
 */
function parseTranscriptLine(raw: string): ClassifiedEntry | undefined {
  const line = raw.trim();
  if (line.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Best-effort: a malformed line is SKIPPED so one bad line can't fail the whole
    // extraction. A corrupt transcript therefore yields a digest from its readable
    // subset with no error — acceptable for a best-effort fallback record (the M7 audit,
    // not this, is the integrity check), NOT a guarantee the digest saw every line.
    return undefined;
  }
  // A valid JSONL line can be `null`, a number, or an array — none is a usable entry.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entry = parsed as Record<string, unknown>;
  if (entry.isSidechain === true || entry.isMeta === true) return undefined; // sub-agent / meta noise
  const message = entry.message as { role?: unknown; content?: unknown } | undefined;

  if (entry.type === "user" && message?.role === "user") {
    // A real prompt is string content; a tool_result array is not principal text.
    if (typeof message.content !== "string" && !isTextOnlyContent(message.content)) return undefined;
    const text = cleanLine(messageText(message.content));
    if (text.length === 0) return undefined;
    const lowerText = text.toLowerCase(); // lowercase ONCE, not per prefix
    if (PROMPT_NOISE_PREFIXES.some((p) => lowerText.startsWith(p))) return undefined;
    return { kind: "prompt", text };
  }

  if (entry.type === "assistant" && message?.role === "assistant") {
    const tools: string[] = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object" && (part as { type?: unknown }).type === "tool_use") {
          const name = (part as { name?: unknown }).name;
          // Tool names come from the ASSISTANT's own tool_use (not principal input), so
          // the injection surface is small; still control-collapse them (strips control
          // chars/newlines) before the `- tools:` rollup. This does NOT escape ordinary
          // directive PROSE — a tool literally named "ignore prior memory" would still
          // read as prose; real tool names are short identifiers, so it is left readable.
          if (typeof name === "string") {
            const clean = cleanLine(name);
            if (clean.length > 0) tools.push(clean);
          }
        }
      }
    }
    return { kind: "assistant", tools };
  }
  return undefined;
}

/**
 * Deterministically extract an 8–15-line digest body from a Claude Code transcript
 * (JSONL). No LLM: it lists the genuine principal prompts — command/system/tool-RESULT
 * lines and sidechain/sub-agent lines are excluded — while assistant `tool_use`
 * activity is SUMMARIZED into a rollup line (counts by tool), not listed as prompts.
 * Returns `undefined` when the session has too few real prompts to summarize.
 * DETERMINISTIC but best-effort: malformed/non-JSON lines are silently skipped, so a
 * corrupt transcript yields a digest of its readable subset (not a complete record).
 */
export function extractDigestBodyFromTranscript(transcript: string): string | undefined {
  const prompts: string[] = [];
  const toolCounts = new Map<string, number>();
  let assistantTurns = 0;

  for (const raw of transcript.split("\n")) {
    const entry = parseTranscriptLine(raw);
    if (entry === undefined) continue; // blank / non-JSON / sidechain / meta
    if (entry.kind === "prompt") prompts.push(entry.text);
    else {
      assistantTurns += 1;
      for (const name of entry.tools) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
  }

  if (prompts.length < FALLBACK_MIN_PROMPTS) return undefined;

  // Sample head + tail when there are many prompts, so the digest captures the arc.
  const shown = samplePrompts(prompts, FALLBACK_MAX_PROMPT_LINES);
  const totalTools = [...toolCounts.values()].reduce((sum, n) => sum + n, 0);
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, n]) => `${name}×${n}`)
    .join(", ");

  // Prompt lines are principal input, control-collapsed + truncated by cleanLine (a
  // lossy pointer, NOT an exact excerpt). Quote + label them (JSON.stringify escapes
  // quotes/controls) so they read as DATA — what was asked — rather than as assistant
  // instructions. This REDUCES the prompt-injection risk (paired with the tool:<name>
  // provenance below); it does not PROVE every downstream recall consumer treats
  // embedded instructions as inert.
  const lines = [
    `- session: ${prompts.length} principal prompts, ${assistantTurns} assistant turns, ${totalTools} tool calls`,
    ...shown.map((p) => `- principal prompt: ${JSON.stringify(p)}`),
    `- tools: ${topTools.length > 0 ? topTools : "none"}`,
  ];
  return lines.join("\n");
}

/** Options for the Claude Code SessionEnd digest fallback. */
export interface ClaudeSessionDigestOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  /** The session this digest summarizes. */
  sessionId: string;
  /** Path to the Claude Code session transcript (JSONL). */
  transcriptPath: string;
  /** Claude Code sub-agent markers from the hook payload — when set, the digest is suppressed. */
  subagentId?: string;
  subagentType?: string;
  /** Force the primary (write) path even for a sub-agent-marked invocation. */
  forcePrimary?: boolean;
  /** Force treating the invocation as a sub-agent (suppress) — takes precedence over forcePrimary. */
  forceSubagent?: boolean;
}

/** Outcome of the transcript-fallback digest. Each cause is distinguished. */
export interface ClaudeSessionDigestResult {
  outcome: "written" | "duplicate" | "suppressed" | "skipped" | "unreadable";
  /** The core digest result when a write/dedup happened; absent otherwise. */
  digest?: SomaMemoryDigestResult;
  /** Human-readable reason (always set). */
  reason: string;
}

/** True when the hook payload CARRIES a sub-agent marker (agent id or type). NOTE:
 *  suppression depends on the payload actually supplying these — an unmarked sub-agent
 *  invocation is NOT detected here and falls through to the write path. Detection is
 *  only as complete as the substrate's markers. */
function hasSubagentMarker(options: ClaudeSessionDigestOptions): boolean {
  return (options.subagentId ?? "").trim().length > 0 || (options.subagentType ?? "").trim().length > 0;
}

/**
 * SessionEnd fallback (M5b): write a deterministic digest from a Claude transcript.
 * Suppresses MARKED sub-agent sessions (ADR 0014 — via subagentId/subagentType in the hook
 * payload; an unmarked sub-agent is not detected); no-ops when a digest already exists (the
 * one-per-session gate — checked BEFORE reading the transcript, so the common primary
 * path does no wasted work); skips a too-thin session; reports an unreadable transcript
 * distinctly. NEVER throws for an absent/unreadable transcript — a hook must not block
 * a session. Best-effort, not a guarantee.
 */
export async function writeSessionDigestFromTranscript(options: ClaudeSessionDigestOptions): Promise<ClaudeSessionDigestResult> {
  // forceSubagent has precedence over forcePrimary (the type promises "regardless").
  if (options.forceSubagent === true) {
    return { outcome: "suppressed", reason: "forced sub-agent (ADR 0014) — no fallback digest written" };
  }
  if (options.forcePrimary !== true && hasSubagentMarker(options)) {
    return { outcome: "suppressed", reason: "sub-agent session (ADR 0014) — no fallback digest written" };
  }

  // Dedup BEFORE reading the transcript — an assistant-authored digest (the primary
  // path) makes the whole transcript read/parse unnecessary.
  if (await hasSessionDigest({ homeDir: options.homeDir, somaHome: options.somaHome, sessionId: options.sessionId })) {
    return { outcome: "duplicate", reason: "a digest already exists for this session — no-op (no transcript read)" };
  }

  const transcript = await readFile(options.transcriptPath, "utf8").catch(() => undefined);
  if (transcript === undefined) {
    return { outcome: "unreadable", reason: `transcript could not be read at ${options.transcriptPath}` };
  }
  const body = extractDigestBodyFromTranscript(transcript);
  if (body === undefined) {
    return { outcome: "skipped", reason: "transcript has too few principal prompts for a fallback digest" };
  }

  // Governance: this is the GOVERNED M5 memory-write path — schema validation, the
  // one-per-session gate, provenance validation, and a memory.digest event. That is the
  // write governance for memory CONTENT. It is NOT the PostToolUse tool-activity
  // writeback QUEUE (substrate telemetry); a session digest is memory content, so it is
  // authored through the memory API, not the telemetry writeback pipeline.
  const digest = await writeSessionDigest({
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrate: options.substrate,
    now: options.now,
    sessionId: options.sessionId,
    body,
    lifecycleEvent: "session-end", // → the note's M0 `hook:` field
    // Distinct provenance: recall's trust banner shows this body was machine-extracted
    // from principal input, NOT assistant-authored.
    provenance: "tool:claude-session-end",
  });
  // A race could still have another writer win between the dedup check and here.
  return {
    outcome: digest.created ? "written" : "duplicate",
    digest,
    reason: digest.created ? "wrote a deterministic session-end fallback digest" : "a digest already exists for this session — no-op",
  };
}

// Dependency inversion: register this adapter's transcript fallback with core
// lifecycle at module load. Core never imports this adapter — it looks the handler up
// by substrate. Importing this module (CLI side-effect / tests) triggers registration.
registerSessionEndTranscriptHandler("claude-code", (input) =>
  writeSessionDigestFromTranscript(input).then((r) => ({ outcome: r.outcome, path: r.digest?.path })),
);
