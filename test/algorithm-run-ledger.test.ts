import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  createEnvelope,
  InMemoryTransport,
  validateExecutionRunFinished,
  type ExecutionRunFinishedEvent,
  type MyelinEnvelope,
} from "@the-metafactory/myelin";
import {
  addAlgorithmCapabilities,
  advanceAlgorithmRun,
  createAlgorithmRun,
  recordAlgorithmObservation,
  setAlgorithmPlan,
  updateAlgorithmPlanStep,
  verifyAlgorithmCriterion,
} from "../src/algorithm";
import { recordAlgorithmCapabilityInvocation } from "../src/algorithm-capabilities";
import { abandonAlgorithmRun, getRunPhase } from "../src/algorithm-lifecycle";
import { readAlgorithmRunById, writeAlgorithmRun } from "../src/algorithm-store";
import { parseAlgorithmArgs, runAlgorithmCli, updateAndReportAlgorithmRun, type AlgorithmCliDeps } from "../src/cli/algorithm";
import {
  publishRunFinished,
  publishThroughOutbox,
  RUN_LEDGER_SOVEREIGNTY,
  RUN_LEDGER_TIMEOUT_MS,
  runLedgerSpoolPath,
  type RunLedgerEnv,
} from "../src/run-ledger";
import type { AlgorithmPhase, AlgorithmRun } from "../src/types";

const RUN_ID = "run-ledger-fixture";
const CREATED_AT = "2026-05-14T10:00:00.000Z";
const CLOSED_LOOPBACK = "nats://127.0.0.1:1";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempSomaHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "soma-run-ledger-"));
  homes.push(dir);
  return join(dir, ".soma");
}

/**
 * A run parked at `phase`, built through the real gates. At `learn` it is ready
 * to complete unless `withLearning` is false.
 */
function fixtureRun(phase: AlgorithmPhase, options: { withLearning?: boolean } = {}): AlgorithmRun {
  let run = createAlgorithmRun({
    id: RUN_ID,
    timestamp: CREATED_AT,
    substrate: "codex",
    prompt: "Emit the run ledger",
    intent: "Publish one envelope per finished run.",
    currentState: "Runs finish silently.",
    goal: "Finished runs reach the bus.",
    criteria: [{ id: "C1", text: "One envelope per finished run." }],
  });
  const steps: [AlgorithmPhase, () => void][] = [
    ["think", () => {
      run = recordAlgorithmObservation(run, { claim: "C1 exists", evidence: "read run.vsa", evidenceKind: "probed" }, "2026-05-14T10:00:30.000Z");
    }],
    ["plan", () => {
      run = addAlgorithmCapabilities(run, ["sequential-analysis"], "2026-05-14T10:02:00.000Z");
    }],
    ["build", () => {
      run = setAlgorithmPlan(run, [{ id: "P1", text: "Add the funnel.", criteriaIds: ["C1"], status: "open" }], "2026-05-14T10:04:00.000Z");
    }],
    ["execute", () => {
      run = { ...run, changelog: [{ timestamp: "2026-05-14T10:06:00.000Z", phase: "build", text: "Added the funnel." }] };
    }],
    ["verify", () => {
      run = updateAlgorithmPlanStep(run, "P1", "done", "Funnel tests pass.", "2026-05-14T10:08:00.000Z");
    }],
    ["learn", () => {
      run = verifyAlgorithmCriterion(run, "C1", "passed", "Ledger test captured one envelope.", "2026-05-14T10:10:00.000Z", undefined, "tested");
    }],
  ];
  for (const [target, prepare] of steps) {
    if (getRunPhase(run) === phase) break;
    prepare();
    run = advanceAlgorithmRun(run, "2026-05-14T10:11:00.000Z");
    expect(getRunPhase(run)).toBe(target);
  }
  if (phase === "learn" && options.withLearning !== false) {
    run = { ...run, learning: [{ timestamp: "2026-05-14T10:12:00.000Z", phase: "learn", text: "Funnels keep one emit path." }] };
    run = recordAlgorithmCapabilityInvocation(
      run,
      { name: "sequential-analysis", substrate: "codex", evidence: "Ordered the emit after the run write." },
      "2026-05-14T10:12:30.000Z",
    );
  }
  return run;
}

