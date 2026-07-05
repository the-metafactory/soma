import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readAlgorithmRunById, writeAlgorithmRun } from "./algorithm-store";
import { appendAlgorithmProvenance } from "./algorithm-provenance";
import { appendSomaMemoryEvent } from "./memory";
import { writeMemoryNote } from "./memory-write";
import { SOMA_MEMORY_BACKFILL_TYPE_MAP } from "./types";
import type { AlgorithmRun, SomaMemoryPromotionOptions, SomaMemoryPromotionResult, WritableNoteType } from "./types";
import { SOMA_PROMOTION_STORE_DIRS } from "./memory-stores";
import { getCriteria, getGoal } from "./vsa-accessors";
import { getRunPhase } from "./algorithm-lifecycle";

/**
 * Internal promotion options — extends the public options with `onDurable`,
 * an internal callback for syncAlgorithmRunFromVsa to mark when a promotion
 * becomes durable. NOT part of the public SDK contract; only
 * promoteAlgorithmRunMemoryInternal accepts it. The exported
 * promoteAlgorithmRunMemory accepts SomaMemoryPromotionOptions (public) and
 * forwards onDurable as a separate internal parameter.
 */
interface PromotionOptions extends SomaMemoryPromotionOptions {
  onDurable?: () => void;
}

const PROMOTION_STORE_DIRS = SOMA_PROMOTION_STORE_DIRS;

// Promotion mints a principal-trust durable note so the earned-inclusion INDEX
// admits it immediately. The note type mirrors backfill's category→type map
// (LEARNING→procedural, everything else→semantic) so the two paths stay
// interchangeable for the same source. Trust is minted via the
// principal-correction trigger, but ONLY when the caller passes the explicit
// principalAuthority opt-in (mirrors --principal-authority on `soma memory
// write`); hasPromotionVerification is a PRECONDITION, not the authority. See
// the authority-model comment on writePromotionMemoryNote and
// docs/architecture.md Memory section for the full model.
function promotionNoteType(store: SomaMemoryPromotionOptions["store"]): WritableNoteType {
  return SOMA_MEMORY_BACKFILL_TYPE_MAP[PROMOTION_STORE_DIRS[store]] ?? "semantic";
}

// Build the durable note id as `<store>-<title-slug>-<run-slug>`. Backfill
// skips PROMOTED/ subtrees (see memory-backfill.ts), so promote is the sole
// writer of promotion durable notes — this builder is NOT designed to match
// a backfill-derived id for the same file (backfill never imports it). The
// shape just follows the `<category>-<stem>` convention for familiarity.
//
// The run id is the uniqueness key across promotions. slugify normalizes
// non-alphanumeric chars (e.g. "a/b" and "a:b" both become "a-b"), so the slug
// alone is not sufficient. See promotionRunIdPart for the disambiguation
// contract.
function normalizeNoteIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function runIdHash8(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 8);
}

// Build the run-id component of the note id. slugify normalizes
// non-alphanumeric chars (e.g. "a/b" and "a:b" both become "a-b"), so the slug
// alone cannot distinguish distinct run ids. promotionRunIdPart ALWAYS
// appends an 8-hex-char sha256 prefix of the FULL run id (32 bits) so distinct
// run ids are PROBABILISTICALLY disambiguated even when their slugs collide.
// By birthday paradox, a 50% collision probability needs ~65k promotions sharing
// the same title-stem — best-effort collision resistance, NOT a guarantee.
function promotionRunIdPart(runId: string): string {
  const runSlugRaw = normalizeNoteIdPart(runId).slice(0, 80);
  const runSlug = runSlugRaw.length > 0 ? runSlugRaw : "run";
  const hash8 = runIdHash8(runId);
  const maxRun = 24;
  // Cap the slug so the `-<hash8>` suffix always fits within maxRun.
  const slugBudget = maxRun - hash8.length - 1;
  const truncatedSlug = runSlug.slice(0, slugBudget).replace(/-+$/g, "") || "run";
  return `${truncatedSlug}-${hash8}`;
}

