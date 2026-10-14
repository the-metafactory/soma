import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runErrataTriage, readErrata, type ErrataTriageDeps } from "../src/errata";
import { JUDGE_REGISTRY, hashJudgmentInput, judgeLedgerPath, readJudgments, recordJudgment } from "../src/judge";
import { appendSomaMemoryEvent, somaMemoryEventsPath } from "../src/memory";
import { appendEventBatch } from "../src/event-log";
import type { ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import type { RunFinishedInput } from "../src/run-ledger";
import type { SomaMemoryEvent } from "../src/types";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const at = "2026-10-14T04:02:00.000Z";

async function setup() {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-triage-")); homes.push(somaHome);
  const transcriptPath = join(somaHome, "transcript.jsonl");
  await writeFile(transcriptPath, JSON.stringify({
    type: "assistant", uuid: "U1", timestamp: "2026-10-14T04:01:00.000Z", sessionId: "S1",
    message: { content: [{ type: "text", text: "PRIVATE DELIVERED OUTPUT" }] },
  }) + "\n");
  const candidate: SomaMemoryEvent = {
    id: "evt-1", timestamp: at, substrate: "claude-code", kind: "feedback.candidate", summary: "Feedback candidate",
    metadata: { actor: "interactive", sessionId: "S1", transcriptPath, redactedExcerpt: "The delivered output is wrong." },
  };
  const reports: RunFinishedInput[] = [];
  const deps: ErrataTriageDeps = {
    somaHome, now: () => new Date(at), readEvents: async () => [candidate],
    classify: async () => ({ verdict: "promote", reason: "Rejects delivered output.", backendVersion: "test-cli-1" }),
    publishRun: async (report) => { reports.push(report); },
  };
  return { somaHome, candidate, reports, deps };
}

test("only interactive feedback is classified; promotion uses the linker and every run reports counts", async () => {
  const { somaHome, candidate, reports, deps } = await setup();
  const inputs: string[] = [];
  const events = [candidate,
    { ...candidate, id: "automated", metadata: { ...candidate.metadata, actor: "automated" } },
    { ...candidate, id: "unknown", metadata: { redactedExcerpt: "wrong" } },
    { ...candidate, id: "other-kind", kind: "lifecycle.session_end" },
  ];
  deps.readEvents = async () => events;
  deps.classify = async (text) => { inputs.push(text); return { verdict: "promote", reason: "Rejection.", backendVersion: "2.1.296" }; };
  const result = await runErrataTriage(deps);
  expect(result).toMatchObject({ outcome: "succeeded", promoted: 1, dropped: 0, skipped: 2, unlinkable: 0 });
  expect(inputs).toEqual([candidate.metadata!.redactedExcerpt as string]);
  expect(await readErrata(somaHome)).toMatchObject([{ id: "E1", sessionId: "S1", rejectedTurnUuid: "U1", passedBy: null }]);
  const { records } = await readJudgments(somaHome);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ caller: "errata-triage", backend: "claude-p", backendVersion: "2.1.296",
    ts: at, inputSha256: hashJudgmentInput(inputs[0]), decision: { verdict: "promote", eventId: candidate.id, errataId: "E1" } });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ kind: "job", ref: "errata-triage", outcome: "succeeded", startedAt: at, endedAt: at, detailRef: result.detailRef });
  const detail = await readFile(result.detailRef, "utf8");
  expect(JSON.parse(detail)).toMatchObject({ promoted: 1, dropped: 0, skipped: 2, unlinkable: 0 });
  expect(detail + JSON.stringify(reports) + JSON.stringify(records)).not.toContain(inputs[0]);
  const repeated = await runErrataTriage(deps);
  expect(repeated.promoted).toBe(0);
  expect(inputs).toHaveLength(1);
  expect((await readJudgments(somaHome)).records).toHaveLength(1);
  expect(reports).toHaveLength(2);
  expect(reports[0].runId).not.toBe(reports[1].runId);
});

test("drop records a verdict without linking or appending Errata", async () => {
  const { somaHome, deps } = await setup();
  deps.classify = async () => ({ verdict: "drop", reason: "A new request.", backendVersion: "test-cli-1" });
  deps.link = async () => { throw new Error("Drop must not link."); };
  expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", dropped: 1, promoted: 0 });
  expect(await readErrata(somaHome)).toEqual([]);
  expect((await readJudgments(somaHome)).records[0].decision.verdict).toBe("drop");
});

