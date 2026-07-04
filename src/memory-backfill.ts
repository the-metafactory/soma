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
 *     the always-loaded INDEX until a human verifies/elevates them.
 *   - Files are processed SEQUENTIALLY so the recall-first refusal dedups within
 *     the batch deterministically (a later near-duplicate sees earlier writes).
 *
 * Idempotency mirrors `pai-memory-migrator.ts`: a SHA manifest at
 * `imports/backfill/.manifest.json` lets a rerun skip already-imported files
 * whose source bytes are unchanged and whose target note still exists. A no-op
 * rerun (nothing new written) re-emits each prior manifest entry verbatim and
 * preserves `importedAt`, so the manifest is byte-identical — even if a source
 * was merely `touch`ed (mtime bumped, bytes unchanged).
 */
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { MemoryNoteError } from "./memory-note";
import { memoryNotePath, writeMemoryNote } from "./memory-write";
import { SOMA_MEMORY_BACKFILL_TYPE_MAP } from "./types";
import type {
  SomaMemoryBackfillEntry,
  SomaMemoryBackfillManifest,
  SomaMemoryBackfillManifestEntry,
  SomaMemoryBackfillOptions,
  SomaMemoryBackfillResult,
  WritableNoteType,
} from "./types";

const MANIFEST_SCHEMA = "soma.memory-backfill.v1";
// Backfill is a Memory-subsystem operation, so its bookkeeping lives INSIDE the
// Memory compartment (`memory/`), under STATE (the subsystem's runtime-state dir,
// alongside events.jsonl) — not at the Soma root. STATE is a reserved category
// that the source walk never re-imports, and the manifest is `.json` (never a
// markdown source), so it can never round-trip into a note.
const MANIFEST_RELATIVE = "memory/STATE/imports/backfill/.manifest.json";
const MANIFEST_DIR_RELATIVE = "memory/STATE/imports/backfill";

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

function resolveSomaHome(options: SomaMemoryBackfillOptions): string {
  return resolve(options.somaHome ?? join(resolve(options.homeDir ?? homedir()), ".soma"));
}

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
 * open fails (ELOOP) rather than importing the target's bytes. The walk already
 * rejects symlink *directories* in the tree.
 */
