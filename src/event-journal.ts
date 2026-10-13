import { createPaths } from "./paths";
import { appendEventBatch } from "./event-log";
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

  await appendEventBatch(eventPath, Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8"));

  return events;
}

export function somaMemoryEventsPath(somaHome: string): string {
  return createPaths(somaHome).events();
}

