import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAlgorithmRunById, writeAlgorithmRun } from "./algorithm-store";
import { appendAlgorithmProvenance } from "./algorithm-provenance";
import { appendSomaMemoryEvent } from "./memory";
import { createPaths } from "./paths";
import { noteIdSlugSegment, toNoteIdSlug } from "./memory-note";
import { writeMemoryNote } from "./memory-write";
import { getCriteria, getGoal } from "./vsa-accessors";
import { getRunPhase } from "./algorithm-lifecycle";
import { SOMA_MEMORY_BACKFILL_TYPE_MAP, SOMA_MEMORY_PROMOTION_STORE_DIRS } from "./types";
import type {
  AlgorithmRun,
  SomaMemoryPromotionOptions,
  SomaMemoryPromotionResult,
  SomaMemoryPromotionStore,
  SubstrateId,
  WritableNoteType,
} from "./types";

/**
 * Internal promotion options — extends the public options with `onDurable`, a
 * fire-and-forget callback invoked the moment the durable artifacts (the
 * PROMOTED file + the principal-trust note) have landed. NOT part of the
 * public SDK contract: only `promoteAlgorithmRunMemoryInternal`'s two callers
 * reach it — the public single-arg `promoteAlgorithmRunMemory`, and
 * `_promoteAlgorithmRunMemoryWithCallback` (module-internal; `syncAlgorithmRunFromVsa`
 * uses it to distinguish a pre-durable refusal, which stays best-effort, from
 * a post-durable bookkeeping failure, which must surface).
 */
