/**
 * #120 — `--rewrite-descriptions <agent>` LLM dispatcher for
 * `soma migrate claude-skills`.
 *
 * PAI skills routinely pack multi-paragraph descriptions with usage
 * triggers, examples, and exclusion criteria into the SKILL.md
 * frontmatter `description:` field. PAI's own loader has no upper
 * bound; Codex + Pi.dev both cap at 1024 chars. This module
 * dispatches a single LLM call per oversize-or-missing description
 * to compress it under a 900-char safety target (hard substrate cap
 * is 1024).
 *
 * **Scope.** Single-pass rewrite. No optimization loops. Returns the
 * rewritten string; SHA / length validation / frontmatter splicing
 * lives in the migrator orchestrator so the dispatcher is pure
 * (easy to test via `RewriteDispatchOverride`).
 *
 * **Boundaries.**
 *   - The dispatcher itself NEVER reads disk or mutates state.
 *   - It does NOT enforce the 1024-char cap — the caller validates
 *     the returned text against substrate limits and retries / refuses
 *     as appropriate.
 *   - The `pi` agent is intentionally a TODO refusal at integration
 *     time — Pi.dev's local LLM API has no stable subprocess entry
 *     today. Surfacing the gap loud (instead of silently degrading
 *     to claude) keeps the issue contract honest.
 */
import { createHash } from "node:crypto";
import type { DescriptionStatus, RewriteDescriptionsAgent } from "./types";

/**
 * #120 — hard substrate description limit. Mirrors codex + pi-dev
 * loader behavior. Anything ≤ this passes; anything > refuses (or
 * triggers rewrite). Carried as a `1024` literal so the type system
 * can enforce identity with `DescriptionStatus.threshold`.
 */
export const SUBSTRATE_DESCRIPTION_LIMIT = 1024 as const;

/**
 * #120 — rewrite safety target. The LLM is instructed to land under
 * this number so a single retry under 1024 is still possible when
 * the first attempt overshoots. Caller validates the actual return
 * against 1024 (the hard cap), not this value.
 */
export const DEFAULT_REWRITE_TARGET = 900 as const;

/**
 * #120 — classify a description against the substrate cap. Returns
 * `ok` when present and within the cap, `oversize` when over,
 * `missing` when the source skill carried no `description:` line at
 * all. Length is recorded for the report row + manifest entry.
 *
 * `originalDescription` is the trimmed value of `description:` from
 * frontmatter (callers parse via `parseDescriptionFromFrontmatter`).
 * Pass `undefined` for the "no description line / no frontmatter at
 * all" case — both collapse to `missing`.
 */
export function classifyDescriptionStatus(
  originalDescription: string | undefined,
): DescriptionStatus {
  if (originalDescription === undefined) {
    return { kind: "missing", length: 0, threshold: SUBSTRATE_DESCRIPTION_LIMIT };
  }
  const length = originalDescription.length;
  if (length > SUBSTRATE_DESCRIPTION_LIMIT) {
    return { kind: "oversize", length, threshold: SUBSTRATE_DESCRIPTION_LIMIT };
  }
  return { kind: "ok", length, threshold: SUBSTRATE_DESCRIPTION_LIMIT };
}

/** #120 — SHA-256 of a UTF-8 string. Hex digest, same format as the migrator. */
export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * #120 — build the LLM prompt for a single description rewrite.
 *
 * The prompt structure follows the issue contract:
 *   1. HARD CONSTRAINT (target length) at the top so it survives any
 *      mid-prompt context truncation.
 *   2. PRESERVE priority list — usage triggers, domain identity,
 *      distinguishing examples.
 *   3. DROP list — pleasantries, repeated phrasings, long lists.
 *   4. Source: either the original description (oversize path) OR
 *      the first 2 KiB of the skill body (missing path; synthesize).
 *   5. Output format — single line, no frontmatter delimiters, no
 *      quotes. Plain text.
 *
 * The 2 KiB body cap protects against blowing the LLM context window
 * on large skills (some PAI skills ship 50+ KiB SKILL.md bodies).
 * The leading 2 KiB carries the skill identity (`# Title` + opening
 * paragraphs) which is what we want for synthesis.
 */
const BODY_SYNTHESIS_BYTE_BUDGET = 2048;

export function buildRewritePrompt(input: {
  status: DescriptionStatus;
  originalDescription: string;
  skillMdBody: string;
  targetMaxLength: number;
}): string {
  const { status, originalDescription, skillMdBody, targetMaxLength } = input;
  const bodySample = skillMdBody.slice(0, BODY_SYNTHESIS_BYTE_BUDGET);
  // Two source modes, gated on status.kind. The prompt carries both
  // sections labeled — the LLM sees only the one that applies.
  const sourceSection = status.kind === "missing"
    ? `Synthesize a description from this skill body (first ${BODY_SYNTHESIS_BYTE_BUDGET} bytes):\n---\n${bodySample}\n---`
    : `Original description (length ${status.length}):\n---\n${originalDescription}\n---`;
  return [
    "You are compressing a Claude/Codex/Pi.dev skill description for SKILL.md frontmatter.",
    "",
    `HARD CONSTRAINT: the rewritten description MUST be ≤ ${targetMaxLength} characters.`,
    "",
    "PRESERVE in priority order:",
    "1. Specific usage triggers (e.g., \"USE WHEN ...\", \"TRIGGER when ...\", \"SKIP: ...\").",
    "2. Domain identity (what the skill IS).",
    "3. Examples that distinguish from other skills.",
    "",
    "DROP:",
    "- Pleasantries, hedging.",
    "- Repeated phrasings.",
    "- Long pattern lists (replace with \"X, Y, Z, and N+ more\").",
    "",
    sourceSection,
    "",
    `Output ONLY the rewritten description as a single line, NO frontmatter delimiters, NO quotes. Plain text. Max ${targetMaxLength} chars.`,
  ].join("\n");
}