test("explicit errata marker bypasses Claude and records the explicit backend", async () => {
  const { somaHome, candidate, deps } = await setup();
  candidate.metadata!.redactedExcerpt = "errata: The delivered output is wrong.";
  deps.classify = async () => { throw new Error("Must not classify an explicit marker."); };
  expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", promoted: 1 });
  expect((await readJudgments(somaHome)).records[0]).toMatchObject({ backend: "explicit-marker", backendVersion: "1", decision: { verdict: "promote" } });
  expect(JUDGE_REGISTRY.find((caller) => caller.id === "errata-triage")).toMatchObject({ state: "shadow", measuredOn: null });
});

test("classifier failure after successful verdicts leaves the entire batch retryable", async () => {
  const { somaHome, candidate, reports, deps } = await setup();
  deps.readEvents = async () => [
    { ...candidate, id: "marker", metadata: { ...candidate.metadata, redactedExcerpt: "errata: broken" } },
    candidate, { ...candidate, id: "evt-2", timestamp: "2026-10-14T04:03:00Z" },
  ];
  let calls = 0;
  deps.classify = async () => {
    if (++calls === 2) throw new Error("PRIVATE SUBPROCESS FAILURE");
    return { verdict: "promote", reason: "Rejection.", backendVersion: "test-cli-1" };
  };
  expect(await runErrataTriage(deps)).toMatchObject({ outcome: "failed", promoted: 0, dropped: 0 });
  expect(await readErrata(somaHome)).toEqual([]);
  expect((await readJudgments(somaHome)).records).toEqual([]);
  expect(reports).toHaveLength(1);
  expect(reports[0].outcome).toBe("failed");
  expect(await readFile(reports[0].detailRef!, "utf8")).not.toContain("PRIVATE");
  deps.classify = async () => ({ verdict: "drop", reason: "New request.", backendVersion: "test-cli-1" });
  expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", promoted: 1, dropped: 2 });
  expect((await readJudgments(somaHome)).records).toHaveLength(3);
});

test("event identity, rather than equal feedback text, owns deduplication", async () => {
  const { somaHome, candidate, deps } = await setup();
  deps.readEvents = async () => [candidate, candidate, { ...candidate, id: "evt-2" }];
  deps.classify = async () => ({ verdict: "drop", reason: "Request.", backendVersion: "test-cli-1" });
  await recordJudgment(somaHome, { v: 1, ts: at, caller: "mode-router", inputSha256: "x", backend: "regex", backendVersion: "1", decision: { eventId: candidate.id }, latencyMs: 0 });
  expect(await runErrataTriage(deps)).toMatchObject({ dropped: 2 });
  expect((await readJudgments(somaHome, { caller: "errata-triage" })).records).toHaveLength(2);
});

test("missing excerpt is skipped; missing anchors or transcript are judged unlinkable", async () => {
  const { somaHome, candidate, deps } = await setup();
  deps.readEvents = async () => [
    { ...candidate, id: "no-excerpt", metadata: { actor: "interactive" } },
    { ...candidate, id: "no-session", metadata: { ...candidate.metadata, sessionId: undefined } },
    { ...candidate, id: "missing-transcript", metadata: { ...candidate.metadata, transcriptPath: join(somaHome, "absent") } },
  ];
  expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", skipped: 1, unlinkable: 2, promoted: 0 });
  expect(await readErrata(somaHome)).toEqual([]);
  expect((await readJudgments(somaHome)).records.map((record) => record.decision.status)).toEqual(["unlinkable", "unlinkable"]);
});

test("classification receives redacted feedback only, never goal or delivered text", async () => {
  const { somaHome, candidate, deps } = await setup();
  await mkdir(join(somaHome, "profile", "goals"), { recursive: true });
  await writeFile(join(somaHome, "profile", "goals", "G1.md"), "PRIVATE GOAL WORDING");
  candidate.metadata!.redactedExcerpt = "That is wrong. token=secret-value";
  deps.classify = async (text) => {
    expect(text).toBe("That is wrong. [redacted]");
    expect(text).not.toContain("PRIVATE");
    return { verdict: "drop", reason: "Request.", backendVersion: "test-cli-1" };
  };
  expect((await runErrataTriage(deps)).outcome).toBe("succeeded");
  expect(await readFile(judgeLedgerPath(somaHome), "utf8")).not.toContain("secret-value");
});