interface PromotionOptions extends SomaMemoryPromotionOptions {
  onDurable?: () => void;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Soma memory promotion ${field} must not be empty.`);
  }
}

// These promoted files are plain lesson markdown (no frontmatter `id`), so this
// slug is a FILENAME component, not a note-id field — it keeps its own historical
// 80-char cap (wider than the 64-char note-id cap) rather than the id-grammar
// default. Delegates to the shared, valid-by-construction `toNoteIdSlug`
// (memory-note.ts, #410) instead of re-approximating the grammar locally.
function slugify(value: string): string {
  return toNoteIdSlug(value, { maxLen: 80, fallback: "memory" });
}

// The run id is a promotion's uniqueness key, shared between the durable
// note's id and the PROMOTED filename (both call `promotionRunIdPart`) so the
// two artifacts can never collide independently of one another.
//
// `noteIdSlugSegment` (memory-note.ts, #410) is the shared, valid-by-
// construction slug primitive — this composes on top of the id grammar rather
// than re-approximating it. A run id ALWAYS gets an 8-hex-char sha256 prefix
// (32 bits) appended: slugify normalizes non-alphanumeric runs to a single
// hyphen, so two distinct run ids (e.g. "a/b" and "a:b") can slugify to the
// SAME string, and a run id that slugifies away entirely (e.g. "///") needs
// its own disambiguator. By birthday paradox, a 50% collision probability
// needs ~65k promotions sharing the same title-stem — best-effort collision
// resistance, not a cryptographic guarantee.
const RUN_ID_PART_BUDGET = 24;

function runIdHash8(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 8);
}

function promotionRunIdPart(runId: string): string {
  const hash8 = runIdHash8(runId);
  const slugBudget = RUN_ID_PART_BUDGET - hash8.length - 1; // "-" + hash8
  const stem = noteIdSlugSegment(runId, slugBudget);
  return `${stem.length > 0 ? stem : "run"}-${hash8}`;
}

/**
 * Build the durable note id: `<store>-<title-slug>-<run-part>`, capped at the
 * note-id grammar's 64-char limit ({@link promotionRunIdPart} is budgeted
 * FIRST so a long title can never crowd out the run-id component that
 * disambiguates two promotions sharing a title and store).
 */
export function promotionNoteId(store: SomaMemoryPromotionStore, title: string, runId: string): string {
  const storePrefix = SOMA_MEMORY_PROMOTION_STORE_DIRS[store].toLowerCase();
  const runPart = promotionRunIdPart(runId);
  const overhead = storePrefix.length + 2; // "<store>-" + "-<runPart>"
  const titleBudget = Math.max(0, 64 - overhead - runPart.length);
  const titleSlug = noteIdSlugSegment(title, titleBudget);
  return toNoteIdSlug(`${storePrefix}-${titleSlug}-${runPart}`, { fallback: `${storePrefix}-${runPart}` });
}

// The note TYPE mirrors backfill's category→type map (LEARNING→procedural,
// everything else→semantic — SOMA_MEMORY_BACKFILL_TYPE_MAP, types.ts) so the
// two paths stay interchangeable for the same store: a promoted lesson lands
// at the same type a backfilled one would.
function promotionNoteType(store: SomaMemoryPromotionStore): WritableNoteType {
  return SOMA_MEMORY_BACKFILL_TYPE_MAP[SOMA_MEMORY_PROMOTION_STORE_DIRS[store]] ?? "semantic";
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
  store: SomaMemoryPromotionStore;
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

/**
 * Mint the durable, INDEX-admissible note at principal trust from a
 * promotion. Extracted so `promoteAlgorithmRunMemoryInternal` reads as the
 * promotion's overall flow and this helper owns the note-write/rollback
 * subflow.
 *
 * Authority model (see docs/architecture.md Memory section): the caller MUST
 * have already gated on `principalAuthority === true` — the deliberate-
 * escalation opt-in mirroring `--principal-authority` on `soma memory write`.
 * `hasPromotionVerification` is a PRECONDITION (refuse unverified work), NOT
 * the trust source; trust comes only from this deliberate, logged opt-in.
 *
 * Rollback: this is the FIRST durable step after the PROMOTED file (no
 * `memory.promotion` event has been appended yet). `writeMemoryNote`'s own
 * `createNote` rolls back the note file if ITS OWN event append fails, so if
 * this throws, no note file or note-event exists — unlinking the PROMOTED
 * file is safe (there is no note-event to orphan). The unlink is best-effort:
 * if it fails, the PROMOTED file remains while the error propagates.
 */
async function writePromotionMemoryNote(input: {
  somaHome: string;
  substrate: SubstrateId;
  now: Date;
  store: SomaMemoryPromotionStore;
  title: string;
  runId: string;
  body: string;
  sourceOfTruth: string;
  promotedFilePath: string;
}): Promise<{ notePath: string; noteId: string }> {
  const noteId = promotionNoteId(input.store, input.title, input.runId);
  const result = await writeMemoryNote({
    somaHome: input.somaHome,
    substrate: input.substrate,
    now: input.now,
    mode: "create",
    trigger: "principal-correction",
    principalAuthority: true,
    type: promotionNoteType(input.store),
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
  return { notePath: result.path, noteId: result.note.id };
}

export async function promoteAlgorithmRunMemory(options: SomaMemoryPromotionOptions): Promise<SomaMemoryPromotionResult> {
  return promoteAlgorithmRunMemoryInternal(options);
}

/**
 * Module-internal: accepts an `onDurable` callback. NOT exported from
 * src/index.ts — only a direct module importer (`syncAlgorithmRunFromVsa`)
 * can reach it. Delegates to the SAME `promoteAlgorithmRunMemoryInternal` as
 * the public single-arg export — not a parallel promotion path.
 */
export async function _promoteAlgorithmRunMemoryWithCallback(
  options: SomaMemoryPromotionOptions,
  onDurable?: () => void,
): Promise<SomaMemoryPromotionResult> {
  return promoteAlgorithmRunMemoryInternal({ ...options, onDurable });
}

async function promoteAlgorithmRunMemoryInternal(options: PromotionOptions): Promise<SomaMemoryPromotionResult> {
  assertNonEmpty(options.fromRun, "source run");
  assertNonEmpty(options.title, "title");

  // Deliberate-escalation gate (see docs/architecture.md Memory section).
  // Promotion mints a principal-trust durable note; the caller must opt in via
  // `principalAuthority: true` (mirrors `--principal-authority` on `soma
  // memory write`). Enforced on every in-repo surface (CLI, SDK, algorithm
  // sync-from-isa promote-on-complete) — fails closed: an omitted authority is
  // a refusal, not a silent downgrade. Checked AFTER the verification
  // precondition below (an unverified run is refused for that reason first,
  // regardless of authority) — the two refusals are independent gates, and
  // verification is the more specific one for the caller to fix first.
  const paths = createPaths(options);
  const somaHome = paths.root();
  const timestamp = options.timestamp ?? new Date().toISOString();
  const { path: sourceRunPath, run } = await readAlgorithmRunById(options.fromRun, { somaHome });
  const lesson = promotionLesson(run, options.lesson);

