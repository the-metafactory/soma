import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExecutionRunFinished, type ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { SomaCliError } from "../src/cli/errors";
import { runQueueSensor, type QueueSensorDeps } from "../src/flows/goal-sense-queue";
import { buildRunFinishedEnvelope } from "../src/flows/run-ledger";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const options = { goal: "G8", source: "ranger-escalations", max: 2 } as const;
const NOW = new Date("2026-10-17T06:30:00Z");

async function fixture(mode: "mixed" | "empty" | "no-table" | "missing" | "corrupt" = "mixed") {
  const root = await mkdtemp(join(tmpdir(), "soma-queue-"));
  roots.push(root);
  const journalDir = join(root, ".config", "ranger");
  await mkdir(journalDir, { recursive: true });
  const journal = join(journalDir, "state.sqlite");
  if (mode === "corrupt") await writeFile(journal, "not a SQLite journal");
  else if (mode !== "missing") {
    const db = new Database(journal, { create: true });
    try {
      if (mode === "no-table") db.run("CREATE TABLE unrelated (id INTEGER)");
      else {
        db.run("CREATE TABLE escalations (key TEXT PRIMARY KEY, status TEXT NOT NULL, route TEXT, title TEXT)");
        if (mode === "mixed") {
          const insert = db.prepare("INSERT INTO escalations VALUES (?, ?, ?, ?)");
          insert.run("one", "open", "escalate-hitl", "Private escalation title");
          insert.run("two", "open", "escalate-hitl", "Private escalation title");
          insert.run("three", "open", "provisioning", "Private escalation title");
          insert.run("four", "closed", "escalate-hitl", "Private escalation title");
          insert.run("five", "closed", "escalate-hitl", "Private escalation title");
          insert.run("six", "closed", "provisioning", "Private escalation title");
        }
      }
    } finally { db.close(); }
  }
  const events: ExecutionRunFinishedEvent[] = [];
  const stdout: string[] = [];
  const deps: QueueSensorDeps = {
    somaHome: join(root, ".soma"), env: { SOMA_PRINCIPAL: "jc" },
    now: () => NOW, stdout: (line) => stdout.push(line),
    publish: (event) => { events.push(event); return Promise.resolve(); },
  };
  return { root, journal, journalDir, events, stdout, deps };
}

test.each([
  { max: 2, value: "on-track" },
  { max: 1, value: "off-track" },
])("default route counts only two open HITL rows against max=$max", async ({ max, value }) => {
  const h = await fixture();
  const before = await readFile(h.journal);
  expect(await runQueueSensor({ ...options, max }, h.journal, h.deps)).toMatchObject({ exitCode: 0, count: 2, value });
  expect(h.events).toHaveLength(1);
  expect(h.events[0].input.payload).toMatchObject({
    producer: "soma", ran: { kind: "job", ref: "goal-sense/G8" }, serves: { goal: "G8" },
    outcome: "succeeded", state: { subject: "G8", value },
    started_at: NOW.toISOString(), ended_at: NOW.toISOString(),
  });
  const envelope = await buildRunFinishedEnvelope(h.events[0]);
  expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
  expect(JSON.stringify(envelope)).not.toContain("Private escalation title");
  expect(JSON.stringify(envelope)).not.toContain(h.journal);
  expect(h.stdout.join("\n")).toContain(`G8: ${value} (2 open escalate-hitl`);
  expect(await readFile(h.journal)).toEqual(before);
  expect(await readdir(h.journalDir)).toEqual(["state.sqlite"]);
});

test("provisioning route counts one open row and ignores closed rows", async () => {
  const h = await fixture();
  const before = await readFile(h.journal);
  expect(await runQueueSensor({ ...options, route: "provisioning", max: 0 }, h.journal, h.deps))
    .toMatchObject({ exitCode: 0, count: 1, value: "off-track" });
  expect(await readFile(h.journal)).toEqual(before);
});

test("an empty queue is on-track even with max zero", async () => {
  const h = await fixture("empty");
  const before = await readFile(h.journal);
  expect(await runQueueSensor({ ...options, max: 0 }, h.journal, h.deps))
    .toMatchObject({ exitCode: 0, count: 0, value: "on-track" });
  expect(h.events[0].input.payload.state).toEqual({ subject: "G8", value: "on-track" });
  expect(await readFile(h.journal)).toEqual(before);
});

