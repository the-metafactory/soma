import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { errataLedgerPath, measureErrataLanded, readErrataLanded } from "../../src/flows/errata";
import { somaMemoryEventsPath } from "../../src/events/index";
import type { ErrataClusterKey, ErrataEvent } from "../../src/flows/types";
import type { SomaMemoryEvent } from "../../src/events/index";

const ref = "errata-artifact-src-a-g1";
const landedAt = "2026-10-15T12:00:00.000Z";
const key: ErrataClusterKey = { kind: "artifact", path: "src/a.ts" };

function landedFixture(beforeCount = 6, afterCount = 3, beforeCandidates = 12, afterCandidates = 12) {
  const events: ErrataEvent[] = [
    { kind: "proposed", clusterId: "EC1", ref, generation: 1, landing: "example/repo", proposalKind: "deterministic-check", at: "2026-10-10T12:00:00.000Z" },
    { kind: "node-closed", clusterId: "EC1", ref, nodeRef: "example/repo#1", at: landedAt },
  ];
  const feedbackEvents: SomaMemoryEvent[] = [];
  if (beforeCount + afterCount === 0) events.push(
    { kind: "created", record: {
      id: "E1", status: "active", sessionId: "S", rejectedTurnUuid: "U1", rejectedAt: "2026-09-01T00:00:00.000Z",
      complaintAt: "2026-09-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z", complaint: "private",
      artifacts: ["src/a.ts"], passedBy: null,
    } },
    { kind: "clustered", id: "E1", clusterId: "EC1", key, at: "2026-09-01T00:00:00.000Z" },
  );
  let next = 1;
  for (const [count, candidates, at] of [
    [beforeCount, beforeCandidates, "2026-10-14T12:00:00.000Z"],
    [afterCount, afterCandidates, "2026-10-16T12:00:00.000Z"],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const id = `E${next++}`;
      events.push({ kind: "created", record: {
        id, status: "active", sessionId: "S", rejectedTurnUuid: id, rejectedAt: at, complaintAt: at,
        complaint: "private complaint", artifacts: ["src/a.ts"], passedBy: null,
        createdAt: "2026-10-29T12:00:00.000Z",
      } }, { kind: "clustered", id, clusterId: "EC1", key, at: "2026-10-29T12:00:00.000Z" });
    }
    for (let i = 0; i < candidates; i++) feedbackEvents.push({
      id: `${at}-${i}`, timestamp: at, substrate: "codex", kind: "feedback.candidate", summary: "feedback",
      metadata: { actor: "interactive" },
    });
  }
  return { events, feedbackEvents, ref };
}

test("landed reports counts, exact 14-day windows and rates by complaint time", () => {
  expect(measureErrataLanded(landedFixture())).toEqual({
    ref, clusterId: "EC1", key, landedAt, windowDays: 14, verdict: "lower", reason: null,
    before: { start: "2026-10-01T12:00:00.000Z", end: landedAt, errata: 6, candidates: 12, rate: 0.5 },
    after: { start: landedAt, end: "2026-10-29T12:00:00.000Z", errata: 3, candidates: 12, rate: 0.25 },
  });
});

test("verdict compares rates rather than counts, including equal rates", () => {
  expect(measureErrataLanded(landedFixture(6, 3, 24, 6)).verdict).toBe("higher");
  expect(measureErrataLanded(landedFixture(6, 3, 12, 6)).verdict).toBe("unchanged");
  expect(measureErrataLanded(landedFixture(3, 6, 3, 12)).verdict).toBe("lower");
});

test("fewer than three errata on either side is insufficient, including empty and equal windows", () => {
  for (const [before, after] of [[2, 3], [3, 2], [2, 2], [0, 0]]) {
    expect(measureErrataLanded(landedFixture(before, after))).toMatchObject({ verdict: "insufficient-data", reason: "too-few-errata" });
  }
  for (const [before, after] of [[0, 12], [12, 0], [0, 0]]) {
    const result = measureErrataLanded(landedFixture(3, 3, before, after));
    expect(result).toMatchObject({ verdict: "insufficient-data", reason: "zero-denominator" });
    expect(before === 0 ? result.before?.rate : result.after?.rate).toBeNull();
  }
});

