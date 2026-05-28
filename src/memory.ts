import { mkdir, appendFile, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
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

function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9\u00c0-\u024f]+/i)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3),
    ),
  );
}

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
    return {
      query: options.query,
      somaHome,
      matches: [],
    };
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

  return {
    query: options.query,
    somaHome,
    matches: matches.slice(0, limit),
  };
}
