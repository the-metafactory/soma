import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  createAlgorithmRun,
  recordAlgorithmSession,
  VerificationGateError,
  verifyAlgorithmCriterion,
  type AlgorithmSessionEnv,
} from "../src/algorithm/algorithm";
import { algorithmRunPath, readAlgorithmRunById, writeAlgorithmRun } from "../src/algorithm/algorithm-store";
import { parseAlgorithmArgs, runAlgorithmCli } from "../src/cli/algorithm";

const homes: string[] = [];
const S1 = { CLAUDE_CODE_SESSION_ID: "S1" };
const S2 = { CLAUDE_CODE_SESSION_ID: "S2" };
const neutralS1 = { SOMA_SESSION_ID: "S1" };
const neutralS2 = { SOMA_SESSION_ID: "S2" };
const evidence = "bun test test/algorithm-sessions.test.ts: assertions passed";

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function fixture(env: AlgorithmSessionEnv = {}) {
  return createAlgorithmRun({
    id: "sessions",
    prompt: "Track Algorithm sessions",
    intent: "Persist verification provenance",
    currentState: "Prose-only verification",
    goal: "Structured verification",
    criteria: [{ id: "C3", text: "Verification preserves session provenance" }],
  }, env);
}

async function home() {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-algorithm-sessions-"));
  homes.push(somaHome);
  return somaHome;
}

async function cli(somaHome: string, args: string[], env: AlgorithmSessionEnv = {}) {
  return runAlgorithmCli(parseAlgorithmArgs([
    "algorithm", ...args, "--id", "sessions", "--soma-home", somaHome,
  ]), { env });
}

test("session mutation helper preserves order, deduplicates, and leaves absent keys unchanged", () => {
  const original = fixture();
  expect(recordAlgorithmSession(original, {})).toBe(original);
  expect(recordAlgorithmSession(original, { SOMA_SESSION_ID: "" })).toBe(original);
  expect(recordAlgorithmSession(original, S1)).toBe(original);
  const first = recordAlgorithmSession(original, neutralS1);
  expect(recordAlgorithmSession(first, neutralS1)).toBe(first);
  expect(recordAlgorithmSession(recordAlgorithmSession(first, neutralS2), neutralS1).sessionIds).toEqual(["S1", "S2"]);
  expect(original.sessionIds).toEqual([]);
  const legacy = { ...original };
  delete legacy.sessionIds;
  expect(recordAlgorithmSession(legacy, {})).toBe(legacy);
  expect(recordAlgorithmSession(legacy, neutralS1).sessionIds).toEqual(["S1"]);
});

test("named verify options preserve the existing positional API including reconstruction", () => {
  const original = fixture();
  const timestamp = "2026-10-14T10:00:00.000Z";
  const provenance = { substrate: "codex" as const };
  for (const enforceGate of [true, false]) {
    const evidenceKind = enforceGate ? "tested" as const : "specified" as const;
    const named = verifyAlgorithmCriterion(original, "C3", "passed", evidence, { timestamp, provenance, evidenceKind, enforceGate });
    const positional = verifyAlgorithmCriterion(original, "C3", "passed", evidence, timestamp, provenance, evidenceKind, enforceGate);
    expect(named).toEqual(positional);
  }
});

for (const outcome of ["passed", "failed", "dropped", "deferred-probe"] as const) {
  test(`verification stores structured ${outcome} without changing prose`, () => {
    const run = verifyAlgorithmCriterion(fixture(), "C3", outcome, evidence,
      { timestamp: "2026-10-14T10:00:00.000Z", evidenceKind: outcome === "passed" ? "tested" : undefined, env: neutralS1 });
    expect(run.verification.at(-1)).toEqual({
      timestamp: "2026-10-14T10:00:00.000Z",
      phase: "observe",
      text: `C3: ${outcome}. ${evidence}`,
      criterionId: "C3",
      outcome,
      sessionId: "S1",
    });
    expect(run.sessionIds).toEqual(["S1"]);
  });
}

