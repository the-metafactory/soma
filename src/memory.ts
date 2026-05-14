import { mkdir, appendFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { readAlgorithmRunById } from "./algorithm-store";
import type {
  AlgorithmRun,
  SomaMemoryEvent,
  SomaMemoryEventInput,
  SomaMemoryPromotionOptions,
  SomaMemoryPromotionResult,
  SomaMemorySearchOptions,
  SomaMemorySearchResult,
} from "./types";

const SEARCH_ROOTS = [
  "profile",
  "memory/WORK",
  "memory/KNOWLEDGE",
  "memory/LEARNING",
  "memory/RELATIONSHIP",
  "memory/STATE",
] as const;

const SEARCH_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".toml"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git"]);
const PROMOTION_STORE_DIRS = {
  learning: "LEARNING",
  knowledge: "KNOWLEDGE",
  relationship: "RELATIONSHIP",
  work: "WORK",
} as const;

function createEventId(): string {
  return `evt_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Soma memory event ${field} must not be empty.`);
  }
}

export async function appendSomaMemoryEvent(somaHome: string, input: SomaMemoryEventInput): Promise<SomaMemoryEvent> {
  assertNonEmpty(input.substrate, "substrate");
  assertNonEmpty(input.kind, "kind");
  assertNonEmpty(input.summary, "summary");

  const event: SomaMemoryEvent = {
    id: input.id ?? createEventId(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    substrate: input.substrate,
    kind: input.kind,
    summary: input.summary,
    artifactPaths: input.artifactPaths,
    metadata: input.metadata,
  };
  const eventPath = resolve(somaHome, "memory/STATE/events.jsonl");

  await mkdir(dirname(eventPath), { recursive: true });
  await appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");

  return event;
}

export function somaMemoryEventsPath(somaHome: string): string {
  return join(somaHome, "memory/STATE/events.jsonl");
}

function resolveSomaHome(options: Pick<SomaMemorySearchOptions, "homeDir" | "somaHome"> = {}): string {
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

function checkedCriteria(run: AlgorithmRun): string[] {
  return run.isa.criteria.map((criterion) => {
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

  return run.isa.goal;
}

function hasPromotionVerification(run: AlgorithmRun): boolean {
  return run.verification.length > 0 || run.isa.criteria.some((criterion) => criterion.status === "passed");
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
    `Phase: ${input.run.phase}`,
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
    input.run.isa.goal,
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
  assertNonEmpty(options.fromRun, "promotion source run");
  assertNonEmpty(options.title, "promotion title");

  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const { path: sourceRunPath, run } = await readAlgorithmRunById(options.fromRun, { somaHome });
  const lesson = promotionLesson(run, options.lesson);

  if (!hasPromotionVerification(run)) {
    throw new Error(`Algorithm run ${run.id} has no verification evidence or passed criteria; refusing memory promotion.`);
  }

  const relativeStore = PROMOTION_STORE_DIRS[options.store];
  const path = join(somaHome, "memory", relativeStore, "PROMOTED", `${slugify(options.title)}-${run.id}.md`);
  const exists = await readFile(path, "utf8").then(
    () => true,
    () => false,
  );

  if (exists) {
    throw new Error(`Soma memory promotion already exists: ${path}`);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${renderPromotionContent({
      run,
      runPath: sourceRunPath,
      title: options.title,
      store: options.store,
      lesson,
      appliesWhen: options.appliesWhen,
      timestamp,
    })}\n`,
    "utf8",
  );

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
  });

  return {
    somaHome,
    store: options.store,
    path,
    sourceRunPath,
    event,
  };
}
