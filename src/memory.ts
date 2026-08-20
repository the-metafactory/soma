import { mkdir, appendFile, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import { memoryTerms } from "./memory-terms";
import { createPaths } from "./paths";
import type {
  SomaMemoryEvent,
  SomaMemoryEventInput,
  SomaMemorySearchMatch,
  SomaMemorySearchOptions,
  SomaMemorySearchResult,
  SomaMemorySearchSourceClass,
} from "./types";

/**
 * Roots outside `memory/` that search covers. Everything INSIDE `memory/` is
 * discovered by reading the directory, not listed here.
 *
 * This used to be one flat whitelist naming eight paths, and it drifted: the
 * curated durable notes in `memory/procedural` and `memory/semantic` were never
 * in it, so they were unreachable by `soma memory search` at any `--limit`
 * (#453). The reported symptom was bad ranking; the cause was that those
 * directories were not searched at all.
 *
 * Discovery removes the "new store is invisible" half of that failure. It does
 * NOT remove the other half on its own: a newly-added store is read, but ranked
 * as `archive` until someone names it in `CURATED_NOTE_DIRS`.
 */
const FIXED_SEARCH_ROOTS = ["profile", "identity"] as const;

/**
 * Directories under `memory/` that search skips, each for its own reason.
 *
 *   - `STATE` — operational bookkeeping: the event log, work indices, import
 *     manifests. Search appends its own `memory.recall` event here, so
 *     including it lets a search match the record of previous searches.
 *     Reachable with `--include-state`.
 *   - `archive` — where `consolidate` moves aged notes. Per
 *     docs/architecture.md §Memory the move IS the invalidation ("no
 *     `valid_until` field is stamped"), so surfacing these as ordinary results
 *     would re-admit content the maintenance pass deliberately retired.
 *   - `SECURITY` — private security traces (docs/inbound-content-security.md,
 *     docs/governance-event-runtime-policy.md). A distinct-purpose store, not
 *     memory content to rank alongside WORK/KNOWLEDGE.
 */
const STATE_MEMORY_DIR = "STATE";
const EXCLUDED_MEMORY_DIRS = new Set<string>([STATE_MEMORY_DIR, "archive", "SECURITY"]);

/**
 * Directories under `memory/` holding curated durable notes, which rank above
 * the archive at equal term score.
 *
 * Listed positively rather than derived from `SOMA_MEMORY_NOTE_TYPES`, so a
 * note type added later has to be ranked deliberately instead of becoming
 * top-tier by silent inheritance. `episodic` is absent for that reason too:
 * session digests record what happened rather than distilling it, and they
 * carry the archive's vocabulary.
 */
const CURATED_NOTE_DIRS = new Set<string>(["semantic", "procedural"]);

const SEARCH_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".toml"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git"]);

function createEventId(): string {
  return `evt_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Soma memory event ${field} must not be empty.`);
  }
}

export async function appendSomaMemoryEvent(somaHome: string, input: SomaMemoryEventInput): Promise<SomaMemoryEvent> {
  const [event] = await appendSomaMemoryEvents(somaHome, [input]);
  return event;
}

export async function appendSomaMemoryEvents(somaHome: string, inputs: readonly SomaMemoryEventInput[]): Promise<SomaMemoryEvent[]> {
  if (inputs.length === 0) return [];
  const events = inputs.map((input) => {
    assertNonEmpty(input.substrate, "substrate");
    assertNonEmpty(input.kind, "kind");
    assertNonEmpty(input.summary, "summary");

    return {
      id: input.id ?? createEventId(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      substrate: input.substrate,
      kind: input.kind,
      summary: input.summary,
      artifactPaths: input.artifactPaths,
      metadata: input.metadata,
    };
  });
  const eventPath = createPaths(somaHome).events();

  await mkdir(dirname(eventPath), { recursive: true });
  await appendFile(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  return events;
}

export function somaMemoryEventsPath(somaHome: string): string {
  return createPaths(somaHome).events();
}

function resolveSomaHome(options: Pick<SomaMemorySearchOptions, "homeDir" | "somaHome"> = {}): string {
  return createPaths(options).root();
}

// The memory tokenizer lives in one place (memory-terms.ts) so recall, search,
// and the write-path dedup floor can't drift on what counts as a term.
const queryTerms = memoryTerms;

async function collectSearchFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(path: string): Promise<void> {
    const info = await stat(path).catch(() => undefined);
    if (!info) return;

    if (info.isDirectory()) {
      if (SKIP_DIRECTORIES.has(basename(path))) return;
      const entries = await readdir(path);
      await Promise.all(entries.map((entry) => visit(join(path, entry))));
      return;
    }

    if (info.isFile() && SEARCH_EXTENSIONS.has(extname(path).toLowerCase())) {
      files.push(path);
    }
  }

  await visit(root);
  return files;
}

function scoreLine(line: string, terms: string[]): number {
  const normalized = line.toLowerCase();

  return terms.reduce((score, term) => {
    if (normalized.includes(term)) return score + 1;
    return score;
  }, 0);
}

const SOURCE_CLASS_RANK: Record<SomaMemorySearchSourceClass, number> = {
  note: 2,
  archive: 1,
  state: 0,
};

/**
 * Every directory search should read: the fixed roots, plus each directory under
 * `memory/` as it exists on disk.
 */
async function resolveSearchRoots(somaHome: string, includeState: boolean): Promise<string[]> {
  const fixed = FIXED_SEARCH_ROOTS.map((root) => join(somaHome, root));
  const memoryRoot = join(somaHome, "memory");

  let entries;
  try {
    entries = await readdir(memoryRoot, { withFileTypes: true });
  } catch (err) {
    // A missing memory tree is a legitimate state (fresh home). Anything else —
    // EACCES, EIO — must surface: swallowing it would silently reduce search to
    // two roots and report the empty result as an answer, which is the failure
    // mode this whole change exists to remove.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return fixed;
  }

  const searchable = entries.filter((entry) => !SKIP_DIRECTORIES.has(entry.name));
  const memoryDirs = searchable
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !isExcludedMemoryDir(entry.name, includeState))
    .map((entry) => join(memoryRoot, entry.name));
  // Files sitting directly in `memory/` — the generated INDEX.md among them —
  // belong to no store and would otherwise be unreachable.
  const memoryFiles = searchable
    .filter((entry) => entry.isFile())
    .map((entry) => join(memoryRoot, entry.name));

  return [...fixed, ...memoryDirs, ...memoryFiles];
}