  if (!hasPromotionVerification(run)) {
    throw new Error(`Algorithm run ${run.id} has no verification evidence or passed criteria; refusing memory promotion.`);
  }

  if (!options.principalAuthority) {
    throw new Error(
      "Soma memory promotion requires --principal-authority (a deliberate, logged escalation) to mint a principal-trust durable note; the option was not provided.",
    );
  }

  const promotedDir = paths.promoted(options.store);
  // Share the SAME run-id-derived component between the PROMOTED filename and
  // the durable note id, so the source file can never collide independently
  // of the note that points back at it.
  const runPart = promotionRunIdPart(run.id);
  const path = join(promotedDir, `${slugify(options.title)}-${runPart}.md`);
  const content = `${renderPromotionContent({
    run,
    runPath: sourceRunPath,
    title: options.title,
    store: options.store,
    lesson,
    appliesWhen: options.appliesWhen,
    timestamp,
  })}\n`;

  await mkdir(promotedDir, { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw new Error(`Soma memory promotion already exists: ${path}`, { cause: error });
    }
    throw error;
  }

  const substrate = options.substrate ?? run.substrate ?? "custom";
  const now = options.timestamp ? new Date(options.timestamp) : new Date();

  // Mint the durable note at principal trust. Ordering: note write BEFORE
  // event append, so a note-write failure only unlinks the PROMOTED file (no
  // event yet exists to orphan) — see writePromotionMemoryNote.
  const { notePath, noteId } = await writePromotionMemoryNote({
    somaHome,
    substrate,
    now,
    store: options.store,
    title: options.title,
    runId: run.id,
    body: content,
    sourceOfTruth: path,
    promotedFilePath: path,
  });

  // The promotion is now DURABLE: the PROMOTED file + principal-trust note
  // are both on disk and mutually consistent (note.source_of_truth -> the
  // PROMOTED file). Signal callers BEFORE the remaining bookkeeping steps
  // (event append, run-provenance write) that can still throw — those
  // failures must be surfaced, not swallowed, because the promotion already
  // landed. Fire-and-forget: wrap in try/catch so a throwing callback cannot
  // break a promotion that already succeeded.
  try {
    options.onDurable?.();
  } catch {
    // A best-effort callback failure must not abort a promotion that landed.
  }

  const event = await appendSomaMemoryEvent(somaHome, {
    timestamp,
    substrate,
    kind: "memory.promotion",
    summary: `Promoted Algorithm run ${run.id} to ${options.store}: ${options.title}`,
    artifactPaths: [path, sourceRunPath, notePath],
    metadata: {
      runId: run.id,
      store: options.store,
      noteId,
    },
  }).catch((error: unknown) => {
    // The durable artifacts (PROMOTED file + principal-trust note, with the
    // note's own memory.write.create event) are already self-consistent on
    // disk. The event log is append-only, so we CANNOT delete the note to
    // "roll back" — that would orphan its already-recorded write event,
    // producing exactly the half-state a rollback is meant to prevent. Leave
    // the consistent durable state in place and surface the gap: the
    // promotion is durable but this bookkeeping event failed to land. A retry
    // hits EEXIST on the PROMOTED file (the idempotency guard) — the
    // promotion already happened.
    throw new Error(
      `Soma memory promotion durable note (${noteId}) and file are written at ${path}, but the memory.promotion event append failed (event log is append-only; durable state is left consistent): ${error instanceof Error ? error.message : String(error)}`,
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