test("CLI new and subsequent verbs append each substrate session once; reads and missing keys do not", async () => {
  const somaHome = await home();
  await cli(somaHome, ["new", "--prompt", "Track sessions", "--intent", "Persist provenance",
    "--current-state", "No sessions", "--goal", "Recorded sessions", "--criterion", "C3:Verified provenance"], S1);
  await cli(somaHome, ["decision", "--text", "Preserve provenance"], S1);
  await cli(somaHome, ["change", "--text", "Add provenance fields"], S1);
  expect((await readAlgorithmRunById("sessions", { somaHome })).run.sessionIds).toEqual(["S1"]);
  await cli(somaHome, ["batch", "--op", `verify:C3:passed+tested:${evidence}`,
    "--op", "decision:Keep structured provenance"], S2);
  await cli(somaHome, ["verify", "--criterion-id", "C3", "--status", "passed",
    "--evidence-kind", "tested", "--evidence", evidence], S1);
  await cli(somaHome, ["learn", "--text", "Use substrate sessions at mutation boundaries"]);
  const { run } = await readAlgorithmRunById("sessions", { somaHome });
  expect(run.sessionIds).toEqual(["S1", "S2"]);
  expect(run.verification.map((entry) => entry.sessionId)).toEqual(["S2", "S1"]);
  const path = algorithmRunPath(run, { somaHome });
  const before = await readFile(path, "utf8");
  await cli(somaHome, ["show"], { CLAUDE_CODE_SESSION_ID: "read-only" });
  expect(await readFile(path, "utf8")).toBe(before);
});

test("CLI projects neutral sessions ahead of native sessions for writes and gate telemetry", async () => {
  const somaHome = await home();
  await writeAlgorithmRun(fixture(), { somaHome });
  const env = { SOMA_SESSION_ID: "neutral", CLAUDE_CODE_SESSION_ID: "native" };
  await cli(somaHome, ["verify", "--criterion-id", "C3", "--status", "passed",
    "--evidence-kind", "tested", "--evidence", evidence], env);
  const { run } = await readAlgorithmRunById("sessions", { somaHome });
  expect(run.sessionIds).toEqual(["neutral"]);
  expect(run.verification.at(-1)?.sessionId).toBe("neutral");
  await expect(cli(somaHome, ["verify", "--criterion-id", "C3", "--status", "passed",
    "--evidence-kind", "specified", "--evidence", evidence], env)).rejects.toBeInstanceOf(VerificationGateError);
  const events = (await readFile(join(somaHome, "memory/STATE/events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  expect(events.find((event) => event.kind === "verification.gate_violation").metadata.sessionId).toBe("neutral");
});

for (const action of ["verify", "batch"] as const) {
  for (const env of [S1, {}] as AlgorithmSessionEnv[]) {
    test(`${action} gate refusal writes no pass and attributes known session ${JSON.stringify(env)}`, async () => {
      const somaHome = await home();
      const run = fixture();
      await writeAlgorithmRun(run, { somaHome });
      const path = algorithmRunPath(run, { somaHome });
      const before = await readFile(path, "utf8");
      const args = action === "verify"
        ? ["verify", "--criterion-id", "C3", "--status", "passed", "--evidence-kind", "specified", "--evidence", evidence]
        : ["batch", "--op", "change:Must remain unwritten", "--op", `verify:C3:passed+specified:${evidence}`];
      await expect(cli(somaHome, args, env)).rejects.toBeInstanceOf(VerificationGateError);
      expect(await readFile(path, "utf8")).toBe(before);
      const events = (await readFile(join(somaHome, "memory/STATE/events.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const violation = events.find((event) => event.kind === "verification.gate_violation");
      expect(violation.metadata.criterionId).toBe("C3");
      if (env.CLAUDE_CODE_SESSION_ID) expect(violation.metadata.sessionId).toBe("S1");
      else expect(violation.metadata).not.toHaveProperty("sessionId");
    });
  }
}

test("legacy prose-only entries load, render, and verify without a session", async () => {
  const somaHome = await home();
  const legacy = fixture();
  delete legacy.sessionIds;
  legacy.verification.push({ timestamp: legacy.createdAt, phase: "observe", text: "C3: failed. Old evidence" });
  await writeAlgorithmRun(legacy, { somaHome });
  expect(await cli(somaHome, ["show"])).toContain("C3");
  await cli(somaHome, ["verify", "--criterion-id", "C3", "--status", "passed",
    "--evidence-kind", "tested", "--evidence", evidence]);
  const { run } = await readAlgorithmRunById("sessions", { somaHome });
  expect(run.sessionIds).toBeUndefined();
  expect(run.verification[0]).toEqual(legacy.verification[0]);
  expect(run.verification[1]).toMatchObject({ criterionId: "C3", outcome: "passed", text: `C3: passed. ${evidence}` });
  expect(run.verification[1]).not.toHaveProperty("sessionId");
});
