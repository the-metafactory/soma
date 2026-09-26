import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { expect, test } from "bun:test";
import {
  appendSomaMemoryEvent,
  bootstrapSomaHome,
  createSomaSnapshot,
  querySomaTelemetryEvents,
  summarizeSomaTelemetry,
} from "../src/index";
import { appendEventBatch, compressEventSegment, eventSegmentPath } from "../src/event-log";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-observability-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("telemetry query filters event log and counts malformed lines", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-1",
      timestamp: "2026-05-26T08:00:00.000Z",
      substrate: "codex",
      kind: "lifecycle.session_start",
      summary: "Session started: s1",
      metadata: { sessionId: "s1" },
    });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-2",
      timestamp: "2026-05-26T08:10:00.000Z",
      substrate: "pi-dev",
      kind: "lifecycle.session_start",
      summary: "Session started: s2",
      metadata: { sessionId: "s2" },
    });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-3",
      timestamp: "2026-05-26T08:20:00.000Z",
      substrate: "codex",
      kind: "lifecycle.session_end",
      summary: "Session ended.",
      metadata: { sessionId: "s1" },
    });
    await appendFile(join(somaHome, "memory/STATE/events.jsonl"), "{not-json}\n", "utf8");

    const result = await querySomaTelemetryEvents({
      homeDir,
      substrate: "codex",
      limit: 1,
    });

    expect(result.skippedMalformedLines).toBe(1);
    expect(result.totalEvents).toBe(3);
    expect(result.events.map((event) => event.id)).toEqual(["evt-3"]);
  });
});

test("telemetry query rejects non-integer limits", async () => {
  await withTempHome(async (homeDir) => {
    await expect(querySomaTelemetryEvents({ homeDir, limit: Number.NaN })).rejects.toThrow(
      "Soma telemetry limit must be a positive integer.",
    );
    await expect(querySomaTelemetryEvents({ homeDir, limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "Soma telemetry limit must be a positive integer.",
    );
    await expect(querySomaTelemetryEvents({ homeDir, limit: 1.5 })).rejects.toThrow(
      "Soma telemetry limit must be a positive integer.",
    );
  });
});

test("recent telemetry uses closed-segment counts and keeps exact totals", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const eventsPath = join(somaHome, "memory/STATE/events.jsonl");
    const record = (id: string, substrate = "codex") => JSON.stringify({
      id, timestamp: "2026-05-26T08:00:00.000Z", substrate, kind: "test.event", summary: id,
    });
    await appendEventBatch(eventsPath, Buffer.from(`${record("old")}\n{broken}\n${record("middle", "pi-dev")}\n${record("new")}\n`), 150);
    for (let number = 1; number <= 2; number++) {
      const path = eventSegmentPath(eventsPath, number);
      await compressEventSegment(path);
      const saved = JSON.parse(await readFile(`${path}.counts.json`, "utf8")) as {
        totalEvents: number; skippedMalformedLines: number;
      };
      expect(saved.totalEvents + saved.skippedMalformedLines).toBeGreaterThan(0);
    }
    const result = await querySomaTelemetryEvents({ homeDir, limit: 1, substrate: "codex" });
    expect(result.events.map((event) => event.id)).toEqual(["new"]);
    expect(result.totalEvents).toBe(3);
    expect(result.skippedMalformedLines).toBe(1);
    const oldPath = eventSegmentPath(eventsPath, 1);
    const originalCounts = await readFile(`${oldPath}.counts.json`, "utf8");
    const altered = JSON.parse(originalCounts) as { totalEvents: number };
    altered.totalEvents = 99;
    await writeFile(`${oldPath}.counts.json`, JSON.stringify(altered));
    const recovered = await querySomaTelemetryEvents({ homeDir, limit: 1, substrate: "codex" });
    expect(recovered.totalEvents).toBe(3);
    await writeFile(`${oldPath}.counts.json`, originalCounts);
    await createSomaSnapshot({ somaHome, name: "counts" });
    const cumulative = JSON.parse(await readFile(join(somaHome, "memory/STATE/events-counts-index.json"), "utf8")) as {
      totalEvents: number; skippedMalformedLines: number;
    };
    expect(cumulative.totalEvents).toBe(2);
    expect(cumulative.skippedMalformedLines).toBe(1);
    await writeFile(`${oldPath}.counts.json`, JSON.stringify(altered));
    const indexed = await querySomaTelemetryEvents({ homeDir, limit: 1, substrate: "codex" });
    expect(indexed.totalEvents).toBe(3);
    expect(indexed.skippedMalformedLines).toBe(1);
    await writeFile(`${oldPath}.gz`, gzipSync(`${record("different")}\n`));
    await expect(querySomaTelemetryEvents({ homeDir, limit: 1 })).rejects.toThrow(/Conflicting event segment copies/);
    await writeFile(`${oldPath}.gz.replacement`, gzipSync(`${record("different")}\n`));
    await rename(`${oldPath}.gz.replacement`, `${oldPath}.gz`);
    await expect(querySomaTelemetryEvents({ homeDir, limit: 1 })).rejects.toThrow(/Conflicting event segment copies/);
    await appendEventBatch(eventsPath, Buffer.from(`${record("later")}\n`), 150);
    await expect(querySomaTelemetryEvents({ homeDir, limit: 1 })).rejects.toThrow(/Conflicting event segment copies/);
  });
});

