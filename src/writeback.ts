import { join } from "node:path";
import { applyIsaUpdate, getActiveIsa, isaPath } from "./isa";
import { appendSomaMemoryEvent, appendSomaMemoryEvents, somaMemoryEventsPath } from "./memory";
import { checkSomaPolicy } from "./policy-audit";
import type { IsaUpdatePayload, SomaMemoryEventInput, SubstrateId } from "./types";

export type SomaWritebackMergeSemantics = "append-only" | "isa-log-append";

export interface SomaWritebackBaseOptions {
  somaHome: string;
  substrate?: SubstrateId;
  timestamp?: string;
}

export interface SomaMemoryEventWritebackOperation {
  kind: "memory-event";
  event: Omit<SomaMemoryEventInput, "substrate" | "timestamp"> & {
    substrate?: SubstrateId;
    timestamp?: string;
  };
}

export interface SomaDurableMemoryWritebackOperation {
  kind: "durable-memory";
  store: string;
  relativePath: string;
}

export interface SomaIsaLogWritebackOperation {
  kind: "isa-log";
  slug?: string;
  entries: IsaUpdatePayload;
}

export type SomaWritebackOperation =
  | SomaMemoryEventWritebackOperation
  | SomaDurableMemoryWritebackOperation
  | SomaIsaLogWritebackOperation;

export interface SomaWritebackOptions extends SomaWritebackBaseOptions {
  operation: SomaWritebackOperation;
}

export interface SomaWritebackResult {
  decision: "applied";
  merge: SomaWritebackMergeSemantics;
  writes: string[];
}

async function assertWritebackAllowed(options: {
  somaHome: string;
  substrate: SubstrateId;
  destinationPath: string;
  timestamp?: string;
  deniedMessage: string;
}): Promise<void> {
  const policy = await checkSomaPolicy({
    somaHome: options.somaHome,
    substrate: options.substrate,
    action: "modify",
    destinationPath: options.destinationPath,
    record: "deny",
    timestamp: options.timestamp,
  });
  if (policy.decision === "deny") {
    throw new Error(`${options.deniedMessage}: ${policy.reason}`);
  }
}

function assertRelativePath(path: string): void {
  if (path.trim().length === 0 || path.startsWith("/") || path.split(/[\\/]+/u).includes("..")) {
    throw new Error(`Invalid writeback relative path: ${path}`);
  }
}

export async function applySomaWriteback(options: SomaWritebackOptions): Promise<SomaWritebackResult> {
  const substrate = options.substrate ?? "custom";

  switch (options.operation.kind) {
    case "memory-event": {
      return applySomaMemoryEventWritebacks({
        somaHome: options.somaHome,
        substrate,
        timestamp: options.timestamp,
        events: [options.operation.event],
      });
    }
    case "isa-log": {
      const active = await getActiveIsa({ somaHome: options.somaHome });
      const activeSlug = active?.activeSlug ?? null;
      if (!activeSlug) {
        throw new Error("ISA writeback requires an active ISA.");
      }
      const slug = options.operation.slug ?? activeSlug;
      if (options.operation.slug && options.operation.slug !== activeSlug) {
        await appendSomaMemoryEvent(options.somaHome, {
          substrate,
          kind: "writeback.isa_log.refused_scope",
          summary: `ISA writeback slug '${options.operation.slug}' does not match active ISA '${activeSlug}'.`,
          timestamp: options.timestamp,
          metadata: { payloadSlug: options.operation.slug, activeSlug },
        });
        throw new Error(`ISA writeback slug '${options.operation.slug}' does not match active ISA '${activeSlug}'.`);
      }

      const entries = [
        ...(options.operation.entries.decisions ?? []).map((entry) => ({ section: "decisions" as const, ...entry })),
        ...(options.operation.entries.changelogEntries ?? []).map((entry) => ({ section: "changelog" as const, ...entry })),
        ...(options.operation.entries.verificationEntries ?? []).map((entry) => ({ section: "verification" as const, ...entry })),
      ];
      if (entries.length === 0) {
        throw new Error("ISA writeback requires at least one log entry.");
      }

      const targetPath = isaPath(options.somaHome, slug);
      await assertWritebackAllowed({
        somaHome: options.somaHome,
        substrate,
        destinationPath: targetPath,
        timestamp: options.timestamp,
        deniedMessage: "Writeback gate denied ISA write",
      });

      const write = await applyIsaUpdate(slug, entries, { somaHome: options.somaHome, timestamp: options.timestamp, substrate });
      await appendSomaMemoryEvent(options.somaHome, {
        substrate,
        kind: "writeback.isa_log",
        summary: `Merged ${entries.length} ISA log entr(ies) into ${slug}.`,
        timestamp: options.timestamp,
        artifactPaths: write.path ? [write.path] : [],
        metadata: { slug, entries: options.operation.entries },
      });

      return {
        decision: "applied",
        merge: "isa-log-append",
        writes: Array.from(new Set([...(write.path ? [write.path] : []), somaMemoryEventsPath(options.somaHome)])),
      };
    }
    case "durable-memory": {
      assertRelativePath(options.operation.relativePath);
      throw new Error(
        `Unsupported writeback store ${options.operation.store}; direct durable memory writeback requires explicit merge semantics before writing ${join(options.operation.store, options.operation.relativePath)}.`,
      );
    }
  }
}

export async function applySomaMemoryEventWritebacks(
  options: SomaWritebackBaseOptions & {
    events: readonly SomaMemoryEventWritebackOperation["event"][];
  },
): Promise<SomaWritebackResult> {
  const substrate = options.substrate ?? "custom";
  const eventPath = somaMemoryEventsPath(options.somaHome);
  if (options.events.length === 0) {
    return { decision: "applied", merge: "append-only", writes: [] };
  }
  const substrates = new Set(options.events.map((event) => event.substrate ?? substrate));
  for (const eventSubstrate of substrates) {
    await assertWritebackAllowed({
      somaHome: options.somaHome,
      substrate: eventSubstrate,
      destinationPath: eventPath,
      timestamp: options.timestamp,
      deniedMessage: "Writeback gate denied memory-event write",
    });
  }

  await appendSomaMemoryEvents(
    options.somaHome,
    options.events.map((event) => ({
      ...event,
      substrate: event.substrate ?? substrate,
      timestamp: event.timestamp ?? options.timestamp,
    })),
  );

  return {
    decision: "applied",
    merge: "append-only",
    writes: [eventPath],
  };
}