function isExcludedMemoryDir(name: string, includeState: boolean): boolean {
  if (includeState && name === STATE_MEMORY_DIR) return false;
  return EXCLUDED_MEMORY_DIRS.has(name);
}

/**
 * Which corpus a file belongs to. `profile` and `identity` are curated by the
 * principal, so they rank with the notes rather than with the raw archive.
 */
function classifySearchSource(somaHome: string, path: string): SomaMemorySearchSourceClass {
  const memoryPrefix = join(somaHome, "memory") + sep;
  if (!path.startsWith(memoryPrefix)) return "note";
  const dir = path.slice(memoryPrefix.length).split(sep)[0] ?? "";
  if (CURATED_NOTE_DIRS.has(dir)) return "note";
  if (dir === STATE_MEMORY_DIR) return "state";
  return "archive";
}

export async function searchSomaMemory(options: SomaMemorySearchOptions): Promise<SomaMemorySearchResult> {
  assertNonEmpty(options.query, "search query");

  const somaHome = resolveSomaHome(options);
  const terms = queryTerms(options.query);
  const limit = options.limit ?? 8;

  if (terms.length === 0) {
    // No searchable terms → nothing was consulted, so NO memory.recall event.
    // memory_loop_closure counts recalls as deliberate consultation and is very
    // sensitive; a zero-term "search" (all stopwords) is not a read and must not
    // inflate it. (recallMemory deliberately DOES emit on its empty path — it
    // feeds a distinct empty-recall-rate metric; search has no such consumer.)
    return { query: options.query, somaHome, matches: [] };
  }

  const roots = await resolveSearchRoots(somaHome, options.includeState === true);
  const files = (await Promise.all(roots.map(collectSearchFiles))).flat();
  const matches: SomaMemorySearchMatch[] = [];

  for (const path of files) {
    const content = await readFile(path, "utf8").catch(() => "");
    const lines = content.split("\n");
    const sourceClass = classifySearchSource(somaHome, path);

    for (const [index, line] of lines.entries()) {
      const score = scoreLine(line, terms);
      if (score === 0) continue;

      matches.push({
        path,
        line: index + 1,
        score,
        snippet: line.trim().slice(0, 240),
        sourceClass,
      });
    }
  }

  // Score first, then class. Term score alone ties almost everything — a
  // two-term query scores 2 on every line containing both — and whatever broke
  // that tie decided the result, which was `localeCompare` on the absolute
  // path: `LEARNING/` before `procedural/` is alphabetical order, not a
  // relevance judgement (#453).
  //
  // Class breaks the tie rather than overriding the score. Ranking class first
  // would put a note matching one of three query terms above an archive line
  // matching all three, which is a different bug in the same place.
  matches.sort(
    (left, right) =>
      right.score - left.score ||
      SOURCE_CLASS_RANK[right.sourceClass] - SOURCE_CLASS_RANK[left.sourceClass] ||
      left.path.localeCompare(right.path) ||
      left.line - right.line,
  );

  const result: SomaMemorySearchResult = { query: options.query, somaHome, matches: matches.slice(0, limit) };
  await appendSearchRecallEvent(somaHome, options, terms, result);
  return result;
}

/**
 * The read-side instrumentation the 2026-07-10 proxy-drift audit called for:
 * `searchSomaMemory` (the legacy line-grep) was the one memory read path that
 * left no trace, so memory read as write-only (74 writes vs 1 recall event).
 * Every search now appends ONE observational `memory.recall` event — same kind
 * `recallMemory` emits, so `memory_loop_closure` counts it without change; the
 * `via: "search"` tag distinguishes the grep path from note-aware recall.
 *
 * Observational only: search touches no note frontmatter and confers no
 * freshness (that is the authority-gated `used`/resurface act). Best-effort —
 * a telemetry append failure must not fail the read the caller asked for.
 */
async function appendSearchRecallEvent(
  somaHome: string,
  options: SomaMemorySearchOptions,
  terms: string[],
  result: SomaMemorySearchResult,
): Promise<void> {
  try {
    await appendSomaMemoryEvent(somaHome, {
      timestamp: options.now?.toISOString(),
      substrate: options.substrate ?? "custom",
      kind: "memory.recall",
      summary: `Searched memory for "${result.query}" (${result.matches.length} line match(es))`,
      metadata: {
        via: "search",
        query: result.query,
        terms,
        resultCount: result.matches.length,
      },
    });
  } catch {
    // Telemetry is best-effort; the search result is what the caller needs.
  }
}