test.each(["missing", "no-table", "corrupt"] as const)("%s journal fails without state, creation or mutation", async (mode) => {
  const h = await fixture(mode);
  const before = mode === "missing" ? undefined : await readFile(h.journal);
  const result = await runQueueSensor(options, h.journal, h.deps);
  expect(result).toMatchObject({ exitCode: 1, error: expect.stringContaining("journal read failed") });
  expect(result).not.toHaveProperty("count");
  expect(result).not.toHaveProperty("value");
  expect(h.events).toHaveLength(1);
  expect(h.events[0].input.payload).toMatchObject({ outcome: "failed", serves: { goal: "G8" } });
  expect(h.events[0].input.payload).not.toHaveProperty("state");
  expect(h.stdout).toEqual([]);
  expect(await readdir(h.journalDir)).toEqual(mode === "missing" ? [] : ["state.sqlite"]);
  if (before) expect(await readFile(h.journal)).toEqual(before);
});

test("a live WAL journal includes committed open rows without changing journal or WAL bytes", async () => {
  const h = await fixture("empty");
  const writer = new Database(h.journal);
  try {
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("INSERT INTO escalations VALUES ('live', 'open', 'escalate-hitl', 'private')");
    const before = await readFile(h.journal);
    const wal = await readFile(`${h.journal}-wal`);
    expect(await runQueueSensor(options, h.journal, h.deps)).toMatchObject({ count: 1, value: "on-track", exitCode: 0 });
    expect(await readFile(h.journal)).toEqual(before);
    expect(await readFile(`${h.journal}-wal`)).toEqual(wal);
  } finally { writer.close(); }
});

test.each([{ source: "github" }, { max: -1 }, { max: 1.5 }, { goal: "private wording" }, { route: "other" }])(
  "invalid sensor options %j refuse before clock, journal or publication", async (invalid) => {
    const h = await fixture("missing");
    const result = await runQueueSensor({ ...options, ...invalid } as never, h.journal, {
      ...h.deps, now: () => { throw new Error("must refuse before starting a run"); },
    });
    expect(result.exitCode).toBe(2);
    expect(h.events).toEqual([]);
    expect(await readdir(h.journalDir)).toEqual([]);
  },
);

test("queue CLI dispatch reads Ranger's fixed path under the selected home", async () => {
  const h = await fixture();
  const parsed = parseGoalArgs(["goal", "sense", "queue", "--goal", "G8", "--source", "ranger-escalations", "--max", "2", "--home-dir", h.root]);
  expect(parsed.options.queue).toEqual({ ...options, route: "escalate-hitl" });
  expect(await runGoalCli(parsed, { queueSensor: h.deps })).toContain("G8: on-track (2 open escalate-hitl");
  expect(h.events).toHaveLength(1);
});

test("CLI journal failure preserves exit 1 and the failed ledger event", async () => {
  const h = await fixture("no-table");
  const parsed = parseGoalArgs(["goal", "sense", "queue", "--goal", "G8", "--source", "ranger-escalations", "--max", "2", "--home-dir", h.root]);
  const error = await runGoalCli(parsed, { queueSensor: h.deps }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(SomaCliError);
  expect((error as SomaCliError).exitCode).toBe(1);
  expect(h.events[0].input.payload.outcome).toBe("failed");
  expect(h.events[0].input.payload).not.toHaveProperty("state");
});

test.each([
  ["--source", "github", "--max", "2"],
  ["--source", "ranger-escalations", "--max", "-1"],
  ["--source", "ranger-escalations", "--max", "1.5"],
  ["--source", "ranger-escalations", "--max", "NaN"],
  ["--source", "ranger-escalations", "--max", "2", "--route", "other"],
  ["--max", "2"], ["--source", "ranger-escalations"],
  ["--source", "ranger-escalations", "--max", "2", "--path", "/private/journal"],
].map((flags) => ({ flags })))("CLI refuses invalid queue flags $flags during parsing", ({ flags }) => {
  try {
    parseGoalArgs(["goal", "sense", "queue", "--goal", "G8", ...flags]);
    throw new Error("expected parse refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(SomaCliError);
    expect((error as SomaCliError).exitCode).toBe(2);
  }
});

test.each(["mixed", "missing"] as const)("executable CLI on %s journal reports the correct output and process exit", async (mode) => {
  const h = await fixture(mode);
  const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "goal", "sense", "queue", "--goal", "G8", "--source", "ranger-escalations", "--max", "2", "--home-dir", h.root], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, SOMA_PRINCIPAL: "" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(mode === "mixed" ? 0 : 1);
  if (mode === "mixed") expect(stdout).toContain("G8: on-track (2 open escalate-hitl");
  else { expect(stdout).toBe(""); expect(stderr).toContain("journal read failed"); }
});
