/**
 * Memory subsystem M8 — bulk backfill of legacy free-form markdown into
 * schema-valid, governed notes (plan v2 §"shipping"; see
 * `Plans/declarative-twirling-lampson.md`).
 *
 * A freshly-migrated store has an empty durable corpus (`semantic/` +
 * `procedural/`) but a pile of pre-M0 markdown under category dirs
 * (`LEARNING/`, `KNOWLEDGE/`, …). This command turns that content into notes
 * through the M1 write path, so every governance invariant (schema validation,
 * recall-first dedup, event journaling, trust derivation) is enforced exactly
 * once, in one place.
 *
 * Deterministic by contract:
 *   - No LLM. Bodies are the legacy content VERBATIM — no injected preamble (a
 *     shared preamble would inflate token overlap and make the recall-first
 *     dedup over-fire on short files); origin lives in frontmatter instead.
 *   - Only `.md`/`.markdown` files are imported — non-markdown files under a
 *     category dir (JSON, `.env`, binaries, editor artifacts) are skipped so
 *     they never become garbage notes.
 *   - `created`/`last_verified` come from the source file's mtime, not the clock.
 *   - Trust is ALWAYS `quarantined` — the `import` trigger derives it and no
 *     caller flag can elevate it (MINJA defense). Backfilled notes are recall-
 *     pull-discoverable immediately (with a ⚠ untrusted banner) but stay out of
 *     the always-loaded INDEX until re-authored at higher trust (the INDEX
 *     admission filter excludes quarantined unconditionally, so `verify` — which
 *     only bumps freshness — cannot promote one; principal-correction/supersede can).
 *   - Files are processed SEQUENTIALLY so the recall-first refusal dedups within
 *     the batch deterministically (a later near-duplicate sees earlier writes).
 *
 * Idempotency mirrors `pai-memory-migrator.ts`: a SHA manifest at
 * `memory/STATE/imports/backfill/.manifest.json` lets a rerun skip already-imported files
 * whose source bytes are unchanged and whose target note still exists. A no-op
 * rerun (nothing new written) re-emits each prior manifest entry verbatim and
 * preserves `importedAt`, so the manifest is byte-identical — even if a source
 * was merely `touch`ed (mtime bumped, bytes unchanged).
 */
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { listMemoryNotes } from "./memory-fs";
import { rebuildMemoryIndex } from "./memory-index";
import { MemoryNoteError, toNoteIdSlug, NOTE_ID_MAX_LEN } from "./memory-note";
import { memoryNotePath, writeMemoryNote } from "./memory-write";
import { createPaths } from "./paths";
import { SOMA_MEMORY_BACKFILL_TYPE_MAP } from "./types";
import type {
  SomaMemoryBackfillEntry,
  SomaMemoryBackfillManifest,
  SomaMemoryBackfillManifestEntry,
  SomaMemoryBackfillOptions,
  SomaMemoryBackfillResult,
  SomaPaths,
  WritableNoteType,
} from "./types";

const MANIFEST_SCHEMA = "soma.memory-backfill.v1";
// Backfill is a Memory-subsystem operation, so its bookkeeping lives INSIDE the
// Memory compartment (`memory/`), under STATE (the subsystem's runtime-state dir,
// alongside events.jsonl) — not at the Soma root, via `paths.state(...)`. STATE
// is a reserved category that the source walk never re-imports, and the
// manifest is `.json` (never a markdown source), so it can never round-trip
// into a note.
const MANIFEST_SEGMENTS = ["imports", "backfill", ".manifest.json"] as const;

// Category dirs (or root children) that are never backfill sources: STATE is
// runtime JSON, episodic/semantic/procedural are the note stores themselves,
// archive/imports are subsystem bookkeeping. Matched against the FIRST path
// segment under the source root.
const RESERVED_CATEGORIES = new Set([
  "STATE",
  "episodic",
  "semantic",
  "procedural",
  "archive",
  "imports",
]);

