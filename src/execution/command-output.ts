/** A runner-owned, incrementally consumable command output stream. */
export type CommandOutput = AsyncIterable<string>;

/** Creates a deterministic chunk stream for fixtures and in-memory runners. */
export function outputFromText(value: string): CommandOutput {
  return {
    async *[Symbol.asyncIterator]() {
      if (value.length > 0) yield await Promise.resolve(value);
    },
  };
}

const MAX_PROBE_OUTPUT_LENGTH = 64 * 1024;
export const MAX_EXECUTION_OUTPUT_RECORDS = 64;
export const MAX_EXECUTION_OUTPUT_RECORD_LENGTH = 16_384;

/** Collects only the small, bounded output needed for version/help probes. */
export async function collectProbeOutput(output: CommandOutput): Promise<string> {
  let value = "";
  for await (const chunk of output) {
    const remaining = MAX_PROBE_OUTPUT_LENGTH - value.length;
    if (remaining <= 0) break;
    value += chunk.slice(0, remaining);
  }
  return value;
}

export interface BoundedJsonlSummaryOptions {
  maxRecords: number;
  maxRecordLength: number;
  eventPrefix: string;
  oversizedSummary: string;
  malformedSummary: string;
  truncatedSummary: string;
}

/**
 * Converts a chunked JSONL stream into bounded, provider-neutral summaries.
 * It retains at most one partial record and never stores the raw transcript.
 */
export async function* boundedJsonlSummaries(
  output: CommandOutput,
  options: BoundedJsonlSummaryOptions,
): AsyncIterable<string> {
  let pending = "";
  let pendingOversized = false;
  let records = 0;
  let truncated = false;

  const reduceLine = function* (line: string): Iterable<string> {
    records += 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) return;
    if (line.length > options.maxRecordLength) {
      yield options.oversizedSummary;
      return;
    }
    try {
      const parsed = JSON.parse(line) as { type?: string };
      yield `${options.eventPrefix}: ${parsed.type ?? "json"}`;
    } catch {
      yield options.malformedSummary;
    }
  };

  for await (const chunk of output) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      if (newline === -1) {
        if (records >= options.maxRecords) {
          truncated = true;
        } else if (!pendingOversized && pending.length + chunk.length - offset <= options.maxRecordLength) {
          pending += chunk.slice(offset);
        } else {
          pending = "";
          pendingOversized = true;
        }
        break;
      }

      if (records >= options.maxRecords) {
        truncated = true;
      } else if (pendingOversized || pending.length + newline - offset > options.maxRecordLength) {
        records += 1;
        yield options.oversizedSummary;
      } else {
        const line = pending.length === 0 ? chunk.slice(offset, newline) : pending + chunk.slice(offset, newline);
        yield* reduceLine(line);
      }
      pending = "";
      pendingOversized = false;
      offset = newline + 1;
    }
  }

  if (pendingOversized && records < options.maxRecords) {
    records += 1;
    yield options.oversizedSummary;
  } else if (pending.length > 0 && records < options.maxRecords) {
    yield* reduceLine(pending);
  } else if (pending.length > 0 || pendingOversized) {
    truncated = true;
  }
  if (truncated) yield options.truncatedSummary;
}
