import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SomaMemoryEvent, SomaMemoryEventInput } from "./types";

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