function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Format a Date as YYYY-MM-DD in UTC (the note schema's date grammar). */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Read a source file refusing to follow a symlink at the final path component
 * (`O_NOFOLLOW`). Closes the collect→read TOCTOU: even if a vetted `.md` file is
 * swapped for a symlink to a sensitive target between the walk and the read, the
 * open fails (ELOOP) rather than importing the target's bytes. To also close the
 * *ancestor* race (a vetted directory swapped for a symlink after the walk, which
 * `O_NOFOLLOW` on the leaf would not catch), the opened file's `dev`+`ino` are
 * compared against what the walk `lstat`ed — a redirected ancestor resolves to a
 * different inode and is refused.
 */
async function readSourceNoFollow(path: string, expect: { dev: number; ino: number }): Promise<string> {
  let fh;
  try {
    fh = await open(path, FS.O_RDONLY | FS.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new Error(`Soma memory backfill refused symlink at source path: ${path}`, { cause: error });
    }
    throw error;
  }
  try {
    const st = await fh.stat();
    if (st.dev !== expect.dev || st.ino !== expect.ino) {
      throw new Error(`Soma memory backfill refused source that changed identity between scan and read: ${path}`);
    }
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Slugify `<category>-<stem>` into a note id — delegates to the shared,
 * valid-by-construction `toNoteIdSlug` (memory-note.ts, #410) next to the
 * id-grammar definition, so this call site never re-approximates the grammar
 * or re-validates the result.
 */
function slugifyId(category: string, stem: string): string {
  return toNoteIdSlug(`${category}-${stem}`, { fallback: "note" });
}

/** True iff a note with `id` already exists as either a semantic or procedural note. */
async function noteExists(somaHome: string, id: string): Promise<boolean> {
  return (
    (await pathExists(memoryNotePath(somaHome, "semantic", id))) ||
    (await pathExists(memoryNotePath(somaHome, "procedural", id)))
  );
}

/**
 * Resolve a unique note id from a base slug, suffixing `-2`, `-3`, … against
 * both the existing corpus and the ids already claimed in this run. The base is
 * trimmed to leave room for the suffix so the result stays ≤ NOTE_ID_MAX_LEN chars.
 */
async function uniqueNoteId(somaHome: string, base: string, used: Set<string>): Promise<string> {
  if (!used.has(base) && !(await noteExists(somaHome, base))) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, NOTE_ID_MAX_LEN - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(candidate) && !(await noteExists(somaHome, candidate))) return candidate;
  }
}

/** A single humanized recall-trigger line from the filename stem (no newlines). */
function hookFromStem(stem: string): string {
  return stem
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

interface SourceFile {
  relativePath: string; // POSIX, under the source root
  absPath: string;
  category: string; // first path segment
  stem: string;
  mtimeMs: number;
  dev: number; // captured at scan; re-checked at read to catch ancestor-symlink swaps
  ino: number;
}

// Markdown is the only backfill input: a category dir may hold JSON, `.env`,
// exports, or binaries that would become garbage (or sensitive) notes if read as
// UTF-8 and imported. Restrict to markdown extensions.
const MARKDOWN_EXT = /\.(?:md|markdown)$/i;

/**
 * Recursively collect eligible source files under `root`. Imports only markdown
 * files; skips reserved categories, root-level files (READMEs/INDEX territory),
 * any README.md, and non-markdown files; refuses symlinks loudly (matching the
 * migrators' stance). Returns entries sorted by relative path for deterministic
 * ordering.
 *
 * The recursive walk and its symlink refusal go through the shared
 * `listMemoryNotes` seam (#408) with `onSymlink: "throw"` — backfill is the one
 * caller among the seam's four re-derivations that wants ANY symlink (not
 * just a mid-walk swap) to abort the whole scan loudly, since it is importing
 * arbitrary legacy content into governed notes and must never silently follow
 * a symlink's target. The category/README/root-file filtering stays here (via
 * `include`) — it is backfill's own business rule, not a traversal-safety
 * concern the seam should know about. The source ROOT's own symlink refusal
 * also stays here (its own explicit message) — `listMemoryNotes` treats an
 * abnormal ROOT as empty, matching every OTHER caller, so a `--from` pointing
 * at a symlink is checked as a precondition before the walk begins.
 */
async function collectSources(root: string, skipRootFiles: boolean): Promise<SourceFile[]> {
  // Refuse a symlinked source ROOT up front — the seam walk below only guards
  // entries *within* an already-vetted directory, so without this a `--from`
  // pointing at a symlink would be traversed. A non-existent root simply
  // yields no sources.
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Soma memory backfill refused symlink source root: ${root}`);
  }
  // A regular-file `--from` used to surface ENOTDIR from `readdir`; the seam
  // treats a non-directory root as empty, so reject it explicitly here rather
  // than silently reporting no sources.
  if (!rootStat.isDirectory()) {
    throw new Error(`Soma memory backfill source root is not a directory: ${root}`);
  }

  const paths = await listMemoryNotes(root, {
    recursive: true,
    onSymlink: "throw",
    extensions: [], // markdown matching (case-insensitive, .md/.markdown) is done in `include` below
    sort: false, // backfill re-sorts its SourceFiles by POSIX relativePath below — skip the seam's redundant abspath sort
    include: ({ name, depth, isDirectory }) => {
      if (isDirectory) {
        // Reserved top-level names (the note stores + STATE/archive/imports)
        // are never descended into — they are subsystem territory, not sources.
        return !(depth === 0 && RESERVED_CATEGORIES.has(name));
      }
      // A file directly under the root is README/INDEX territory ONLY for the
      // default memory root; a custom `--from <dir>` may legitimately hold its
      // markdown right at the top, so those are imported (category "" → semantic).
      if (depth === 0 && skipRootFiles) return false;
      if (/^readme\.(?:md|markdown)$/i.test(name)) return false;
      return MARKDOWN_EXT.test(name);
    },
  });

  const files: SourceFile[] = [];
  for (const abs of paths) {
    const rel = relative(root, abs).split(sep).join("/");
    const category = rel.includes("/") ? rel.split("/")[0] : "";
    // A file can vanish between the walk and this `lstat` (concurrent cleanup).
    // Skip it rather than aborting the whole scan; a genuinely broken FS still throws.
    let stat;
    try {
      stat = await lstat(abs);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    files.push({
      relativePath: rel,
      absPath: abs,
      category,
      stem: basename(abs).replace(/\.[^.]+$/, ""),
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
    });
  }
  return files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

function resolveType(
  options: SomaMemoryBackfillOptions,
  category: string,
): WritableNoteType {
  if (options.type) return options.type;
  return SOMA_MEMORY_BACKFILL_TYPE_MAP[category] ?? "semantic";
}

/**
 * Read the manifest once into a `relativePath → full entry` map (the whole
 * record, not just the SHA), so the run loop can check the SHA, reuse the note
 * id/type, and re-emit the prior entry verbatim without re-reading the file per
 * source. Also returns the recorded source root so the caller can reject a
 * manifest built for a *different* `--from` (relative paths would false-hit).
 * Returns null only when the manifest is absent, unreadable, non-JSON, or its
 * `files` is not an array — a structurally-valid-but-semantically-odd manifest
 * is accepted (each entry is still re-validated against the corpus + SHA at use).
 */
async function readManifest(
  paths: SomaPaths,
): Promise<{ map: Map<string, SomaMemoryBackfillManifestEntry>; importedAt: string; from: string } | null> {
  const path = paths.state(...MANIFEST_SEGMENTS);
  if (!(await pathExists(path))) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SomaMemoryBackfillManifest;
    if (!Array.isArray(parsed.files)) return null;
    const map = new Map<string, SomaMemoryBackfillManifestEntry>();
    for (const entry of parsed.files) map.set(entry.relativePath, entry);
    return { map, importedAt: parsed.importedAt, from: parsed.from };
  } catch {
    return null;
  }
}

/**
 * Plan the backfill without touching anything — a thin wrapper over the single
 * manifest-aware core in {@link runMemoryBackfill}, so the preview reflects
 * exactly what a real run would do (manifest hits show as `skipped-manifest`, not
 * as fresh imports). Near-duplicate detection is still NOT part of the plan — it
 * needs the corpus scan the write path performs, so a real run may additionally
 * skip some `would-import` files as duplicates.
 */
export async function planMemoryBackfill(
  options: SomaMemoryBackfillOptions = {},
): Promise<SomaMemoryBackfillResult> {
  return runMemoryBackfill({ ...options, dryRun: true });
}

/**
 * The single backfill core. Reads the (root-gated) manifest, then per source:
 * re-emits a `skipped-manifest` entry for an unchanged prior import, else writes
 * the file as a `quarantined` note via the M1 write path — sequentially, so
 * intra-batch dedup is deterministic. With `dryRun`, every step runs EXCEPT the
 * note write, manifest write, and INDEX rebuild: would-import entries carry no
 * status (a plan), manifest hits still show as `skipped-manifest`.
 */
export async function runMemoryBackfill(
  options: SomaMemoryBackfillOptions = {},
): Promise<SomaMemoryBackfillResult> {
  const paths = createPaths(options);
  const somaHome = paths.root();
  const defaultRoot = paths.memory();
  const from = resolve(options.from ?? defaultRoot);
  const manifestPath = paths.state(...MANIFEST_SEGMENTS);
  const dryRun = options.dryRun ?? false;

  const sources = await collectSources(from, from === defaultRoot);
  // The manifest lives at one path per soma-home but its relative paths are keyed
  // to the root it was built for. A rerun against a DIFFERENT `--from` must not
  // treat same-relative-path files as hits — ignore a manifest built elsewhere
  // (the run then rewrites it for the current root).
  const rawPrevious = await readManifest(paths);
  const previous = rawPrevious?.from === from ? rawPrevious : null;

  const used = new Set<string>();
  const entries: SomaMemoryBackfillEntry[] = [];
  const manifestFiles: SomaMemoryBackfillManifest["files"] = [];
  let writtenCount = 0;
  let skippedManifestCount = 0;
  let skippedDuplicateCount = 0;
  let errorCount = 0;

  for (const src of sources) {
    // `type` and `created` are pure (no I/O) — safe to compute before the try so
    // an error entry can still report them if a later fallible step throws.
    const type = resolveType(options, src.category);
    const created = isoDate(new Date(src.mtimeMs));
    // `id` is assigned once allocated; a read failure before allocation leaves it
    // empty, which the error entry reports as an unknown target.
    let id = "";

    try {
      // EVERY fallible step lives inside the try so a single bad source (deleted,
      // unreadable, symlink-swapped, identity-changed, or a write/dedup refusal)
      // becomes a per-file entry — never a batch abort.
      const content = await readSourceNoFollow(src.absPath, { dev: src.dev, ino: src.ino });
      const sha = sha256Hex(content);

      // Already backfilled and unchanged (same bytes AND same resolved type) with
      // its note still present? Re-emit the PRIOR manifest entry VERBATIM (including
      // its stored mtimeMs) so a no-op rerun is byte-stable even if the source was
      // merely `touch`ed. The type guard keeps `--type` honest: rerunning with a
      // different --type than a prior import is NOT a hit — it falls through to the
      // write path (where the identical body is caught by the recall-first gate).
      const prior = previous?.map.get(src.relativePath);
      if (prior?.sha256 === sha && prior.type === type) {
        if (await pathExists(memoryNotePath(somaHome, prior.type, prior.noteId))) {
          entries.push({
            relativePath: src.relativePath,
            source: src.absPath,
            noteId: prior.noteId,
            type: prior.type,
            created,
            target: memoryNotePath(somaHome, prior.type, prior.noteId),
            status: "skipped-manifest",
          });
          manifestFiles.push({ ...prior });
          used.add(prior.noteId);
          skippedManifestCount += 1;
          continue;
        }
      }

      id = await uniqueNoteId(somaHome, slugifyId(src.category, src.stem), used);
      used.add(id);
      const target = memoryNotePath(somaHome, type, id);

      if (dryRun) {
        // A plan entry (no status) — a real run would write this, unless the
        // corpus scan (only done at write time) reveals it as a near-duplicate.
        entries.push({ relativePath: src.relativePath, source: src.absPath, noteId: id, type, created, target });
        continue;
      }

      const hook = hookFromStem(src.stem);
      await writeMemoryNote({
        somaHome,
        substrate: options.substrate,
        now: new Date(src.mtimeMs),
        mode: "create",
        trigger: "import",
        type,
        id,
        // Body is the legacy content VERBATIM — no boilerplate preamble. A shared
        // preamble would inflate token overlap and make the recall-first dedup
        // over-fire on short files; the origin lives in frontmatter instead
        // (provenance: import, source_of_truth: <path>), which recall surfaces.
        body: content,
        provenance: "import",
        sourceOfTruth: src.absPath,
        project: options.project ?? null,
        ...(hook ? { hook } : {}),
      });
      entries.push({
        relativePath: src.relativePath,
        source: src.absPath,
        noteId: id,
        type,
        created,
        target,
        status: "written",
      });
      manifestFiles.push({ relativePath: src.relativePath, noteId: id, type, sha256: sha, mtimeMs: src.mtimeMs });
      writtenCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isDuplicate = error instanceof MemoryNoteError && message.startsWith("Recall-first refusal:");
      entries.push({
        relativePath: src.relativePath,
        source: src.absPath,
        noteId: id,
        type,
        created,
        target: id ? memoryNotePath(somaHome, type, id) : "",
        status: isDuplicate ? "skipped-duplicate" : "error",
        detail: message,
      });
      // Release a tentatively-claimed id: a duplicate maps to an existing note
      // (not recorded in the manifest → re-scanned next run); an error produced no
      // note at all. A read failure before allocation leaves id empty (no-op).
      if (id) used.delete(id);
      if (isDuplicate) skippedDuplicateCount += 1;
      else errorCount += 1;
    }
  }

  // A dry-run previews only — it never touches the manifest or the INDEX.
  if (!dryRun) {
    // Manifest reflects exactly the files currently backfilled to a present note
    // (written this run + previously-written-and-still-present). Vanished sources
    // drop out; duplicates are excluded (they map to a note this run did not own).
    await mkdir(dirname(manifestPath), { recursive: true });
    const importedAt =
      writtenCount === 0 && previous ? previous.importedAt : (options.now ?? new Date()).toISOString();
    const manifest: SomaMemoryBackfillManifest = {
      schema: MANIFEST_SCHEMA,
      somaHome,
      from,
      importedAt,
      files: manifestFiles.sort((a, b) =>
        a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
      ),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // Rebuild the INDEX after writing notes so the store stays audit-clean: fresh
    // note files are newer than INDEX.md, which would fail the audit's index-freshness
    // probe until a rebuild. Quarantined imports never earn an INDEX line (admission
    // filter), so this refreshes INDEX.md's mtime without surfacing untrusted content.
    if (writtenCount > 0) {
      await rebuildMemoryIndex({ somaHome });
    }
  }

  return {
    somaHome,
    from,
    dryRun,
    writtenCount,
    skippedManifestCount,
    skippedDuplicateCount,
    errorCount,
    manifestPath,
    entries,
  };
}
