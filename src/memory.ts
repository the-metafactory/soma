import { mkdir, appendFile, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { memoryTerms } from "./memory-terms";
import { createPaths } from "./paths";
import type {
  SomaMemoryEvent,
  SomaMemoryEventInput,
  SomaMemorySearchOptions,
  SomaMemorySearchResult,
} from "./types";

const SEARCH_ROOTS = [
  "profile",
  "memory/WORK",
  "memory/KNOWLEDGE",
  "memory/LEARNING",
  "memory/WISDOM",
  "memory/RELATIONSHIP",
  "memory/STATE",
  "identity",
] as const;

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

  const roots = SEARCH_ROOTS.map((root) => join(somaHome, root));
  const files = (await Promise.all(roots.map(collectSearchFiles))).flat();
  const matches = [];

  for (const path of files) {
    const content = await readFile(path, "utf8").catch(() => "");
    const lines = content.split("\n");

    for (const [index, line] of lines.entries()) {
      const score = scoreLine(line, terms);
      if (score === 0) continue;

      matches.push({
        path,
        line: index + 1,
        score,
        snippet: line.trim().slice(0, 240),
      });
    }
  }

  matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line);

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
