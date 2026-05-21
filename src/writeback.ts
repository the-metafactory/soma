import { join } from "node:path";
import { applyIsaUpdate, getActiveIsa, isaPath } from "./isa";
import { appendSomaMemoryEvent, somaMemoryEventsPath } from "./memory";
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
  content: string;
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

function assertRelativePath(path: string): void {
  if (path.trim().length === 0 || path.startsWith("/") || path.split(/[\\/]+/u).includes("..")) {
    throw new Error(`Invalid writeback relative path: ${path}`);
  }
}

export async function applySomaWriteback(options: SomaWritebackOptions): Promise<SomaWritebackResult> {
  const substrate = options.substrate ?? "custom";

  switch (options.operation.kind) {
    case "memory-event": {
      const eventPath = somaMemoryEventsPath(options.somaHome);
      const policy = await checkSomaPolicy({
        somaHome: options.somaHome,
        substrate,
        action: "modify",
        destinationPath: eventPath,
        record: "deny",
        timestamp: options.timestamp,
      });
      if (policy.decision === "deny") {
        throw new Error(`Writeback gate denied memory-event write: ${policy.reason}`);
      }

      await appendSomaMemoryEvent(options.somaHome, {
        ...options.operation.event,
        substrate: options.operation.event.substrate ?? substrate,
        timestamp: options.operation.event.timestamp ?? options.timestamp,
      });

      return {
        decision: "applied",
        merge: "append-only",
        writes: [eventPath],
      };
    }
    case "isa-log": {
      const active = await getActiveIsa({ somaHome: options.somaHome });
      const activeSlug = active?.activeSlug ?? null;
      const slug = options.operation.slug ?? activeSlug;
      if (!slug) {
        throw new Error("ISA writeback requires an active ISA or explicit slug.");
      }
      if (options.operation.slug && activeSlug && options.operation.slug !== activeSlug) {
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
      const policy = await checkSomaPolicy({
        somaHome: options.somaHome,
        substrate,
        action: "modify",
        destinationPath: targetPath,
        record: "deny",
        timestamp: options.timestamp,
      });
      if (policy.decision === "deny") {
        throw new Error(`Writeback gate denied ISA write: ${policy.reason}`);
      }

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
