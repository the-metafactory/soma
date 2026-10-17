import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExecutionRunFinished, type ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { runSomaCli } from "../src/cli";
import { SomaCliError } from "../src/cli/errors";
import { runRateSensor, type RateSensorDeps } from "../src/goal-sense-rate";
import { rateKind, rateParams } from "../src/goal-kinds/rate";
import { goalKinds } from "../src/goal-kinds/registry";
import * as exports from "../src/goal-kinds";
import { buildRunFinishedEnvelope } from "../src/run-ledger";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const options = { goal: "G8", source: "ranger-escalations", min: 2, window_workdays: 3 } as const;
const NOW = new Date("2026-10-14T10:00:00Z"); // Wednesday, noon in Zurich.
type Row = [string, string, string | null];

async function fixture(mode: "empty" | "no-table" | "old" | "missing" | "corrupt" = "empty", rows: Row[] = []) {
  const root = await mkdtemp(join(tmpdir(), "soma-rate-"));
  roots.push(root);
  const journalDir = join(root, ".config", "ranger");
  await mkdir(journalDir, { recursive: true });
  const journal = join(journalDir, "state.sqlite");
  if (mode === "corrupt") await writeFile(journal, "not a SQLite journal");
  else if (mode !== "missing") {
    const db = new Database(journal, { create: true });
    try {
      if (mode === "no-table") db.run("CREATE TABLE unrelated (id INTEGER)");
      else if (mode === "old") db.run("CREATE TABLE escalations (status TEXT, route TEXT)");
      else {
        db.run("CREATE TABLE escalations (status TEXT, route TEXT, closed_at TEXT, title TEXT)");
        const insert = db.prepare("INSERT INTO escalations VALUES (?, ?, ?, 'Private escalation title')");
        for (const row of rows) insert.run(...row);
      }
    } finally { db.close(); }
  }
  const events: ExecutionRunFinishedEvent[] = [];
  const stdout: string[] = [];
  const deps: RateSensorDeps = {
    somaHome: join(root, ".soma"), env: { SOMA_PRINCIPAL: "jc" },
    now: () => NOW, stdout: (line) => stdout.push(line),
    publish: (event) => { events.push(event); return Promise.resolve(); },
  };
  return { root, journal, journalDir, events, stdout, deps };
}

const mixed: Row[] = [
  ["closed", "escalate-hitl", "2026-10-11T22:00:00.000Z"], // Monday midnight Zurich.
  ["closed", "escalate-hitl", "2026-10-14T12:00:00+02:00"], // Exactly now, offset spelling.
  ["closed", "escalate-hitl", "2026-10-11T21:59:59.999Z"],
  ["closed", "escalate-hitl", "2026-10-14T10:00:00.001Z"],
  ["closed", "escalate-hitl", null],
  ["open", "escalate-hitl", "2026-10-13T10:00:00Z"],
  ["closed", "provisioning", "2026-10-13T10:00:00Z"],
];

test.each([{ min: 2, value: "on-track" }, { min: 3, value: "off-track" }])(
  "Wednesday window counts only two closed HITL rows against min=$min", async ({ min, value }) => {
    const h = await fixture("empty", mixed);
    const before = await readFile(h.journal);
    expect(await runRateSensor({ ...options, min }, h.journal, h.deps)).toMatchObject({ exitCode: 0, count: 2, value });
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
    expect(h.stdout[0]).toContain(`G8: ${value} (2 closed escalate-hitl`);
    expect(await readFile(h.journal)).toEqual(before);
    expect(await readdir(h.journalDir)).toEqual(["state.sqlite"]);
  },
);

test("route filter counts provisioning independently", async () => {
  const h = await fixture("empty", mixed);
  expect(await runRateSensor({ ...options, route: "provisioning" }, h.journal, h.deps))
    .toMatchObject({ count: 1, value: "off-track", exitCode: 0 });
});

test.each([{ min: 0, value: "on-track" }, { min: 1, value: "off-track" }])("empty journal against min=$min", async ({ min, value }) => {
  const h = await fixture();
  expect(await runRateSensor({ ...options, min }, h.journal, h.deps)).toMatchObject({ count: 0, value, exitCode: 0 });
});

