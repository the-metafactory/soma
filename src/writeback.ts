import { join } from "node:path";
import { applyVsaUpdate, getActiveVsa, vsaPath } from "./vsa";
import { appendSomaMemoryEvent, appendSomaMemoryEvents, somaMemoryEventsPath } from "./memory";
import { checkSomaPolicy } from "./policy-audit";
import type { VsaUpdatePayload, SomaMemoryEventInput, SubstrateId } from "./types";

export type SomaWritebackMergeSemantics = "append-only" | "vsa-log-append";

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

export interface SomaVsaLogWritebackOperation {
  kind: "vsa-log";
  slug?: string;
  entries: VsaUpdatePayload;
}

export type SomaWritebackOperation =
  | SomaMemoryEventWritebackOperation
  | SomaDurableMemoryWritebackOperation
  | SomaVsaLogWritebackOperation;

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
    case "vsa-log": {
      const active = await getActiveVsa({ somaHome: options.somaHome });
      const activeSlug = active?.activeSlug ?? null;
      if (!activeSlug) {
        throw new Error("VSA writeback requires an active VSA.");
      }
      const slug = options.operation.slug ?? activeSlug;
      if (options.operation.slug && options.operation.slug !== activeSlug) {
        await appendSomaMemoryEvent(options.somaHome, {
          substrate,
          kind: "writeback.vsa_log.refused_scope",
          summary: `VSA writeback slug '${options.operation.slug}' does not match active VSA '${activeSlug}'.`,
          timestamp: options.timestamp,
          metadata: { payloadSlug: options.operation.slug, activeSlug },
        });
        throw new Error(`VSA writeback slug '${options.operation.slug}' does not match active VSA '${activeSlug}'.`);
      }

      const entries = [
        ...(options.operation.entries.decisions ?? []).map((entry) => ({ section: "decisions" as const, ...entry })),
        ...(options.operation.entries.changelogEntries ?? []).map((entry) => ({ section: "changelog" as const, ...entry })),
        ...(options.operation.entries.verificationEntries ?? []).map((entry) => ({ section: "verification" as const, ...entry })),
      ];
      if (entries.length === 0) {
        throw new Error("VSA writeback requires at least one log entry.");
      }

      const targetPath = vsaPath(options.somaHome, slug);
      await assertWritebackAllowed({
        somaHome: options.somaHome,
        substrate,
        destinationPath: targetPath,
        timestamp: options.timestamp,
        deniedMessage: "Writeback gate denied VSA write",
      });

      const write = await applyVsaUpdate(slug, entries, { somaHome: options.somaHome, timestamp: options.timestamp, substrate });
      await appendSomaMemoryEvent(options.somaHome, {
        substrate,
        kind: "writeback.vsa_log",
        summary: `Merged ${entries.length} VSA log entr(ies) into ${slug}.`,
        timestamp: options.timestamp,
        artifactPaths: write.path ? [write.path] : [],
        metadata: { slug, entries: options.operation.entries },
      });

      return {
        decision: "applied",
        merge: "vsa-log-append",
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