test("only unique interactive feedback candidates contribute to the denominator", () => {
  const fixture = landedFixture();
  const candidate = fixture.feedbackEvents[0];
  fixture.feedbackEvents.push(candidate);
  for (const actor of ["automated", "sdk", undefined]) fixture.feedbackEvents.push({
    ...candidate, id: `other-${actor}`, metadata: { actor },
  });
  fixture.feedbackEvents.push({ ...candidate, id: "other-kind", kind: "lifecycle.session_end" });
  expect(measureErrataLanded(fixture).before?.candidates).toBe(12);
});

test("half-open windows include their start and exclude their end without overlapping", () => {
  const fixture = landedFixture(3, 3, 3, 3);
  const times = ["2026-10-01T11:59:59.999Z", "2026-10-01T12:00:00.000Z", landedAt,
    "2026-10-29T11:59:59.999Z", "2026-10-29T12:00:00.000Z", "2026-10-14T12:00:00.000Z"];
  let index = 0;
  for (const event of fixture.events) if (event.kind === "created") event.record.complaintAt = times[index++];
  fixture.feedbackEvents.forEach((event, i) => { event.timestamp = times[i]; });
  expect(measureErrataLanded(fixture)).toMatchObject({
    before: { errata: 2, candidates: 2 }, after: { errata: 2, candidates: 2 }, verdict: "insufficient-data",
  });
});

test("cluster keys, not cluster ids, select active errata; unrelated and vetoed records do not count", () => {
  const fixture = landedFixture(6, 3);
  let index = 0;
  for (const event of fixture.events) {
    if (event.kind !== "clustered") continue;
    index++;
    if (index === 1) event.clusterId = "EC2";
    if (index === 2) { event.clusterId = "EC3"; event.key = { kind: "artifact", path: "src/b.ts" }; }
  }
  fixture.events.push({ kind: "dropped", id: "E3", at: "2026-10-30T12:00:00.000Z" });
  expect(measureErrataLanded(fixture).before?.errata).toBe(4);
});

test("landing belongs to its proposal generation, never another proposal or a resolved answer", () => {
  const fixture = landedFixture();
  fixture.events = fixture.events.filter((event) => event.kind !== "node-closed");
  fixture.events.push(
    { kind: "resolved", clusterId: "EC1", ref, at: landedAt },
    { kind: "node-closed", clusterId: "EC1", ref: "other-generation", at: landedAt },
  );
  expect(measureErrataLanded(fixture)).toMatchObject({
    ref, verdict: "insufficient-data", reason: "missing-node-closed", landedAt: null, before: null, after: null,
  });
  expect(() => measureErrataLanded({ ...fixture, ref: "unknown" })).toThrow("Unknown Errata proposal");
});

test("check keys preserve field boundaries and theme keys match case-insensitively", () => {
  for (const clusterKey of [
    { kind: "check", passedBy: { kind: "algorithm-verify", runId: "run", criterionId: "C1" } },
    { kind: "check", passedBy: { kind: "close-receipt", repo: "example/repo", nodeId: "1", receiptCommentId: "2" } },
    { kind: "theme", label: "Unverified Claim" },
  ] satisfies ErrataClusterKey[]) {
    const fixture = landedFixture();
    for (const event of fixture.events) if (event.kind === "clustered") {
      event.key = clusterKey;
      if (event.id === "E9") {
        event.clusterId = "EC2";
        event.key = clusterKey.kind === "theme" ? { kind: "theme", label: " unverified CLAIM " } : structuredClone(clusterKey);
      }
    }
    expect(measureErrataLanded(fixture)).toMatchObject({ before: { errata: 6 }, after: { errata: 3 } });
  }
});