test("Saturday closures count when the workday window spans them", async () => {
  const h = await fixture("empty", [["closed", "escalate-hitl", "2026-10-10T10:00:00Z"]]);
  expect(await runRateSensor({ ...options, window_workdays: 4, min: 1 }, h.journal, h.deps))
    .toMatchObject({ count: 1, value: "on-track", exitCode: 0 });
});

test("New York starts at Monday local midnight rather than Zurich midnight", async () => {
  const h = await fixture("empty", [
    ["closed", "escalate-hitl", "2026-10-12T03:59:59.999Z"],
    ["closed", "escalate-hitl", "2026-10-12T04:00:00Z"],
  ]);
  expect(await runRateSensor({ ...options, timezone: "America/New_York" }, h.journal, h.deps))
    .toMatchObject({ count: 1, value: "off-track", exitCode: 0 });
});

test.each(["missing", "no-table", "old", "corrupt"] as const)("%s journal fails without state, creation or mutation", async (mode) => {
  const h = await fixture(mode);
  const before = mode === "missing" ? undefined : await readFile(h.journal);
  const result = await runRateSensor(options, h.journal, h.deps);
  expect(result.exitCode).toBe(1);
  expect(result.error).toContain("journal read failed");
  expect(result.error).not.toContain(h.journal);
  expect(result).not.toHaveProperty("count");
  expect(result).not.toHaveProperty("value");
  expect(h.events).toHaveLength(1);
  expect(h.events[0].input.payload).toMatchObject({ outcome: "failed", serves: { goal: "G8" } });
  expect(h.events[0].input.payload).not.toHaveProperty("state");
  expect(h.stdout).toEqual([]);
  expect(await readdir(h.journalDir)).toEqual(mode === "missing" ? [] : ["state.sqlite"]);
  if (before) expect(await readFile(h.journal)).toEqual(before);
});

test("live WAL closures count without changing journal or WAL bytes", async () => {
  const h = await fixture();
  const writer = new Database(h.journal);
  try {
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("INSERT INTO escalations VALUES ('closed', 'escalate-hitl', ?, 'private')", [NOW.toISOString()]);
    const before = await readFile(h.journal);
    const wal = await readFile(`${h.journal}-wal`);
    expect(await runRateSensor(options, h.journal, h.deps)).toMatchObject({ count: 1, exitCode: 0 });
    expect(await readFile(h.journal)).toEqual(before);
    expect(await readFile(`${h.journal}-wal`)).toEqual(wal);
  } finally { writer.close(); }
});

test("an unreadable closure instant fails without leaking row data or mutating the journal", async () => {
  const h = await fixture("empty", [["closed", "escalate-hitl", "private invalid date"]]);
  const before = await readFile(h.journal);
  const result = await runRateSensor(options, h.journal, h.deps);
  expect(result.exitCode).toBe(1);
  expect(result.error).not.toContain("private invalid date");
  expect(h.events[0].input.payload.outcome).toBe("failed");
  expect(h.events[0].input.payload).not.toHaveProperty("state");
  expect(await readFile(h.journal)).toEqual(before);
});

const invalid = [
  { source: "github" }, { min: -1 }, { min: 0.5 }, { min: NaN }, { min: "2" },
  { window_workdays: 0 }, { window_workdays: -1 }, { window_workdays: 1.5 },
  { window_workdays: Number.MAX_SAFE_INTEGER + 1 }, { timezone: "Unknown/Zone" },
  { timezone: "" }, { goal: "private wording" }, { route: "other" }, { path: "/private/journal" },
];
test.each(invalid)("invalid sensor params %j refuse before clock, journal or publication", async (bad) => {
  const h = await fixture("missing");
  const result = await runRateSensor({ ...options, ...bad } as never, h.journal, {
    ...h.deps, now: () => { throw new Error("must refuse before starting a run"); },
  });
  expect(result.exitCode).toBe(2);
  expect(h.events).toEqual([]);
  expect(await readdir(h.journalDir)).toEqual([]);
});