async function homeWith(run: AlgorithmRun): Promise<string> {
  const somaHome = await tempSomaHome();
  await writeAlgorithmRun(run, { somaHome });
  return somaHome;
}

interface Captured {
  events: ExecutionRunFinishedEvent[];
  deps: Partial<AlgorithmCliDeps>;
}

function capture(env: RunLedgerEnv): Captured {
  const events: ExecutionRunFinishedEvent[] = [];
  return {
    events,
    deps: {
      env,
      publishRunFinished: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
  };
}

async function cli(somaHome: string, args: string[], deps: Partial<AlgorithmCliDeps>): Promise<string> {
  return runAlgorithmCli(parseAlgorithmArgs(["algorithm", ...args, "--id", RUN_ID, "--soma-home", somaHome]), deps);
}

async function ledgerEvents(somaHome: string): Promise<{ kind: string; summary: string; metadata?: Record<string, unknown> }[]> {
  try {
    const raw = await readFile(join(somaHome, "memory", "STATE", "events.jsonl"), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { kind: string; summary: string; metadata?: Record<string, unknown> })
      .filter((event) => event.kind.startsWith("run_ledger."));
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Timestamps the verb itself stamps differ between two homes; everything else must not. */
function normalized(text: string, somaHome: string): string {
  return text.split(somaHome).join("<home>").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, "<ts>");
}

async function runFile(somaHome: string): Promise<string> {
  return normalized(await readFile(join(somaHome, "memory", "WORK", "algorithm-runs", `${RUN_ID}.json`), "utf8"), somaHome);
}

/** The same verb on the same fixture with the ledger disabled. */
async function baseline(run: AlgorithmRun, args: string[]): Promise<{ output: string; file: string }> {
  const somaHome = await homeWith(run);
  const output = await cli(somaHome, args, { env: {} });
  return { output: normalized(output, somaHome), file: await runFile(somaHome) };
}

function envelopeOf(event: ExecutionRunFinishedEvent): MyelinEnvelope {
  return createEnvelope({ ...event.input, sovereignty: { ...RUN_LEDGER_SOVEREIGNTY, ...event.input.sovereignty } });
}

test("advance from learn to complete publishes one valid execution.run.finished envelope", async () => {
  const somaHome = await homeWith(fixtureRun("learn"));
  const { events, deps } = capture({ SOMA_PRINCIPAL: "jc" });

  const output = await cli(somaHome, ["advance"], deps);

  const { run, path } = await readAlgorithmRunById(RUN_ID, { somaHome });
  expect(getRunPhase(run)).toBe("complete");
  expect(output).toContain(`path: ${path}`);
  expect(events).toHaveLength(1);
  const [event] = events;
  expect(event.subject).toBe("local.jc.default.execution.run.finished");
  expect(event.input.source).toBe("jc.soma.run");
  expect(event.input.sovereignty).toEqual(RUN_LEDGER_SOVEREIGNTY);
  expect(event.input.payload).toMatchObject({
    producer: "soma",
    ran: { kind: "algorithm", ref: RUN_ID },
    run_id: RUN_ID,
    outcome: "succeeded",
    started_at: CREATED_AT,
    ended_at: run.updatedAt,
    detail_ref: path,
  });
  expect(event.input.payload).not.toHaveProperty("serves");
  expect(event.input.payload).not.toHaveProperty("state");
  expect(validateExecutionRunFinished(envelopeOf(event))).toEqual({ valid: true, errors: [] });
  expect(await ledgerEvents(somaHome)).toEqual([]);
});

test("SOMA_STACK names the subject's stack segment", async () => {
  const somaHome = await homeWith(fixtureRun("learn"));
  const { events, deps } = capture({ SOMA_PRINCIPAL: "jc", SOMA_STACK: "lab" });
  await cli(somaHome, ["advance"], deps);
  expect(events.map((event) => event.subject)).toEqual(["local.jc.lab.execution.run.finished"]);
});

test("resume --until-phase complete publishes the same single envelope", async () => {
  const somaHome = await homeWith(fixtureRun("learn"));
  const { events, deps } = capture({ SOMA_PRINCIPAL: "jc" });

  await cli(somaHome, ["resume", "--until-phase", "complete"], deps);

  const { run, path } = await readAlgorithmRunById(RUN_ID, { somaHome });
  expect(events).toHaveLength(1);
  expect(events[0].input.payload).toMatchObject({ outcome: "succeeded", ended_at: run.updatedAt, detail_ref: path });
});

test("a batch whose operations end in complete publishes the same single envelope", async () => {
  const somaHome = await homeWith(fixtureRun("learn", { withLearning: false }));
  const { events, deps } = capture({ SOMA_PRINCIPAL: "jc" });

  await cli(
    somaHome,
    [
      "batch",
      "--op", "learn:Funnels keep one emit path.",
      "--op", "capability-invocation:sequential-analysis:Ordered the emit after the run write.",
      "--op", "advance",
    ],
    deps,
  );

  const { run } = await readAlgorithmRunById(RUN_ID, { somaHome });
  expect(getRunPhase(run)).toBe("complete");
  expect(events).toHaveLength(1);
  expect(events[0].input.payload).toMatchObject({ outcome: "succeeded", run_id: RUN_ID });
});

test("a run moved to abandoned through updateAndReportAlgorithmRun publishes outcome cancelled", async () => {
  const somaHome = await homeWith(fixtureRun("build"));
  const { events, deps } = capture({ SOMA_PRINCIPAL: "jc" });

  await updateAndReportAlgorithmRun(
    parseAlgorithmArgs(["algorithm", "show", "--id", RUN_ID, "--soma-home", somaHome]).options,
    deps,
    (run) => abandonAlgorithmRun(run, "Superseded by a smaller node."),
  );

  const { run } = await readAlgorithmRunById(RUN_ID, { somaHome });
  expect(getRunPhase(run)).toBe("abandoned");
  expect(events).toHaveLength(1);
  expect(events[0].input.payload).toMatchObject({ outcome: "cancelled", ended_at: run.updatedAt });
  expect(validateExecutionRunFinished(envelopeOf(events[0])).valid).toBe(true);
});

test("verbs that leave the run non-terminal publish nothing", async () => {
  const planned = setAlgorithmPlan(
    fixtureRun("plan"),
    [{ id: "P1", text: "Add the funnel.", criteriaIds: ["C1"], status: "open" }],
    "2026-05-14T10:04:00.000Z",
  );
  const cases: [AlgorithmRun, string[]][] = [
    [fixtureRun("observe"), ["observe", "--claim", "phase is observe", "--evidence", "read run.vsa", "--evidence-kind", "probed"]],
    [fixtureRun("verify"), ["verify", "--criterion-id", "C1", "--status", "passed", "--evidence", "ran the test", "--evidence-kind", "tested"]],
    [planned, ["advance"]],
    [fixtureRun("learn"), ["decision", "--text", "Keep the funnel small."]],
  ];
  for (const [fixture, args] of cases) {
    const somaHome = await homeWith(fixture);
    const { events, deps } = capture({ SOMA_PRINCIPAL: "jc" });
    await cli(somaHome, args, deps);
    const { run } = await readAlgorithmRunById(RUN_ID, { somaHome });
    expect(getRunPhase(run)).not.toBe("complete");
    expect(events).toEqual([]);
  }
});

test("a verb acting on a run already complete publishes nothing", async () => {
  const completed = advanceAlgorithmRun(fixtureRun("learn"), "2026-05-14T10:13:00.000Z");
  expect(getRunPhase(completed)).toBe("complete");
  const somaHome = await homeWith(completed);
  const { events, deps } = capture({ SOMA_PRINCIPAL: "jc" });

  await cli(somaHome, ["decision", "--text", "Post-hoc note."], deps);
  await cli(somaHome, ["resume", "--until-phase", "complete"], deps);

  expect(events).toEqual([]);
});

test("a refused update publishes nothing and keeps its error", async () => {
  const run = fixtureRun("learn", { withLearning: false });
  const ledger = await homeWith(run);
  const plain = await homeWith(run);
  const { events, deps } = capture({ SOMA_PRINCIPAL: "jc" });

  const expected = await cli(plain, ["advance"], { env: {} }).catch((error: unknown) => error);
  const actual = await cli(ledger, ["advance"], deps).catch((error: unknown) => error);

  expect(expected).toBeInstanceOf(Error);
  expect(actual).toBeInstanceOf(Error);
  expect((actual as Error).message).toBe((expected as Error).message);
  expect(events).toEqual([]);
  expect(await ledgerEvents(ledger)).toEqual([]);
});

test("a VerificationGate refusal publishes nothing and keeps its error", async () => {
  const somaHome = await homeWith(fixtureRun("verify"));
  const { events, deps } = capture({ SOMA_PRINCIPAL: "jc" });

  await expect(
    cli(somaHome, ["batch", "--op", "verify:C1:passed:no probe kind"], deps),
  ).rejects.toThrow(/VerificationGate/);
  expect(events).toEqual([]);
});

test("sync-from-isa publishes nothing", async () => {
  const somaHome = await tempSomaHome();
  const vsaPath = join(somaHome, "..", "work", "ledger-sync", "VSA.md");
  await mkdir(join(vsaPath, ".."), { recursive: true });
  await writeFile(
    vsaPath,
    [
      "---",
      "task: Sync a finished VSA",
      "slug: ledger-sync",
      "effort: E2",
      "phase: complete",
      "progress: 1/1",
      "mode: ALGORITHM",
      "started: 2026-05-29",
      "updated: 2026-05-29",
      "---",
      "",
      "## Goal",
      "",
      "Sync a finished VSA",
      "",
      "## Criteria",
      "",
      "- [x] ISC-1: the VSA is complete",
      "",
    ].join("\n"),
    "utf8",
  );
  const { events, deps } = capture({ SOMA_PRINCIPAL: "jc" });

  await runAlgorithmCli(
    parseAlgorithmArgs(["algorithm", "sync-from-isa", "--isa", vsaPath, "--substrate", "claude-code", "--soma-home", somaHome]),
    deps,
  );

  expect(events).toEqual([]);
});

const finished = {
  kind: "algorithm",
  ref: RUN_ID,
  runId: RUN_ID,
  outcome: "succeeded",
  startedAt: CREATED_AT,
  endedAt: "2026-05-14T10:13:00.000Z",
  detailRef: "/tmp/run.json",
} as const;

async function payloadFor(env: RunLedgerEnv): Promise<Record<string, unknown>> {
  const somaHome = await tempSomaHome();
  const events: ExecutionRunFinishedEvent[] = [];
  const result = await publishRunFinished(finished, {
    somaHome,
    substrate: "codex",
    env: { SOMA_PRINCIPAL: "jc", ...env },
    publish: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });
  expect(result).toBe("published");
  expect(events).toHaveLength(1);
  return events[0].input.payload;
}

test("MF_SERVES_GOAL and MF_SERVES_NODE become serves; unset or empty leave it out", async () => {
  expect((await payloadFor({ MF_SERVES_GOAL: "G1" })).serves).toEqual({ goal: "G1" });
  expect((await payloadFor({ MF_SERVES_GOAL: "G1", MF_SERVES_NODE: "820" })).serves).toEqual({ goal: "G1", node: "820" });
  expect((await payloadFor({ MF_SERVES_NODE: "820", MF_SERVES_GOAL: "" })).serves).toEqual({ node: "820" });
  expect(await payloadFor({})).not.toHaveProperty("serves");
  expect(await payloadFor({ MF_SERVES_GOAL: "", MF_SERVES_NODE: "" })).not.toHaveProperty("serves");
});

test("MF_CORRELATION_ID passes through as-is; unset or empty lets the builder generate one", async () => {
  expect((await payloadFor({ MF_CORRELATION_ID: "graph-walk-17" })).correlation_id).toBe("graph-walk-17");
  const uuid = "7f0c2e7a-2b1e-4c55-9a35-0c1f5b0a9d11";
  expect((await payloadFor({ MF_CORRELATION_ID: uuid })).correlation_id).toBe(uuid);
  for (const env of [{}, { MF_CORRELATION_ID: "" }]) {
    const generated = (await payloadFor(env)).correlation_id;
    expect(typeof generated).toBe("string");
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  }
});

test("SOMA_PRINCIPAL unset builds and publishes nothing and touches no spool", async () => {
  for (const env of [{}, { SOMA_PRINCIPAL: "" }]) {
    const somaHome = await homeWith(fixtureRun("learn"));
    // The default publisher, aimed at a closed port: any attempt would leave a
    // spool file and a failure event behind.
    await cli(somaHome, ["advance"], { env: { ...env, SOMA_NATS_URL: CLOSED_LOOPBACK } });
    const { run } = await readAlgorithmRunById(RUN_ID, { somaHome });
    expect(getRunPhase(run)).toBe("complete");
    expect(await exists(join(somaHome, "memory", "STATE", "run-ledger"))).toBe(false);
    expect(await ledgerEvents(somaHome)).toEqual([]);
  }
});

test("NATS unreachable: output and run file unchanged, one failure event, spool holds the put", async () => {
  const run = fixtureRun("learn");
  const expected = await baseline(run, ["advance"]);
  const somaHome = await homeWith(run);

  const output = await cli(somaHome, ["advance"], { env: { SOMA_PRINCIPAL: "jc", SOMA_NATS_URL: CLOSED_LOOPBACK } });

  expect(normalized(output, somaHome)).toBe(expected.output);
  expect(await runFile(somaHome)).toBe(expected.file);
  const failures = await ledgerEvents(somaHome);
  expect(failures.map((event) => event.kind)).toEqual(["run_ledger.publish_failed"]);
  expect(failures[0].metadata).toMatchObject({ runId: RUN_ID, stage: "publish" });
  const spool = (await readFile(runLedgerSpoolPath(somaHome), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { op: string; subject?: string });
  expect(spool).toHaveLength(1);
  expect(spool[0]).toMatchObject({ op: "put", subject: "local.jc.default.execution.run.finished" });
});

test("SOMA_NATS_CREDS naming a missing file fails open with one failure event", async () => {
  const run = fixtureRun("learn");
  const expected = await baseline(run, ["advance"]);
  const somaHome = await homeWith(run);
  const creds = join(somaHome, "missing.creds");

  const output = await cli(somaHome, ["advance"], { env: { SOMA_PRINCIPAL: "jc", SOMA_NATS_URL: CLOSED_LOOPBACK, SOMA_NATS_CREDS: creds } });

  expect(normalized(output, somaHome)).toBe(expected.output);
  expect(await runFile(somaHome)).toBe(expected.file);
  const failures = await ledgerEvents(somaHome);
  expect(failures.map((event) => event.kind)).toEqual(["run_ledger.publish_failed"]);
  expect(failures[0].summary).toContain("SOMA_NATS_CREDS");
});

test("a throwing builder fails open with one failure event and publishes nothing", async () => {
  const run = fixtureRun("learn");
  const expected = await baseline(run, ["advance"]);
  const somaHome = await homeWith(run);
  // A dot cannot sit in a subject segment, so the builder refuses the principal.
  const { events, deps } = capture({ SOMA_PRINCIPAL: "j.c" });

  const output = await cli(somaHome, ["advance"], deps);

  expect(normalized(output, somaHome)).toBe(expected.output);
  expect(await runFile(somaHome)).toBe(expected.file);
  expect(events).toEqual([]);
  const failures = await ledgerEvents(somaHome);
  expect(failures.map((event) => event.kind)).toEqual(["run_ledger.publish_failed"]);
  expect(failures[0].metadata).toMatchObject({ stage: "build" });
});

test("an emit that outlasts the ceiling is abandoned and recorded as timed out", async () => {
  const somaHome = await homeWith(fixtureRun("learn"));
  const started = Date.now();

  const output = await cli(somaHome, ["advance"], {
    env: { SOMA_PRINCIPAL: "jc" },
    publishRunFinished: () => new Promise<void>(() => undefined),
  });

  const elapsed = Date.now() - started;
  expect(output).toContain("phase: complete");
  expect(elapsed).toBeGreaterThanOrEqual(RUN_LEDGER_TIMEOUT_MS - 50);
  expect(elapsed).toBeLessThan(RUN_LEDGER_TIMEOUT_MS + 1500);
  expect(RUN_LEDGER_TIMEOUT_MS).toBe(2000);
  const failures = await ledgerEvents(somaHome);
  expect(failures.map((event) => event.kind)).toEqual(["run_ledger.publish_failed"]);
  expect(failures[0].metadata).toMatchObject({ stage: "timeout" });
  expect(failures[0].summary).toMatch(/timed out/);
});

test("a non-loopback SOMA_NATS_URL without SOMA_NATS_CREDS publishes nothing and names SOMA_NATS_CREDS", async () => {
  const somaHome = await homeWith(fixtureRun("learn"));

  await cli(somaHome, ["advance"], { env: { SOMA_PRINCIPAL: "jc", SOMA_NATS_URL: "nats://bus.example.invalid:4222" } });

  const failures = await ledgerEvents(somaHome);
  expect(failures.map((event) => event.kind)).toEqual(["run_ledger.publish_failed"]);
  expect(failures[0].summary).toContain("SOMA_NATS_CREDS");
  expect(await exists(runLedgerSpoolPath(somaHome))).toBe(false);
});

test("the real outbox over InMemoryTransport delivers a valid envelope and acks the spool", async () => {
  const somaHome = await tempSomaHome();
  const spoolPath = runLedgerSpoolPath(somaHome);
  const inner = new InMemoryTransport();
  const received: MyelinEnvelope[] = [];
  await inner.subscribe("local.jc.default.execution.run.finished", (envelope) => {
    received.push(envelope);
    return Promise.resolve();
  });
  let built: ExecutionRunFinishedEvent | undefined;

  const result = await publishRunFinished(finished, {
    somaHome,
    substrate: "codex",
    env: { SOMA_PRINCIPAL: "jc", MF_CORRELATION_ID: "graph-walk-17" },
    publish: async (event) => {
      built = event;
      await publishThroughOutbox(event, { inner, spoolPath });
    },
  });

  expect(result).toBe("published");
  expect(built).toBeDefined();
  expect(received).toHaveLength(1);
  expect(validateExecutionRunFinished(received[0])).toEqual({ valid: true, errors: [] });
  expect(received[0].source).toBe("jc.soma.run");
  expect(received[0].payload).toMatchObject({ run_id: RUN_ID, correlation_id: "graph-walk-17" });
  const spool = (await readFile(spoolPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { op: string; id: string });
  expect(spool.map((line) => line.op)).toEqual(["put", "ack"]);
  expect(spool[0].id).toBe(received[0].id);
  expect(await ledgerEvents(somaHome)).toEqual([]);
});
