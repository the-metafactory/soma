import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { appendSomaMemoryEvent, somaMemoryEventsPath } from "./memory";
import type {
  SomaMemoryEvent,
  SomaResultCaptureOptions,
  SomaResultCaptureResult,
  SomaResultEventKind,
  SomaResultMemoryEvent,
  SomaResultSearchOptions,
  SomaResultSearchResult,
} from "./types";
import { SOMA_RESULT_EVENT_KINDS } from "./types";

const RESULT_EVENT_KIND_SET = new Set<string>(SOMA_RESULT_EVENT_KINDS);
const RESULT_SUMMARY_MAX_LENGTH = 500;

function assertNonEmpty(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Soma result capture ${field} must not be empty.`);
  }

  return value;
}

function assertResultSummary(value: string | undefined): string {
  const summary = assertNonEmpty(value, "summary");
  if (summary.length > RESULT_SUMMARY_MAX_LENGTH) {
    throw new Error(`Soma result capture summary must be ${RESULT_SUMMARY_MAX_LENGTH} characters or fewer.`);
  }
  if (/[\r\n]/.test(summary)) {
    throw new Error("Soma result capture summary must be a single line.");
  }

  return summary;
}

function resolveSomaHome(options: Pick<SomaResultCaptureOptions | SomaResultSearchOptions, "homeDir" | "somaHome"> = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

export function isSomaResultEventKind(kind: string): kind is SomaResultEventKind {
  return RESULT_EVENT_KIND_SET.has(kind);
}

export async function captureSomaResult(options: SomaResultCaptureOptions): Promise<SomaResultCaptureResult> {
  const somaHome = resolveSomaHome(options);
  const kind: string = options.kind ?? "result.captured";
  if (!isSomaResultEventKind(kind)) {
    throw new Error(`Unsupported Soma result event kind: ${kind}`);
  }

  const source = assertNonEmpty(options.source, "source");
  const summary = assertResultSummary(options.summary);

  const event = (await appendSomaMemoryEvent(somaHome, {
    substrate: options.substrate,
    kind,
    summary,
    artifactPaths: options.artifactPaths,
    metadata: {
      source,
      promptStored: false,
      resultStored: false,
      ...(options.skill ? { skill: options.skill } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(kind === "result.captured" ? { resultKind: "skill-output" } : {}),
    },
  })) as SomaResultMemoryEvent;

  return { somaHome, event };
}

function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9\u00c0-\u024f]+/i)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  );
}

function scoreEvent(event: SomaMemoryEvent, terms: string[], fallbackQuery: string): number {
  const haystack = [
    event.kind,
    event.summary,
    ...resultArtifactPaths(event),
    event.metadata ? JSON.stringify(event.metadata) : "",
  ]
    .join(" ")
    .toLowerCase();

  if (terms.length === 0) {
    return fallbackQuery.length > 0 && haystack.includes(fallbackQuery) ? 1 : 0;
  }

  return terms.reduce((score, term) => (haystack.includes(term) ? score + 1 : score), 0);
}

function resultSearchLimit(limit: number | undefined): number {
  const value = limit ?? 8;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Soma result search limit must be a positive safe integer.");
  }

  return Math.min(value, 100);
}

function resultArtifactPaths(event: SomaMemoryEvent): string[] {
  return Array.isArray(event.artifactPaths) ? event.artifactPaths.filter((path): path is string => typeof path === "string") : [];
}

function isBetterResultMatch(
  left: SomaResultSearchResult["matches"][number],
  right: SomaResultSearchResult["matches"][number],
): boolean {
  return left.score > right.score || (left.score === right.score && left.line < right.line);
}

function retainTopResultMatch(
  matches: SomaResultSearchResult["matches"],
  match: SomaResultSearchResult["matches"][number],
  limit: number,
): void {
  matches.push(match);
  if (matches.length <= limit) return;

  let worstIndex = 0;
  for (let index = 1; index < matches.length; index += 1) {
    if (isBetterResultMatch(matches[worstIndex]!, matches[index]!)) {
      worstIndex = index;
    }
  }
  matches.splice(worstIndex, 1);
}

export async function searchSomaResults(options: SomaResultSearchOptions): Promise<SomaResultSearchResult> {
  const query = assertNonEmpty(options.query, "search query");
  const somaHome = resolveSomaHome(options);
  const eventPath = somaMemoryEventsPath(somaHome);
  const terms = queryTerms(query);
  const limit = resultSearchLimit(options.limit);
  const fallbackQuery = query.trim().toLowerCase();

  if (terms.length === 0 && fallbackQuery.length === 0) {
    return { query, somaHome, matches: [] };
  }

  const exists = await access(eventPath).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return { query, somaHome, matches: [] };
  }

  const matches: SomaResultSearchResult["matches"] = [];
  const lines = createInterface({
    input: createReadStream(eventPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;

    let event: SomaMemoryEvent;
    try {
      event = JSON.parse(line) as SomaMemoryEvent;
    } catch {
      continue;
    }

    if (!isSomaResultEventKind(event.kind)) continue;
    if (typeof event.id !== "string") continue;
    if (typeof event.summary !== "string") continue;
    const artifactPaths = resultArtifactPaths(event);
    const score = scoreEvent(event, terms, fallbackQuery);
    if (score === 0) continue;

    retainTopResultMatch(matches, {
      eventPath,
      line: lineNumber,
      eventId: event.id,
      kind: event.kind,
      score,
      summary: event.summary,
      artifactPaths,
    }, limit);
  }

  return {
    query,
    somaHome,
    matches: matches.sort((left, right) => right.score - left.score || left.line - right.line),
  };
}