const flags = ["goal", "sense", "rate", "--goal", "G8", "--source", "ranger-escalations", "--min", "2", "--window-workdays", "3"];
test.each([
  ["--source", "github"], ["--min", "-1"], ["--min", "1.5"], ["--min", "NaN"],
  ["--window-workdays", "0"], ["--window-workdays", "-1"], ["--window-workdays", "1.5"],
  ["--timezone", "Unknown/Zone"], ["--route", "other"], ["--path", "/private/journal"],
].map((extra) => ({ extra })))("CLI refuses invalid rate flags $extra during parsing", ({ extra }) => {
  try {
    parseGoalArgs([...flags, ...extra]);
    throw new Error("expected parse refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(SomaCliError);
    expect((error as SomaCliError).exitCode).toBe(2);
  }
});

test("CLI dispatch uses Ranger's fixed journal path and preserves failure exit 1", async () => {
  const h = await fixture("empty", mixed);
  const parsed = parseGoalArgs([...flags, "--home-dir", h.root]);
  expect(await runGoalCli(parsed, { rateSensor: h.deps })).toContain("G8: on-track (2 closed escalate-hitl");
  const missing = await fixture("old");
  const error = await runGoalCli(parseGoalArgs([...flags, "--home-dir", missing.root]), { rateSensor: missing.deps }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(SomaCliError);
  expect((error as SomaCliError).exitCode).toBe(1);
  expect(missing.events[0].input.payload.outcome).toBe("failed");
  expect(missing.events[0].input.payload).not.toHaveProperty("state");
});

test.each(["empty", "missing", "old"] as const)("executable CLI on %s journal", async (mode) => {
  const h = await fixture(mode);
  const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", ...flags, "--min", "0", "--home-dir", h.root], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, SOMA_PRINCIPAL: "" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(mode === "empty" ? 0 : 1);
  if (mode === "empty") expect(stdout).toContain("G8: on-track (0 closed escalate-hitl");
  else { expect(stdout).toBe(""); expect(stderr).toContain("journal read failed"); }
});

test("rate kind owns strict public params, defaults, catalog and CLI round trip", async () => {
  const params = rateParams.parse(options);
  expect(params).toEqual({ ...options, timezone: "Europe/Zurich", route: "escalate-hitl" });
  expect(exports.rateKind).toBe(rateKind);
  expect(exports.rateParams).toBe(rateParams);
  expect(goalKinds.rate).toBe(rateKind);
  expect(rateKind).toMatchObject({
    private: {}, role: "sensor", target: "@jc/goal-sense-rate",
    schedule: { schedule: "30 6 * * *", timezone: "Europe/Zurich" },
    command: ["soma", "goal", "sense", "rate"],
  });
  for (const route of ["escalate-hitl", "provisioning"] as const) {
    const p = { ...params, route, timezone: "America/New_York" };
    expect(parseGoalArgs([...rateKind.command.slice(1), ...rateKind.argv(p)]).options.rate).toEqual(p);
    expect(rateKind.stateRule(p)).toContain(`At least 2 closed ${route} escalations in the last 3 workdays in America/New_York`);
  }
  for (const bad of invalid) expect(rateParams.safeParse({ ...options, ...bad }).success).toBe(false);
  for (const field of Object.keys(options)) {
    expect(rateParams.safeParse(Object.fromEntries(Object.entries(options).filter(([key]) => key !== field))).success).toBe(false);
  }
  const catalog = JSON.parse(await runSomaCli(["goal", "kinds", "--json"]));
  expect(catalog.find((kind: { id: string }) => kind.id === "rate")).toMatchObject({
    private: {}, params: {
      additionalProperties: false, required: ["goal", "source", "min", "window_workdays"],
      properties: {
        source: { enum: ["ranger-escalations"] }, min: { type: "integer", minimum: 0 },
        window_workdays: { type: "integer", exclusiveMinimum: 0 },
        timezone: { default: "Europe/Zurich" }, route: { default: "escalate-hitl" },
      },
    },
  });
  expect(await runSomaCli(["goal", "kinds"])).toContain("rate\tsensor\t");
  expect(await runSomaCli(["goal", "sense", "--help"])).toContain("--window-workdays <n>");
});