/**
 * #120 — strip frontmatter delimiters / outer quotes / newlines from
 * an LLM response. Belt-and-braces: the prompt asks for plain text,
 * but real-world models occasionally wrap output in backticks,
 * quotes, or a stray `---` block. We normalize aggressively so the
 * caller's length check operates on the final text that lands in
 * frontmatter.
 */
export function sanitizeRewrittenDescription(raw: string): string {
  let text = raw.trim();
  // Drop a leading + trailing `---` frontmatter block if the model
  // wrapped the description with delimiters.
  text = text.replace(/^---\s*\r?\n?/, "").replace(/\r?\n?\s*---\s*$/, "");
  // Drop a leading `description:` key if the model echoed the field.
  text = text.replace(/^description:\s*/i, "");
  // Strip a single matching pair of outer quotes (matches the
  // `stripQuotes` helper used on the source side — identical contract).
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      text = text.slice(1, -1);
    }
  }
  // Collapse internal newlines + repeated whitespace — frontmatter
  // `description:` is a single line.
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/**
 * #120 — top-level dispatch. Routes to the per-agent subprocess /
 * API call and returns the sanitized rewritten text. The caller
 * validates length + retries / refuses; this function's only job is
 * "produce text from agent X for this request".
 *
 * `pi` is intentionally a hard refusal until a stable Pi.dev local-
 * LLM subprocess lands. The error message names the gap loud so a
 * principal sees it in the CLI output and can choose `claude` or
 * `codex` instead.
 */
export interface RewriteDescriptionRequest {
  agent: Exclude<RewriteDescriptionsAgent, "none">;
  sourceName: string;
  status: DescriptionStatus;
  originalDescription: string;
  skillMdBody: string;
  targetMaxLength: number;
}

export interface RewriteDescriptionResult {
  rewritten: string;
  rewrittenSha: string;
}

/**
 * Per-agent subprocess invocation. Default implementation uses
 * `Bun.spawn` to shell out to the agent CLI; tests inject a stub
 * via the migrator's `rewriteDispatchOverride` option to avoid
 * touching real binaries.
 *
 * Subprocess contracts:
 *   - `claude` → `claude --print --model claude-sonnet-4-6 <prompt>`
 *     (subscription-billed; Sonnet for speed; `--print` returns the
 *     completion text without REPL overhead). Falls back loud if
 *     `claude` is not on PATH.
 *   - `codex`  → `codex exec --model gpt-5.4 <prompt>` (cross-vendor
 *     option; same `--print`-style contract).
 *   - `pi`     → not yet wired; throws with a clear "Pi.dev LLM API
 *     not configured" message so principals see the gap.
 *
 * The actual binary name + flag set is sourced from existing
 * production patterns in this codebase. If a pattern doesn't exist
 * yet, the default is documented above + the commit body. Tests
 * should NEVER hit this path — they always inject a stub.
 */
export async function defaultRewriteDispatch(
  request: RewriteDescriptionRequest,
): Promise<string> {
  const prompt = buildRewritePrompt(request);

  if (request.agent === "pi") {
    throw new Error(
      `--rewrite-descriptions pi: Pi.dev LLM API not configured. Use --rewrite-descriptions claude or codex.`,
    );
  }

  if (request.agent === "claude") {
    // Subscription-billed `claude` subprocess. `--print` returns the
    // completion text + exits without entering the REPL. Sonnet is
    // chosen for throughput; 45 PAI skills × Opus would noticeably
    // tax a session, and the rewrite task is short-form compression
    // (well within Sonnet's reliability envelope).
    return runSubprocess("claude", ["--print", "--model", "claude-sonnet-4-6", prompt], request.sourceName);
  }

  // `codex exec` is the non-interactive entrypoint of the Codex
  // CLI. The arg list intentionally mirrors the `claude --print`
  // shape so the dispatcher stays parallel across agents. Codex
  // pricing is metered (not subscription), so principals opting
  // into `codex` accept the per-call cost.
  //
  // The lint `no-unnecessary-condition` rule narrows `agent` to the
  // literal `"codex"` after the prior `claude`/`pi` branches, so an
  // explicit `if` here is flagged as redundant. We rely on the
  // exhaustive union elimination above and fall through.
  return runSubprocess("codex", ["exec", "--model", "gpt-5.4", prompt], request.sourceName);
}

/**
 * Run a CLI subprocess + capture stdout. Returns the trimmed stdout
 * (the LLM completion text). Throws with the subprocess exit code +
 * stderr tail when the binary exits non-zero, so the migrator can
 * classify the skill as `refused-other` with a useful reason.
 *
 * Bun's `spawn` is used directly — same pattern as
 * `pai-migration.ts:runVerifySubprocess` (the only other LLM-free
 * subprocess in this codebase today). When the binary is not on
 * PATH, Bun surfaces `ENOENT` which we wrap with the agent name so
 * the principal sees `claude: not found` rather than a bare ENOENT.
 */
async function runSubprocess(
  binary: string,
  args: string[],
  sourceName: string,
): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([binary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `--rewrite-descriptions: failed to launch ${binary} for ${sourceName}: ${reason}`,
      { cause: error },
    );
  }
  // `proc.stdout` / `proc.stderr` are typed as a union including
  // `number` (the FD when piped to a file descriptor). With `pipe`
  // they're always ReadableStream — the cast narrows.
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(
      `--rewrite-descriptions: ${binary} exited ${exit} for ${sourceName}: ${stderr.slice(-512).trim()}`,
    );
  }
  return stdout;
}
