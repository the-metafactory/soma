// Session-scoped mode+effort feed for the claude-code statusline. This is a
// SUBSTRATE concern (a Claude-Code-specific status line), so it lives in the
// claude-code adapter — NOT in core, and NOT on the portable `soma algorithm
// classify` command surface, which stays pure.
//
// The mode-classifier hook (mode-classifier-hook.mjs) is the sole writer: it
// already spawns `classify --json` every prompt and parses {mode, effort}, then
// writes the per-session state file the statusline reads. Because the hook is a
// standalone .mjs that cannot import TypeScript, it mirrors the ~4-line write
// inline; this module holds the same path + payload + sanitization logic in a
// directly unit-testable form (see test/claude-code-statusline-mode-state.test.ts).
//
// Why a dedicated per-session file rather than the existing work-registry
// current-work pointer: that pointer carries task/phase, not mode/effort, and
// the global active-algorithm-run.json leaks across concurrent sessions.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StatuslineModeState {
  mode: string;
  effort: string;
  updatedAt: string;
}

export interface WriteStatuslineModeStateInput {
  somaHome: string;
  sessionId: string;
  mode: string;
  effort?: string;
  updatedAt: string;
}

// Sanitize the session id used as a filename segment. Kept deliberately in
// lockstep with statusline.sh's read-side guard (`^[A-Za-z0-9._-]+$`): for any
// id that passes that guard this replace is the identity, so the reader's raw
// `$sid` addresses exactly the file this writer produced. For an unsafe id the
// disallowed runs collapse to `-`, so the write stays a single basename inside
// STATE (no `/` to create subdirs, and `..` can never be a standalone path
// segment because it is always wrapped as `statusline-mode-<token>.json`) —
// while the statusline drops the Soma segment for such ids entirely.
export function sanitizeStatuslineSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function statuslineModeStatePath(somaHome: string, sessionId: string): string {
  return join(somaHome, "memory", "STATE", `statusline-mode-${sanitizeStatuslineSessionId(sessionId)}.json`);
}

export function buildStatuslineModeState(input: { mode: string; effort?: string; updatedAt: string }): StatuslineModeState {
  return {
    mode: input.mode,
    effort: input.effort ?? "",
    updatedAt: input.updatedAt,
  };
}

// Best-effort synchronous write (the caller — a prompt-path hook — must never
// be blocked or broken by a feed failure, so it wraps this in try/catch).
export function writeStatuslineModeState(input: WriteStatuslineModeStateInput): string {
  const path = statuslineModeStatePath(input.somaHome, input.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const payload = buildStatuslineModeState(input);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