async function readSourceNoFollow(path: string): Promise<string> {
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
 * Slugify `<category>-<stem>` into a note id: lowercase, non-alphanumeric runs
 * collapse to a single hyphen, no leading/trailing/double hyphens, ≤64 chars.
 * Matches the note SLUG grammar (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, id ≤ 64).
 */
function slugifyId(category: string, stem: string): string {
  const raw = `${category}-${stem}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return raw || "note";
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
 * trimmed to leave room for the suffix so the result stays ≤ 64 chars.
 */
async function uniqueNoteId(somaHome: string, base: string, used: Set<string>): Promise<string> {
  if (!used.has(base) && !(await noteExists(somaHome, base))) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
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
 */
async function collectSources(root: string, skipRootFiles: boolean): Promise<SourceFile[]> {
  const files: SourceFile[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`Soma memory backfill refused symlink path: ${rel}`);
      }
      // Reserved top-level names (the note stores + STATE/archive/imports) are
      // never descended into — they are subsystem territory, not sources.
      if (depth === 0 && RESERVED_CATEGORIES.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await visit(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      // A file directly under the root is README/INDEX territory ONLY for the
      // default memory root; a custom `--from <dir>` may legitimately hold its
      // markdown right at the top, so those are imported (category "" → semantic).
      if (depth === 0 && skipRootFiles) continue;
      if (/^readme\.md$/i.test(entry.name)) continue;
      if (!MARKDOWN_EXT.test(entry.name)) continue;
      const category = rel.includes("/") ? rel.split("/")[0] : "";
      const stat = await lstat(abs);
      files.push({
        relativePath: rel,
        absPath: abs,
        category,
        stem: entry.name.replace(/\.[^.]+$/, ""),
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  await visit(root, 0);
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
 * source. Returns null when the manifest is missing or corrupt (→ re-import).
 */
async function readManifest(
  somaHome: string,
): Promise<{ map: Map<string, SomaMemoryBackfillManifestEntry>; importedAt: string } | null> {
  const path = join(somaHome, MANIFEST_RELATIVE);
  if (!(await pathExists(path))) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SomaMemoryBackfillManifest;
    if (!Array.isArray(parsed.files)) return null;
    const map = new Map<string, SomaMemoryBackfillManifestEntry>();
    for (const entry of parsed.files) map.set(entry.relativePath, entry);
    return { map, importedAt: parsed.importedAt };
  } catch {
    return null;
  }
}

/**
 * Plan the backfill without touching anything: which source files map to which
 * note id/type/target. Duplicate detection is NOT part of the plan — it needs a
 * corpus scan at write time, so a real run may additionally skip near-duplicates.
 */
export async function planMemoryBackfill(
  options: SomaMemoryBackfillOptions = {},
): Promise<SomaMemoryBackfillResult> {
  const somaHome = resolveSomaHome(options);
  const defaultRoot = resolve(join(somaHome, "memory"));
  const from = resolve(options.from ?? defaultRoot);
  const sources = await collectSources(from, from === defaultRoot);

  const used = new Set<string>();
  const entries: SomaMemoryBackfillEntry[] = [];
  for (const src of sources) {
    const type = resolveType(options, src.category);
    const id = await uniqueNoteId(somaHome, slugifyId(src.category, src.stem), used);
    used.add(id);
    entries.push({
      relativePath: src.relativePath,
      source: src.absPath,
      noteId: id,
      type,
      created: isoDate(new Date(src.mtimeMs)),
      target: memoryNotePath(somaHome, type, id),
    });
  }

  return {
    somaHome,
    from,
    dryRun: true,
    writtenCount: 0,
    skippedManifestCount: 0,
    skippedDuplicateCount: 0,
    errorCount: 0,
    manifestPath: join(somaHome, MANIFEST_RELATIVE),
    entries,
  };
}

/**
 * Run the backfill. Writes each eligible source file as a `quarantined` note via
 * the M1 write path, sequentially so intra-batch dedup is deterministic. Returns
 * a per-file account; `--dry-run` returns the plan without writing or touching
 * the manifest.
 */
export async function runMemoryBackfill(
  options: SomaMemoryBackfillOptions = {},
): Promise<SomaMemoryBackfillResult> {
  const somaHome = resolveSomaHome(options);
  const defaultRoot = resolve(join(somaHome, "memory"));
  const from = resolve(options.from ?? defaultRoot);
  const manifestPath = join(somaHome, MANIFEST_RELATIVE);

  if (options.dryRun) {
    return planMemoryBackfill(options);
  }

  const sources = await collectSources(from, from === defaultRoot);
  const previous = await readManifest(somaHome);

  const used = new Set<string>();
  const entries: SomaMemoryBackfillEntry[] = [];
  const manifestFiles: SomaMemoryBackfillManifest["files"] = [];
  let writtenCount = 0;
  let skippedManifestCount = 0;
  let skippedDuplicateCount = 0;
  let errorCount = 0;

  for (const src of sources) {
    const type = resolveType(options, src.category);
    const content = await readSourceNoFollow(src.absPath);
    const sha = sha256Hex(content);
    const created = isoDate(new Date(src.mtimeMs));

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

    const id = await uniqueNoteId(somaHome, slugifyId(src.category, src.stem), used);
    used.add(id);
    const target = memoryNotePath(somaHome, type, id);
    const hook = hookFromStem(src.stem);

    try {
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
        target,
        status: isDuplicate ? "skipped-duplicate" : "error",
        detail: message,
      });
      if (isDuplicate) {
        // A near/exact duplicate already lives in the corpus — the desired
        // outcome, not a failure. It is NOT recorded in the manifest (no note
        // was created for this file); a later rerun re-scans and re-skips it.
        used.delete(id);
        skippedDuplicateCount += 1;
      } else {
        used.delete(id);
        errorCount += 1;
      }
    }
  }

  // Manifest reflects exactly the files currently backfilled to a present note
  // (written this run + previously-written-and-still-present). Vanished sources
  // drop out; duplicates are excluded (they map to a note this run did not own).
  await mkdir(join(somaHome, MANIFEST_DIR_RELATIVE), { recursive: true });
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

  return {
    somaHome,
    from,
    dryRun: false,
    writtenCount,
    skippedManifestCount,
    skippedDuplicateCount,
    errorCount,
    manifestPath,
    entries,
  };
}