export function promotionNoteId(store: SomaMemoryPromotionOptions["store"], title: string, runId: string): string {
  const storePrefix = PROMOTION_STORE_DIRS[store].toLowerCase();
  const titleSlug = slugify(title);
  const runPart = promotionRunIdPart(runId);
  const separatorOverhead = storePrefix.length + 2; // `<store>-` + `-<run>`
  const titleBudget = Math.max(0, 64 - separatorOverhead - runPart.length);
  const titlePart = titleSlug.slice(0, titleBudget).replace(/-+$/g, "");
  const raw = `${storePrefix}-${titlePart}-${runPart}`;
  // storePrefix is always nonempty (e.g. "knowledge"), so normalized/truncated is
  // always nonempty — no fallback branch needed.
  return normalizeNoteIdPart(raw).slice(0, 64).replace(/-+$/g, "");
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Soma memory promotion ${field} must not be empty.`);
  }
}

// Mint the durable, INDEX-admissible note at principal trust from a promotion.
// Extracted from promoteAlgorithmRunMemory so the promotion function scans the
// flow and this helper owns the note-write/rollback subflow.
//
// Authority model: see docs/architecture.md Memory section. The caller MUST
// have already gated on `options.principalAuthority === true` (the deliberate-
// escalation opt-in mirroring `--principal-authority` on `soma memory write`);
// `hasPromotionVerification` is a PRECONDITION, not the trust source. This
// helper asserts `principalAuthority` and passes it through to writeMemoryNote.
//
// Rollback: the note write is the FIRST durable step after the PROMOTED file
// (no memory.promotion event has been appended yet). writeMemoryNote's own
// createNote rolls back the note file if its event append fails, so if it
// throws, no note file or note-event exists — unlinking the PROMOTED file is
// safe (no note-event to orphan). The unlink is best-effort: if it fails, the
// PROMOTED file remains while the error propagates; the caller is notified.
async function writePromotionMemoryNote(input: {
  somaHome: string;
  substrate: import("./types").SubstrateId;
  now: Date;
  store: SomaMemoryPromotionOptions["store"];
  title: string;
  runId: string;
  body: string;
  sourceOfTruth: string;
  promotedFilePath: string;
  principalAuthority: boolean;
}): Promise<{ notePath: string; noteId: string }> {
  if (input.principalAuthority !== true) {
    throw new Error("writePromotionMemoryNote requires principalAuthority: true (the deliberate-escalation gate).");
  }
  const noteType = promotionNoteType(input.store);
  const noteId = promotionNoteId(input.store, input.title, input.runId);
  const noteResult = await writeMemoryNote({
    somaHome: input.somaHome,
    substrate: input.substrate,
    now: input.now,
    mode: "create",
    trigger: "principal-correction",
    principalAuthority: input.principalAuthority,
    type: noteType,
    id: noteId,
    body: input.body,
    sourceOfTruth: input.sourceOfTruth,
    project: null,
    hook: input.title,
  }).catch(async (error: unknown) => {
    await unlink(input.promotedFilePath).catch(() => undefined);
    throw new Error(
      `Soma memory promotion durable-note write failed; attempted best-effort removal of promotion file (may remain if unlink failed): ${input.promotedFilePath}`,
      { cause: error },
    );
  });
  return { notePath: noteResult.path, noteId };
}

function resolveSomaHome(options: Pick<SomaMemoryPromotionOptions, "homeDir" | "somaHome"> = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "memory"
  );
}

function checkedCriteria(run: AlgorithmRun): string[] {
  return getCriteria(run.vsa).map((criterion) => {
    const mark = criterion.status === "passed" ? "x" : criterion.status === "dropped" ? "-" : " ";
    const verification = criterion.verification ? ` Evidence: ${criterion.verification}` : "";
    return `- [${mark}] ${criterion.id}: ${criterion.text}${verification}`;
  });
}

function promotionLesson(run: AlgorithmRun, explicitLesson?: string): string {
  if (explicitLesson?.trim()) return explicitLesson.trim();

  const learned = run.learning.at(-1)?.text;
  if (learned) return learned;

  const decision = run.decisions.at(-1)?.text;
  if (decision) return decision;

  return getGoal(run.vsa) ?? "";
}

function hasPromotionVerification(run: AlgorithmRun): boolean {
  return run.verification.length > 0 || getCriteria(run.vsa).some((criterion) => criterion.status === "passed");
}

function renderPromotionContent(input: {
  run: AlgorithmRun;
  runPath: string;
  title: string;
  store: SomaMemoryPromotionOptions["store"];
  lesson: string;
  appliesWhen?: string;
  timestamp: string;
}): string {
  return [
    `# ${input.title}`,
    "",
    `Promoted: ${input.timestamp}`,
    `Store: ${input.store}`,
    `Source run: ${input.run.id}`,
    `Source path: ${input.runPath}`,
    `Phase: ${getRunPhase(input.run)}`,
    `Effort: ${input.run.effort}`,
    "",
    "## Durable Lesson",
    "",
    input.lesson,
    "",
    "## Recall When",
    "",
    input.appliesWhen?.trim() ?? "Recall when similar work, decisions, or relationship context appears.",
    "",
    "## Source Goal",
    "",
    getGoal(input.run.vsa) ?? "",
    "",
    "## Source Criteria",
    "",
    ...checkedCriteria(input.run),
    "",
    "## Source Decisions",
    "",
    ...(input.run.decisions.length > 0 ? input.run.decisions.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No decisions recorded."]),
    "",
    "## Source Verification",
    "",
    ...(input.run.verification.length > 0 ? input.run.verification.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No verification recorded."]),
  ].join("\n");
}

export async function promoteAlgorithmRunMemory(options: SomaMemoryPromotionOptions): Promise<SomaMemoryPromotionResult> {
  return promoteAlgorithmRunMemoryInternal(options);
}

/**
 * Module-internal: accepts an `onDurable` callback. NOT exported from
 * src/index.ts — only direct module importers (syncAlgorithmRunFromVsa) can
 * reach it. Not a parallel public entrypoint: it delegates to the same
 * promoteAlgorithmRunMemoryInternal as the public single-arg export.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export async function _promoteAlgorithmRunMemoryWithCallback(options: SomaMemoryPromotionOptions, onDurable?: () => void): Promise<SomaMemoryPromotionResult> {
  return promoteAlgorithmRunMemoryInternal({ ...options, onDurable });
}

async function promoteAlgorithmRunMemoryInternal(options: PromotionOptions): Promise<SomaMemoryPromotionResult> {
  assertNonEmpty(options.fromRun, "source run");
  assertNonEmpty(options.title, "title");

  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const { path: sourceRunPath, run } = await readAlgorithmRunById(options.fromRun, { somaHome });
  const lesson = promotionLesson(run, options.lesson);

  if (!hasPromotionVerification(run)) {
    throw new Error(`Algorithm run ${run.id} has no verification evidence or passed criteria; refusing memory promotion.`);
  }

  // Deliberate-escalation gate — see docs/architecture.md Memory section
  // for the full model. Promotion mints a principal-trust durable note; the
  // caller must opt in via `principalAuthority: true` (mirrors
  // `--principal-authority` on `soma memory write`). This PR enforces the gate
  // on the in-repo CLI/SDK/algorithm surfaces; substrate tool wrappers that
  // call promote must pass the matching flag themselves. Fails closed on the
  // in-repo surfaces — an omitted authority is a refusal, not a silent
  // downgrade.
  if (options.principalAuthority !== true) {
    throw new Error(
      `Soma memory promotion of ${run.id} requires --principal-authority (a deliberate, logged escalation) to mint a principal-trust durable note; the option was not provided.`,
    );
  }

  const relativeStore = PROMOTION_STORE_DIRS[options.store];
  // Use the same hashed run-id component as the durable note id (promotionRunIdPart)
  // so the source file cannot collide when a run id slugifies away or shares a
  // long prefix (two runs like "///" and "!!!" would otherwise both slugify to
  // "memory" and hit EEXIST). The title is bounded to leave room for the run
  // suffix within common per-component filename limits (~255 bytes).
  const titleSlugBounded = slugify(options.title).slice(0, 120).replace(/-+$/g, "") || "memory";
  const path = join(somaHome, "memory", relativeStore, "PROMOTED", `${titleSlugBounded}-${promotionRunIdPart(run.id)}.md`);
  const content = `${renderPromotionContent({
    run,
    runPath: sourceRunPath,
    title: options.title,
    store: options.store,
    lesson,
    appliesWhen: options.appliesWhen,
    timestamp,
  })}\n`;

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw new Error(`Soma memory promotion already exists: ${path}`, { cause: error });
    }
    throw error;
  }

  // Mint the durable note at principal trust (extracted to
  // writePromotionMemoryNote below). Ordering: note write BEFORE event append,
  // so a note-write failure only unlinks the PROMOTED file (no event yet
  // exists to orphan). The event-append catch does NOT delete the note (the
  // event log is append-only — deleting would orphan the note's own write
  // event); it leaves self-consistent durable state in place and surfaces the
  // bookkeeping gap. The guaranteed invariant: after each step, the durable
  // memory artifacts that DO exist are mutually consistent
  // (note.source_of_truth -> PROMOTED file, both present).
  const { notePath, noteId } = await writePromotionMemoryNote({
    somaHome,
    substrate: options.substrate ?? run.substrate ?? "custom",
    now: options.timestamp ? new Date(options.timestamp) : new Date(),
    store: options.store,
    title: options.title,
    runId: run.id,
    body: content,
    sourceOfTruth: path,
    promotedFilePath: path,
    principalAuthority: options.principalAuthority === true,
  });

  // The promotion is now DURABLE: the PROMOTED file + principal-trust note are
  // both on disk and mutually consistent (note.source_of_truth -> PROMOTED
  // file). Signal callers BEFORE the bookkeeping steps (event append, run-
  // provenance write) that can still throw — those failures must be surfaced,
  // not swallowed, because the promotion already landed. The callback is
  // fire-and-forget; wrap in try/catch so a throwing callback cannot break the
  // promotion flow.
  try {
    options.onDurable?.();
  } catch {
    // A best-effort callback failure must not abort a promotion that landed.
  }

  const event = await appendSomaMemoryEvent(somaHome, {
    timestamp,
    substrate: options.substrate ?? run.substrate ?? "custom",
    kind: "memory.promotion",
    summary: `Promoted Algorithm run ${run.id} to ${options.store}: ${options.title}`,
    artifactPaths: [path, sourceRunPath],
    metadata: {
      runId: run.id,
      store: options.store,
    },
  }).catch(async (error: unknown) => {
    // The durable artifacts (PROMOTED file + principal-trust note, with the
    // note's own memory.write.create event) are already self-consistent on
    // disk. The event log is append-only, so we CANNOT delete the note to
    // “roll back” — that would orphan its already-recorded write event,
    // producing exactly the half-state the rollback was meant to prevent.
    // The honest model: the promotion became durable (note + source file
    // exist and point at each other); only the memory.promotion bookkeeping
    // event failed to land. Leave the consistent durable state in place and
    // surface the gap so the caller knows the promotion is durable but
    // unrecorded in the event log. A retry hits EEXIST on the PROMOTED file
    // (the idempotency guard) — the promotion already happened.
    throw new Error(
      `Soma memory promotion durable note and file are written at ${path}, but the memory.promotion event append failed (event log is append-only; durable state is left consistent): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });

  await writeAlgorithmRun(
    appendAlgorithmProvenance(run, {
      timestamp,
      operation: "memory.promote",
      substrate: options.substrate,
      detail: options.store,
    }),
    { somaHome },
  );

  return {
    somaHome,
    store: options.store,
    path,
    notePath,
    noteId,
    sourceRunPath,
    event,
  };
}