test("telemetry summary aggregates sessions, kinds, substrates, and durations", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-1",
      timestamp: "2026-05-26T08:00:00.000Z",
      substrate: "codex",
      kind: "lifecycle.session_start",
      summary: "Session started: s1",
      metadata: { sessionId: "s1" },
    });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-2",
      timestamp: "2026-05-26T08:05:00.000Z",
      substrate: "codex",
      kind: "lifecycle.algorithm_updated",
      summary: "Algorithm work index updated.",
      metadata: { phase: "verify" },
    });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-3",
      timestamp: "2026-05-26T08:20:00.000Z",
      substrate: "codex",
      kind: "lifecycle.session_end",
      summary: "Session ended.",
      metadata: { sessionId: "s1" },
    });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-4",
      timestamp: "2026-05-26T09:00:00.000Z",
      substrate: "pi-dev",
      kind: "lifecycle.session_end.registry-write-failed",
      summary: "Session ended; shared work registry writeback failed.",
      metadata: { sessionId: "s2" },
    });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-5",
      timestamp: "2026-05-26T09:01:00.000Z",
      substrate: "pi-dev",
      kind: "lifecycle.session_end",
      summary: "Session ended.",
      metadata: { sessionId: "s2" },
    });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-6",
      timestamp: "2026-05-26T09:05:00.000Z",
      substrate: "codex",
      kind: "skill.loaded",
      summary: "Loaded skill.",
      metadata: { skillName: "Knowledge" },
    });

    const summary = await summarizeSomaTelemetry({ homeDir });

    expect(summary.totalEvents).toBe(6);
    expect(summary.bySubstrate).toEqual({ codex: 4, "pi-dev": 2 });
    expect(summary.byKind["lifecycle.session_start"]).toBe(1);
    expect(summary.sessions).toMatchObject({
      started: 1,
      ended: 2,
      completedWithDuration: 1,
      averageDurationMs: 20 * 60 * 1000,
      bySubstrate: {
        codex: {
          started: 1,
          ended: 1,
          completedWithDuration: 1,
          averageDurationMs: 20 * 60 * 1000,
        },
        "pi-dev": {
          started: 0,
          ended: 1,
          completedWithDuration: 0,
          averageDurationMs: null,
        },
      },
    });
    expect(summary.skills).toEqual({ events: 1, byName: { Knowledge: 1 } });
    expect(summary.algorithm.byPhase).toEqual({ verify: 1 });
    expect(summary.writeback.failures).toBe(1);
  });
});

test("telemetry summary consumes matched session starts once", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-1",
      timestamp: "2026-05-26T08:00:00.000Z",
      substrate: "codex",
      kind: "lifecycle.session_start",
      summary: "Session started: s1",
      metadata: { sessionId: "s1" },
    });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-2",
      timestamp: "2026-05-26T08:10:00.000Z",
      substrate: "codex",
      kind: "lifecycle.session_end",
      summary: "Session ended.",
      metadata: { sessionId: "s1" },
    });
    await appendSomaMemoryEvent(somaHome, {
      id: "evt-3",
      timestamp: "2026-05-26T08:20:00.000Z",
      substrate: "codex",
      kind: "lifecycle.session_end",
      summary: "Duplicate session end.",
      metadata: { sessionId: "s1" },
    });

    const summary = await summarizeSomaTelemetry({ homeDir });

    expect(summary.sessions.ended).toBe(2);
    expect(summary.sessions.completedWithDuration).toBe(1);
    expect(summary.sessions.averageDurationMs).toBe(10 * 60 * 1000);
  });
});