test("judgment write failure fails the job; retry recovers the Errata append without duplicating it", async () => {
  const { somaHome, deps } = await setup();
  deps.recordJudgment = async () => false;
  expect((await runErrataTriage(deps)).outcome).toBe("failed");
  expect(await readErrata(somaHome)).toHaveLength(1);
  expect((await readJudgments(somaHome)).records).toHaveLength(0);
  deps.recordJudgment = undefined;
  expect((await runErrataTriage(deps)).outcome).toBe("succeeded");
  expect(await readErrata(somaHome)).toHaveLength(1);
  expect((await readJudgments(somaHome)).records).toHaveLength(1);
});

test("overlapping triage jobs serialize judgment and promotion by event id", async () => {
  const { somaHome, deps, reports } = await setup();
  const results = await Promise.all([runErrataTriage(deps), runErrataTriage(deps)]);
  expect(results.map((result) => result.outcome)).toEqual(["succeeded", "succeeded"]);
  expect(results.reduce((sum, result) => sum + result.promoted, 0)).toBe(1);
  expect(await readErrata(somaHome)).toHaveLength(1);
  expect((await readJudgments(somaHome)).records).toHaveLength(1);
  expect(reports).toHaveLength(2);
});

test("default event reader finds persisted feedback candidates", async () => {
  const { somaHome, candidate, deps } = await setup();
  await appendSomaMemoryEvent(somaHome, candidate);
  deps.readEvents = undefined;
  expect((await runErrataTriage(deps)).promoted).toBe(1);
});

test("candidates in rotated event segments are not lost", async () => {
  const { somaHome, candidate, deps } = await setup();
  const path = somaMemoryEventsPath(somaHome);
  const first = Buffer.from(JSON.stringify(candidate) + "\n");
  const second = Buffer.from(JSON.stringify({ ...candidate, id: "other", kind: "lifecycle.session_end" }) + "\n");
  const limit = Math.max(first.length, second.length);
  await appendEventBatch(path, first, limit);
  await appendEventBatch(path, second, limit);
  deps.readEvents = undefined;
  expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", promoted: 1 });
});

test("success, empty and failed jobs each publish exactly one real run-ledger envelope without complaint text", async () => {
  const { somaHome, candidate, deps } = await setup();
  const events: ExecutionRunFinishedEvent[] = [];
  deps.publishRun = undefined;
  deps.env = { SOMA_PRINCIPAL: "test-principal" };
  deps.publishRunFinished = async (event) => { events.push(event); };
  const success = await runErrataTriage(deps);
  const empty = await runErrataTriage(deps);
  deps.readEvents = async () => [{ ...candidate, id: "new-feedback" }];
  deps.classify = async () => { throw new Error("PRIVATE ERROR"); };
  const failure = await runErrataTriage(deps);
  expect(events).toHaveLength(3);
  expect(events.map((event) => event.input.payload.outcome)).toEqual(["succeeded", "succeeded", "failed"]);
  for (const [index, result] of [success, empty, failure].entries()) {
    expect(events[index].input.payload).toMatchObject({
      ran: { kind: "job", ref: "errata-triage" }, detail_ref: result.detailRef,
    });
    expect(await readFile(result.detailRef, "utf8")).not.toContain(candidate.metadata!.redactedExcerpt as string);
  }
  expect(JSON.stringify(events)).not.toContain(candidate.metadata!.redactedExcerpt as string);
  expect(JSON.stringify(events)).not.toContain("PRIVATE");
  expect((await readJudgments(somaHome)).records).toHaveLength(1);
});

test("a corrupt judgment ledger fails rather than re-promoting an uncertain event", async () => {
  const { somaHome, deps, reports } = await setup();
  await mkdir(join(somaHome, "memory", "STATE", "judgments"), { recursive: true });
  await writeFile(judgeLedgerPath(somaHome), "torn judgment\n");
  expect((await runErrataTriage(deps)).outcome).toBe("failed");
  expect(await readErrata(somaHome)).toEqual([]);
  expect(reports).toHaveLength(1);
});
