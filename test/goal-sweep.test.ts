import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExecutionRunFinished, type ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { runGoalSweep, type GoalSweepDeps } from "../src/goal-sweep";
import { buildRunFinishedEnvelope } from "../src/run-ledger";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import type { GoalRecord } from "../src/types";
import type { NodeState } from "../src/graph/index";

const NOW = new Date("2026-10-15T06:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const PRIVATE = "Private goal wording must stay home";
const goal: GoalRecord = {
  id: "G5", status: "active", supports: ["M0"], sensor: "feed-check", reviewBy: "2026-10-15",
  wording: PRIVATE, body: `${PRIVATE}\nPrivate drop condition`,
};
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function harness(overrides: Partial<GoalSweepDeps> = {}) {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-goal-sweep-"));
  homes.push(somaHome);
  const events: ExecutionRunFinishedEvent[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let sequence = 0;
  const deps: GoalSweepDeps = {
    somaHome, activationsDir: join(somaHome, "activations"), goals: [goal], now: () => NOW,
    listVsas: async () => [], readBlueprints: async () => [{ id: "feed-check" }], readRepos: async () => [],
    env: { SOMA_PRINCIPAL: "jc", MF_SERVES_GOAL: "G99", MF_SERVES_NODE: "other/repo#1" },
    runId: () => `sweep-${sequence++}`, publish: async (event) => { events.push(event); },
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), ...overrides,
  };
  return { deps, events, stdout, stderr };
}

function node(id: string, days: number, status: "open" | "closed" = "open", serves?: string): NodeState {
  return {
    ref: { id }, node: { id, title: "Map wording", autonomy: "approve", ...(serves ? { serves } : {}) },
    updatedAt: ago(days), status, typed: true, author: "ivy-agent", assignees: [], blockedBy: [],
  };
}

test.each([
  [3, "observe", undefined, "ok"],
  [20, "build", undefined, "regressed"],
  [20, "build", 30, "ok"],
  [3, "complete", undefined, "regressed"],
  [14, "verify", undefined, "ok"],
  [14.001, "verify", undefined, "regressed"],
] as const)("VSA age %s phase %s window %s gives %s", async (days, phase, pursuitWindow, value) => {
  const h = await harness({
    goals: [{ ...goal, pursuitWindow }],
    listVsas: async () => [{ serves: "G5", updated: ago(days), phase }],
    readRepos: async () => ["owner/listed"],
    graphStore: () => ({ listOpenRoots: async () => [node("1", 1, "closed", "G5")], readSubtree: async () => [] }),
  });
  expect((await runGoalSweep(h.deps)).exitCode).toBe(0);
  expect(h.events[0].input.payload).toMatchObject({ state: { subject: "G5.pursuit", value } });
});

test.each(["root", "descendant"])("listed map's recent %s counts, unlisted repos are never read", async (source) => {
  const scanned: string[] = [];
  const roots: string[] = [];
  const h = await harness({
    readRepos: async () => ["owner/listed"],
    graphStore: (repo) => {
      scanned.push(repo);
      return {
        listOpenRoots: async (serves) => { expect(serves).toBe("G5"); return [node("1", source === "root" ? 2 : 20, "open", serves)]; },
        readSubtree: async (ref) => { roots.push(ref.id); return [node("2", source === "descendant" ? 2 : 20, "closed")]; },
      };
    },
  });
  await runGoalSweep(h.deps);
  expect(h.events[0].input.payload.state?.value).toBe("ok");
  expect(scanned).toEqual(["owner/listed"]);
  expect(roots).toEqual(["1"]);
  h.deps.readRepos = async () => [];
  await runGoalSweep(h.deps);
  expect(h.events[3].input.payload.state?.value).toBe("regressed");
  expect(scanned).toEqual(["owner/listed"]);
});

test.each([
  ["mechanism", "auto", "G5", "0 7 * * *", "ok"],
  ["mechanism", "approval", "G5", "0 7 * * *", "ok"],
  ["mechanism", undefined, "G5", "0 7 * * *", "ok"],
  ["feed-check", "auto", "G5", "0 7 * * *", "regressed"],
  ["mechanism", "disabled", "G5", "0 7 * * *", "regressed"],
  ["mechanism", "auto", "G6", "0 7 * * *", "regressed"],
  ["mechanism", "auto", "G5", undefined, "regressed"],
] as const)("blueprint %s policy %s serves %s schedule %s gives %s", async (id, policy, goal, schedule, value) => {
  const h = await harness({ readBlueprints: async () => [{ id, policy, serves: { goal }, when: { schedule } }] });
  await runGoalSweep(h.deps);
  expect(h.events[0].input.payload.state?.value).toBe(value);
});

test.each([
  ["2026-10-14", "regressed"], ["2026-10-15", "ok"], ["2026-10-16", "ok"], [undefined, "regressed"],
] as const)("review date %s gives %s", async (reviewBy, value) => {
  const h = await harness({ goals: [{ ...goal, reviewBy }] });
  await runGoalSweep(h.deps);
  expect(h.events[1].input.payload.state).toEqual({ subject: "G5.review", value });
});

test.each(["2026-10-14T22:30:00Z", "2026-01-14T23:30:00Z"])("review uses Zurich's date at UTC %s", async (time) => {
  const h = await harness({ now: () => new Date(time), goals: [{ ...goal, reviewBy: time.slice(0, 10) }] });
  await runGoalSweep(h.deps);
  expect(h.events[1].input.payload.state?.value).toBe("regressed");
});

test("sensor existence includes disabled blueprints and ignores unrelated IDs", async () => {
  const h = await harness({ readBlueprints: async () => [{ id: "feed-check", policy: "disabled" }] });
  await runGoalSweep(h.deps);
  expect(h.events[2].input.payload.state?.value).toBe("ok");
  h.deps.readBlueprints = async () => [{ id: "unrelated" }];
  await runGoalSweep(h.deps);
  expect(h.events[5].input.payload.state?.value).toBe("regressed");
});

test("only active goals emit, each check gets an independent valid ID-only envelope", async () => {
  const goals: GoalRecord[] = [goal, ...["draft", "paused", "achieved", "dropped"].map((status, index) =>
    ({ ...goal, id: `G${index + 6}`, status } as GoalRecord))];
  const h = await harness({ goals });
  await runGoalSweep(h.deps);
  expect(h.events).toHaveLength(3);
  expect(new Set(h.events.map((event) => event.input.payload.run_id)).size).toBe(3);
  for (const event of h.events) {
    expect(event.input.type).toBe("execution.run.finished");
    expect(event.input.payload).toMatchObject({ ran: { kind: "job", ref: "goal-sweep/G5" }, serves: { goal: "G5" }, outcome: "succeeded" });
    expect(event.input.payload.serves).not.toHaveProperty("node");
    const envelope = await buildRunFinishedEnvelope(event);
    expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
    expect(JSON.stringify(envelope)).not.toContain(PRIVATE);
    expect(JSON.stringify(envelope)).not.toContain("feed-check");
    expect(JSON.stringify(envelope)).not.toContain("Map wording");
  }
  expect(h.stdout).toEqual(["G5.pursuit\tregressed", "G5.review\tok", "G5.sensor\tok"]);
});

test.each(["listing", "subtree", "unsupported"])("repo %s failure is a failed pursuit without state, other goals and checks continue", async (failure) => {
  const h = await harness({
    goals: [goal, { ...goal, id: "G6" }], readRepos: async () => ["owner/broken", "owner/good"],
    // A positive VSA link cannot hide a repo outage.
    listVsas: async () => [{ serves: "G5", phase: "build", updated: ago(1) }],
    graphStore: (repo) => ({
      listOpenRoots: failure === "unsupported" && repo.endsWith("broken") ? undefined : async (serves) => {
        if (failure === "listing" && repo.endsWith("broken")) throw new Error(PRIVATE);
        return [node("1", 1, "open", serves)];
      },
      readSubtree: async () => { if (failure === "subtree" && repo.endsWith("broken")) throw new Error(PRIVATE); return []; },
    }),
  });
  expect((await runGoalSweep(h.deps)).exitCode).toBe(1);
  expect(h.events).toHaveLength(6);
  for (const index of [0, 3]) {
    expect(h.events[index].input.payload.outcome).toBe("failed");
    expect(h.events[index].input.payload).not.toHaveProperty("state");
    expect(h.events[index + 1].input.payload.outcome).toBe("succeeded");
    expect(h.events[index + 2].input.payload.outcome).toBe("succeeded");
  }
  expect(h.stderr.join("\n")).toContain("owner/broken");
  expect(h.stderr.join("\n")).not.toContain(PRIVATE);
});

test.each(["listVsas", "readBlueprints", "readRepos"] as const)("%s failure is isolated and never echoes private diagnostics", async (reader) => {
  const h = await harness({ [reader]: async () => { throw new Error(PRIVATE); } });
  await runGoalSweep(h.deps);
  expect(h.events[0].input.payload).toMatchObject({ outcome: "failed" });
  expect(h.events[0].input.payload).not.toHaveProperty("state");
  expect(h.events[1].input.payload.outcome).toBe("succeeded");
  expect(h.events[2].input.payload.outcome).toBe(reader === "readBlueprints" ? "failed" : "succeeded");
  expect(h.stderr.join("\n")).not.toContain(PRIVATE);
});

test("publication failure does not prevent subsequent checks", async () => {
  let count = 0;
  const h = await harness({ publish: async () => { if (++count === 1) throw new Error("bus unavailable"); } });
  const result = await runGoalSweep(h.deps);
  expect(count).toBe(3);
  expect(result.exitCode).toBe(1);
  expect(result.checks.map((check) => check.publication)).toEqual(["failed", "published", "published"]);
});

test("no principal prints results and exits zero even on unavailable facts, with no spool or events", async () => {
  const h = await harness({ env: {}, readRepos: async () => { throw new Error("unavailable"); } });
  expect((await runGoalSweep(h.deps)).exitCode).toBe(0);
  expect(h.events).toEqual([]);
  expect(h.stdout).toHaveLength(3);
  expect(h.stdout[0]).toBe("G5.pursuit\tfailed");
  expect(await Bun.file(join(h.deps.somaHome, "memory", "STATE", "events.jsonl")).exists()).toBe(false);
});

test("missing sweep.yaml warns once across goals; VSA and blueprint pursuit still count", async () => {
  const h = await harness({
    readRepos: undefined, goals: [goal, { ...goal, id: "G6" }],
    listVsas: async () => [{ serves: "G5", phase: "build", updated: ago(3) }],
    readBlueprints: async () => [{ id: "mechanism", serves: { goal: "G6" }, when: { schedule: "0 7 * * *" } }],
    graphStore: () => { throw new Error("must not scan"); },
  });
  await runGoalSweep(h.deps);
  expect(h.stderr).toHaveLength(1);
  expect(h.stderr[0]).toContain("sweep.yaml is missing");
  expect(h.events[0].input.payload.state?.value).toBe("ok");
  expect(h.events[3].input.payload.state?.value).toBe("ok");
});

async function filesystemFixture() {
  const h = await harness({ goals: undefined, listVsas: undefined, readBlueprints: undefined, readRepos: undefined });
  const goals = join(h.deps.somaHome, "profile", "goals");
  await mkdir(goals, { recursive: true });
  await mkdir(h.deps.activationsDir);
  await writeFile(join(goals, "G5.md"), `---\nid: G5\nstatus: active\nsupports: []\nsensor: feed-check\nreview_by: 2026-10-15\n---\n${PRIVATE}\n`);
  await writeFile(join(h.deps.activationsDir, "jobs.yaml"), `schema: metafactory/activation/v1\nactivations:\n  - id: feed-check\n    target: sensor\n    serves: {goal: G5}\n    when: {schedule: '0 7 * * *'}\n    payload: {private: '${PRIVATE}'}\n  - id: mechanism\n    target: mechanism\n    serves: {goal: G5}\n    when: {schedule: '0 8 * * *'}\n`);
  return { ...h, goals };
}

test("CLI reads real goals, blueprint documents and sweep.yaml, respecting the repo allowlist", async () => {
  const h = await filesystemFixture();
  await writeFile(join(h.goals, "sweep.yaml"), "repos: [owner/listed, owner/listed]\n");
  const repos: string[] = [];
  const result = await runGoalCli(parseGoalArgs(["goal", "sweep", "--soma-home", h.deps.somaHome]), {
    sweep: { ...h.deps, graphStore: (repo) => { repos.push(repo); return { listOpenRoots: async () => [], readSubtree: async () => [] }; } },
  });
  expect(result).toBe("G5.pursuit\tok\nG5.review\tok\nG5.sensor\tok");
  expect(repos).toEqual(["owner/listed"]);
  expect(h.stderr).toEqual([]);
});

test.each(["vsa", "isa"])("filesystem sweep reads serves, phase and update in %s storage", async (dir) => {
  const h = await filesystemFixture();
  await writeFile(join(h.deps.activationsDir, "jobs.yaml"), "schema: metafactory/activation/v1\nactivations: [{id: feed-check}]\n");
  await mkdir(join(h.deps.somaHome, dir));
  const vsa = join(h.deps.somaHome, dir, "work.md");
  await writeFile(vsa, `---\nserves: G5\nphase: build\nupdated: ${ago(3)}\n---\n${PRIVATE}\n`);
  await runGoalSweep(h.deps);
  expect(h.events[0].input.payload.state?.value).toBe("ok");
  await writeFile(vsa, (await readFile(vsa, "utf8")).replace("phase: build", "phase: complete"));
  await runGoalSweep(h.deps);
  expect(h.events[3].input.payload.state?.value).toBe("regressed");
});

test("VSA without a recorded update fails pursuit rather than defaulting to now", async () => {
  const h = await filesystemFixture();
  await mkdir(join(h.deps.somaHome, "vsa"));
  await writeFile(join(h.deps.somaHome, "vsa", "work.md"), "---\nserves: G5\nphase: build\n---\n");
  await runGoalSweep(h.deps);
  expect(h.events[0].input.payload.outcome).toBe("failed");
  expect(h.events[0].input.payload).not.toHaveProperty("state");
  expect(h.events[1].input.payload.outcome).toBe("succeeded");
});

test.each(["repos: wrong", "repos: [owner/name, ../bad]", "repos: [", `repos: ['${PRIVATE}']`])(
  "invalid sweep config fails pursuit without private diagnostics: %s", async (content) => {
    const h = await filesystemFixture();
    await writeFile(join(h.goals, "sweep.yaml"), content);
    await runGoalSweep(h.deps);
    expect(h.events[0].input.payload.outcome).toBe("failed");
    expect(h.events[0].input.payload).not.toHaveProperty("state");
    expect(h.events[1].input.payload.outcome).toBe("succeeded");
    expect(h.stderr.join("\n")).not.toContain(PRIVATE);
  },
);

test("malformed blueprint fails sensor and pursuit without leaking payload", async () => {
  const h = await filesystemFixture();
  await writeFile(join(h.deps.activationsDir, "jobs.yaml"), `schema: [${PRIVATE}`);
  await runGoalSweep(h.deps);
  expect(h.events.map((event) => event.input.payload.outcome)).toEqual(["failed", "succeeded", "failed"]);
  expect(h.events[2].input.payload).not.toHaveProperty("state");
  expect(h.stderr.join("\n")).not.toContain(PRIVATE);
});

test("executable CLI with no principal prints checks, warns once and exits zero", async () => {
  const h = await filesystemFixture();
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "goal", "sweep", "--soma-home", h.deps.somaHome], {
    env: { ...process.env, SOMA_PRINCIPAL: "", REFLEX_ACTIVATIONS_DIR: h.deps.activationsDir },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("G5.pursuit\tok");
  expect(result.stdout.toString()).toContain("G5.sensor\tok");
  expect(result.stderr.toString().match(/sweep.yaml is missing/g)).toHaveLength(1);
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain(PRIVATE);
});

test("no active goals means no checks and no source reads", async () => {
  const unavailable = async () => { throw new Error("must not read"); };
  const h = await harness({ goals: [{ ...goal, status: "paused" }], listVsas: unavailable, readBlueprints: unavailable, readRepos: unavailable });
  expect(await runGoalSweep(h.deps)).toEqual({ exitCode: 0, checks: [] });
  expect(h.events).toEqual([]);
  expect(h.stdout).toEqual([]);
  expect(h.stderr).toEqual([]);
});

test.each(["personal", "config", "env", "injected"])("sweep uses the %s activation directory", async (selection) => {
  const h = await filesystemFixture();
  const homeDir = h.deps.somaHome;
  const personal = join(homeDir, ".config", "reflex", "personal-activations");
  await mkdir(personal, { recursive: true });
  await writeFile(join(personal, "sensor.yaml"), "schema: metafactory/activation/v1\nactivations: [{id: feed-check}]\n");
  const config = join(homeDir, "custom-activations");
  await mkdir(config);
  await writeFile(join(config, "sensor.yaml"), "schema: metafactory/activation/v1\nactivations: [{id: feed-check}]\n");
  const env = { ...h.deps.env };
  if (selection !== "personal") await writeFile(join(homeDir, "config.yaml"), "goals: {activations_dir: custom-activations}\n");
  if (selection === "env" || selection === "injected") env.REFLEX_ACTIVATIONS_DIR = h.deps.activationsDir;
  const { activationsDir: _dir, ...sweep } = h.deps;
  await runGoalCli(parseGoalArgs(["goal", "sweep", "--home-dir", homeDir, "--soma-home", homeDir]), {
    env, sweep: { ...sweep, env }, ...(selection === "injected" ? { activationsDir: personal } : {}),
  });
  expect(h.events[2].input.payload.state?.value).toBe("ok");
  expect(h.events[0].input.payload.state?.value).toBe(selection === "env" ? "ok" : "regressed");
});