test("check key fields do not alias when their separator-joined spellings match", () => {
  const fixture = landedFixture();
  for (const event of fixture.events) if (event.kind === "clustered") {
    event.key = { kind: "check", passedBy: { kind: "algorithm-verify", runId: "run-part", criterionId: "C1" } };
    if (event.id === "E9") {
      event.clusterId = "EC2";
      event.key = { kind: "check", passedBy: { kind: "algorithm-verify", runId: "run", criterionId: "part-C1" } };
    }
  }
  expect(measureErrataLanded(fixture)).toMatchObject({ before: { errata: 6 }, after: { errata: 2 }, verdict: "insufficient-data" });
});

test("pure measurement accepts a window length and rejects invalid windows", () => {
  expect(measureErrataLanded({ ...landedFixture(), windowDays: 7 })).toMatchObject({
    windowDays: 7, before: { start: "2026-10-08T12:00:00.000Z" }, after: { end: "2026-10-22T12:00:00.000Z" },
  });
  for (const windowDays of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => measureErrataLanded({ ...landedFixture(), windowDays })).toThrow("window days");
  }
});

test("all proposals share the same measurement semantics across keys and landing dates", async () => {
  const fixture = landedFixture();
  for (const event of fixture.events) if (event.kind === "clustered" && event.id === "E9") {
    event.clusterId = "EC2";
    event.key = { kind: "theme", label: "Other theme" };
  }
  fixture.events.push(
    { kind: "proposed", clusterId: "EC1", ref: "second-generation", generation: 2, landing: "example/repo", proposalKind: "deterministic-check", at: landedAt },
    { kind: "node-closed", clusterId: "EC1", ref: "second-generation", at: "2026-10-17T12:00:00.000Z" },
    { kind: "proposed", clusterId: "EC2", ref: "other-theme", generation: 1, landing: "example/repo", proposalKind: "deterministic-check", at: landedAt },
    { kind: "node-closed", clusterId: "EC2", ref: "other-theme", at: landedAt },
    { kind: "node-closed", clusterId: "EC1", ref, at: "2026-10-20T12:00:00.000Z" },
  );
  fixture.feedbackEvents.reverse();
  fixture.feedbackEvents.push(fixture.feedbackEvents[0]);
  const somaHome = await mkdtemp(join(tmpdir(), "soma-landed-index-"));
  try {
    await mkdir(dirname(errataLedgerPath(somaHome)), { recursive: true });
    await writeFile(errataLedgerPath(somaHome), fixture.events.map((event) => JSON.stringify(event) + "\n").join(""));
    await writeFile(somaMemoryEventsPath(somaHome), fixture.feedbackEvents.map((event) => JSON.stringify(event) + "\n").join(""));
    const rows = await readErrataLanded(somaHome);
    expect(rows).toEqual([ref, "second-generation", "other-theme"].map((ref) => measureErrataLanded({ ...fixture, ref })));
    expect(rows[0]).toMatchObject({ landedAt, before: { errata: 6, candidates: 12 }, after: { errata: 2, candidates: 12 } });
    expect(rows[1]).toMatchObject({ before: { errata: 8, candidates: 24 }, after: { errata: 0, candidates: 0 } });
    expect(rows[2]).toMatchObject({ before: { errata: 0, candidates: 12 }, after: { errata: 1, candidates: 12 } });
  } finally {
    await rm(somaHome, { recursive: true, force: true });
  }
});

test("malformed closure nodeRef names the event kind", async () => {
  const fixture = landedFixture();
  const somaHome = await mkdtemp(join(tmpdir(), "soma-landed-invalid-"));
  try {
    await mkdir(dirname(errataLedgerPath(somaHome)), { recursive: true });
    const events = fixture.events.map((event) => event.kind === "node-closed" ? { ...event, nodeRef: 123 } : event);
    await writeFile(errataLedgerPath(somaHome), events.map((event) => JSON.stringify(event) + "\n").join(""));
    await expect(readErrataLanded(somaHome)).rejects.toThrow("Invalid Errata node-closed nodeRef.");
  } finally {
    await rm(somaHome, { recursive: true, force: true });
  }
});
