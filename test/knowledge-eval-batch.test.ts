import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runBatch, type BatchDeps, type BatchOptions, type BatchReport, type Score } from "../scripts/knowledge-eval-batch";
import { loadFixture, storeRoot, type Fixture, type TrialOptions, type TrialRecord, type TrialResult } from "../scripts/knowledge-eval-trial";

let root: string;
let somaHome: string;
let store: string;

function fixture(id: string): Fixture {
  return {
    id, domain: "soma", capability: "discover-reuse", condition: "correct", repo: "/unused",
    rev: "a".repeat(40), prompt: "Use the maintained source.", seed: [], hints: ["route", "file", "symbol"],
    acceptance_probe: "true", expected_sources: ["README.md"], forbidden_duplicates: [], known_wrong: "duplicate",
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ko-batch-test-")));
  somaHome = join(root, "soma");
  store = storeRoot(somaHome);
  mkdirSync(join(store, "fixtures"), { recursive: true });
  for (const id of ["one", "two"]) writeFileSync(join(store, "fixtures", `${id}.json`), JSON.stringify(fixture(id)));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function options(overrides: Partial<BatchOptions> = {}): BatchOptions {
  return {
    fixtures: ["one"], arms: [{ label: "a", homeSource: somaHome }, { label: "b", homeSource: somaHome }],
    substrate: "claude", model: "pinned-model", somaHome, timeoutMs: 10_000, probeTimeoutMs: 10_000,
    keep: false, ...overrides,
  };
}

function result(input: TrialOptions, overrides: Partial<TrialRecord> = {}): TrialResult {
  const loaded = loadFixture(input.fixture, store);
  return {
    recordPath: join(store, "stub-record.json"),
    record: {
      fixture_id: loaded.fixture.id, fixture_sha: loaded.sha, arm: input.arm, substrate: input.substrate,
      hint_level: input.hint, model: input.model, cli: { name: "claude", version: "1.0" }, soma_sha: "b".repeat(40),
      outcome: "completed", substrate_exit: 0, timed_out: false, error: null, probe_exit: 0,
      start_of_session_tokens: 10, total_tokens: 100, wall_time_ms: 1, sources_read: ["README.md"],
      duplicates_created: [], probed_after_last_edit: true, started_at: new Date().toISOString(), transcript_path: "/stub",
      ...overrides,
    },
  };
}

function scripted(scores: Record<string, Score[]>, seen: string[] = []): BatchDeps {
  const repeats = new Map<string, number>();
  return { trial: (input) => {
    const id = loadFixture(input.fixture, store).fixture.id;
    const key = `${id}/${input.arm}`;
    if (input.hint === 0) repeats.set(key, (repeats.get(key) ?? 0) + 1);
    const repeat = repeats.get(key) ?? 0;
    seen.push(`${key}/${repeat}/H${input.hint}`);
    const score = scores[key]?.[repeat - 1];
    if (score === undefined) throw new Error(`Unscripted trial ${key}/${repeat}`);
    return Promise.resolve(result(input, {
      probe_exit: typeof score === "number" && input.hint >= score ? 0 : 1,
      ...(score === "errored" ? { outcome: "errored", error: "substrate unavailable", probe_exit: 0 } as const : {}),
    }));
  } };
}

describe("batch scheduling through the B1 trial seam", () => {
  test("fresh H0 starts; failed probes climb to H3, pass stops, and exhausted ladders score fail", async () => {
    const seen: string[] = [];
    const { report } = await runBatch(options(), scripted({ "one/a": [2, 2, 2], "one/b": ["fail", "fail", "fail"] }, seen));
    expect(seen.slice(0, 7)).toEqual([
      "one/a/1/H0", "one/b/1/H0", "one/a/1/H1", "one/b/1/H1", "one/a/1/H2", "one/b/1/H2", "one/b/1/H3",
    ]);
    expect(seen).toHaveLength(21);
    const [a, b] = report.scenarios[0].arms;
    expect(a).toMatchObject({ scores: [2, 2, 2], median: 2, spread: 0 });
    expect(b).toMatchObject({ scores: ["fail", "fail", "fail"], median: "fail", spread: 0 });
    expect(report).toMatchObject({ status: "completed", model: "pinned-model", cli: { name: "claude", version: "1.0" } });
  });

  test("spread greater than one in either arm adds exactly two repeats to both arms for that fixture", async () => {
    const seen: string[] = [];
    const { report } = await runBatch(options({ fixtures: ["one", "two"] }), scripted({
      "one/a": [1, 1, 1, 1, 1], "one/b": [0, 2, 0, 1, 2], "two/a": [0, 1, 1], "two/b": [1, 1, 1],
    }, seen));
    expect(report.scenarios.map((scenario) => scenario.extra_repeats)).toEqual([true, false]);
    expect(report.scenarios[0].arms.map((arm) => arm.scores)).toEqual([[1, 1, 1, 1, 1], [0, 2, 0, 1, 2]]);
    expect(report.scenarios[1].arms.map((arm) => arm.scores.length)).toEqual([3, 3]);
    expect(seen.slice(0, 3)).toEqual(["one/a/1/H0", "one/b/1/H0", "one/a/1/H1"]);
    expect(report.scenarios[0].arms[1]).toMatchObject({ median: 1, spread: 2 });
  });

  test("one arm also expands; fail is the step beyond H3 for spread", async () => {
    const { report } = await runBatch(options({ arms: [{ label: "a", homeSource: somaHome }] }), scripted({ "one/a": [2, "fail", 3, 2, 2] }));
    expect(report.scenarios[0].extra_repeats).toBe(true);
    expect(report.scenarios[0].arms[0]).toMatchObject({ scores: [2, "fail", 3, 2, 2], median: 2, spread: 2 });
  });

  test("recorded errors and thrown trial errors stop that ladder, never score fail, and remain visible", async () => {
    const scriptedDeps = scripted({ "one/a": ["errored", 0, 0], "one/b": [0, 0, 0] });
    let calls = 0;
    const { report, outDir } = await runBatch(options(), { trial: (input) => {
      calls += 1;
      if (calls === 4) throw new Error("projection failed");
      return scriptedDeps.trial(input);
    } });
    expect(report.scenarios[0].extra_repeats).toBe(false);
    expect(report.scenarios[0].arms[0]).toMatchObject({ scores: ["errored", 0, 0], median: 0, spread: 0, errored: 1 });
    expect(report.scenarios[0].arms[1]).toMatchObject({ scores: [0, "errored", 0], errored: 1, sources_read: "unmeasured", total_tokens_median: "unmeasured" });
    expect(report.trials).toHaveLength(6);
    const markdown = readFileSync(join(outDir, "report.md"), "utf8");
    expect(markdown).toContain("substrate unavailable");
    expect(markdown).toContain("projection failed");
    expect(JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"))).toEqual(report);
  });

  test("all errors leave hint median and spread unmeasured", async () => {
    const { report } = await runBatch(options(), { trial: () => { throw new Error("setup failed"); } });
    for (const arm of report.scenarios[0].arms) expect(arm).toMatchObject({
      scores: ["errored", "errored", "errored"], median: "unmeasured", spread: "unmeasured", errored: 3,
    });
  });

  test("an error after a failed hint stops that ladder; an abnormal probe exit is errored", async () => {
    const seen: string[] = [];
    const { report } = await runBatch(options(), { trial: (input) => {
      seen.push(`${input.arm}/H${input.hint}`);
      if (input.arm === "a" && input.hint === 1) throw new Error("lost trial");
      return Promise.resolve(result(input, { probe_exit: input.arm === "a" ? 1 : null }));
    } });
    expect(seen).toEqual(["a/H0", "b/H0", "a/H1", "a/H0", "b/H0", "a/H1", "a/H0", "b/H0", "a/H1"]);
    for (const arm of report.scenarios[0].arms) expect(arm.scores).toEqual(["errored", "errored", "errored"]);
  });

  for (const [name, overrides] of [
    ["model", { model: "other-model" }],
    ["CLI version", { cli: { name: "claude", version: "2.0" } }],
    ["CLI name", { cli: { name: "other", version: "1.0" } }],
    ["fixture hash", { fixture_sha: "drift" }],
  ] as const) test(`${name} drift aborts immediately and persists the partial batch`, async () => {
    let calls = 0;
    const { report, outDir } = await runBatch(options(), { trial: (input) => {
      calls += 1;
      return Promise.resolve(result(input, calls === 2 ? overrides : {}));
    } });
    expect(calls).toBe(2);
    expect(report.status).toBe("aborted");
    expect(report.abort_reason).not.toBeNull();
    expect(report.model).toBe("pinned-model");
    expect(report.cli).toEqual({ name: "claude", version: "1.0" });
    expect(report.scenarios[0].arms[1].scores).toEqual(["errored"]);
    expect(readFileSync(join(outDir, "report.md"), "utf8")).toContain("Aborted:");
  });

  test("an unknown CLI version cannot establish a comparison baseline", async () => {
    const { report } = await runBatch(options(), { trial: (input) => Promise.resolve(result(input, { cli: { name: "claude", version: "unknown" } })) });
    expect(report.status).toBe("aborted");
    expect(report.trials).toHaveLength(1);
    expect(report.scenarios[0].arms[1].scores).toEqual([]);
  });

  test("an abort leaves never-attempted arms and fixtures unmeasured in both reports", async () => {
    const { report, outDir } = await runBatch(options({ fixtures: ["one", "two"] }), {
      trial: (input) => Promise.resolve(result(input, { cli: { name: "claude", version: "unknown" } })),
    });
    expect(report.status).toBe("aborted");
    expect(report.trials).toHaveLength(1);
    const json = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")) as BatchReport;
    const markdown = readFileSync(join(outDir, "report.md"), "utf8");
    for (const persisted of [report, json]) {
      for (const arm of [persisted.scenarios[0].arms[1], ...persisted.scenarios[1].arms]) {
        expect(arm).toMatchObject({
          scores: [], repeats: [], duplicates_created_counts: [], sources_read_counts: [],
          duplicates_created: "unmeasured", sources_read: "unmeasured",
          start_of_session_tokens_median: "unmeasured", total_tokens_median: "unmeasured",
        });
      }
      expect(persisted.scenarios[0].arms[0]).toMatchObject({ duplicates_created: 0, sources_read: 1 });
    }
    for (const [id, arm] of [["one", "b"], ["two", "a"], ["two", "b"]]) {
      expect(markdown).toContain(`| ${id} | ${arm} |  | unmeasured | unmeasured | 0 | unmeasured | unmeasured | unmeasured () | unmeasured () |`);
    }
  });

  test("trial-level token medians and per-repeat counts include failed hint attempts", async () => {
    let count = 0;
    const { report, outDir } = await runBatch(options({ arms: [{ label: "a", homeSource: somaHome }] }), { trial: (input) => {
      count += 1;
      return Promise.resolve(result(input, {
        probe_exit: input.hint === 1 ? 0 : 1, start_of_session_tokens: count * 10,
        total_tokens: count === 4 ? "unmeasured" : count * 100, duplicates_created: input.hint === 0 ? ["dup"] : [],
      }));
    } });
    expect(report.scenarios[0].arms[0]).toMatchObject({
      start_of_session_tokens_median: 35, total_tokens_median: "unmeasured",
      duplicates_created_counts: [1, 1, 1], sources_read_counts: [2, 2, 2], duplicates_created: 3, sources_read: 6,
    });
    expect(readFileSync(join(outDir, "report.md"), "utf8")).toContain("| one | a | 1, 1, 1 | 1 | 0 | 0 | 35 | unmeasured | 3 (1, 1, 1) | 6 (2, 2, 2) |");
  });

  test("all repeats use frozen fixture bytes even when the original changes", async () => {
    let calls = 0;
    const original = join(store, "fixtures", "one.json");
    const { report } = await runBatch(options(), { trial: (input) => {
      calls += 1;
      if (calls === 1) writeFileSync(original, "invalid now");
      expect(loadFixture(input.fixture, store).fixture.prompt).toBe("Use the maintained source.");
      return Promise.resolve(result(input));
    } });
    expect(report.status).toBe("completed");
    expect(calls).toBe(6);
  });
});

describe("batch command boundaries", () => {
  test("default selection is sorted; a second arm can use a separate home", () => {
    const parsed = parseArgs(["batch", "--arms", "a,b", "--substrate", "claude", "--home-source", somaHome, "--soma-home", somaHome, "--arm-home", `b=${root}`]);
    expect(parsed.options.fixtures).toEqual([join(store, "fixtures", "one.json"), join(store, "fixtures", "two.json")]);
    expect(parsed.options.arms).toEqual([{ label: "a", homeSource: somaHome }, { label: "b", homeSource: root }]);
    expect(() => parseArgs(["batch", "--arms", "a,a"])).toThrow(/distinct/);
    expect(() => parseArgs(["batch", "--arms", "a,b,c"])).toThrow(/distinct/);
    expect(() => parseArgs(["batch", "--arms", "a", "--hint", "1"])).toThrow(/does not take/);
  });

  test("empty, duplicate or invalid fixtures and unsafe output are refused before any trial", async () => {
    let calls = 0;
    const deps: BatchDeps = { trial: (input) => { calls += 1; return Promise.resolve(result(input)); } };
    await expect(runBatch(options({ fixtures: [] }), deps)).rejects.toThrow(/No fixtures/);
    await expect(runBatch(options({ fixtures: ["one", "one"] }), deps)).rejects.toThrow(/Duplicate fixture/);
    await expect(runBatch(options({ out: join(root, "outside") }), deps)).rejects.toThrow(/outside/);
    symlinkSync(root, join(store, "escape"));
    await expect(runBatch(options({ out: join(store, "escape", "batch") }), deps)).rejects.toThrow(/outside/);
    writeFileSync(join(store, "fixtures", "two.json"), "{}");
    await expect(runBatch(options({ fixtures: ["one", "two"] }), deps)).rejects.toThrow(/Invalid fixture/);
    expect(calls).toBe(0);
    expect(existsSync(join(root, "outside"))).toBe(false);
  });

  test("separate batches get distinct directories and an explicit directory cannot be reused", async () => {
    const deps: BatchDeps = { trial: (input) => Promise.resolve(result(input)) };
    const first = await runBatch(options(), deps);
    const second = await runBatch(options(), deps);
    expect(first.outDir).not.toBe(second.outDir);
    await expect(runBatch(options({ out: first.outDir }), deps)).rejects.toThrow();
  });

  test("CLI dispatch runs the real isolated trial and projection against a local substrate stub", async () => {
    const repo = join(root, "upstream");
    mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "hello\n");
    const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
    const git = (...args: string[]): string => {
      const proc = Bun.spawnSync(["git", ...args], { cwd: repo, env });
      expect(proc.exitCode).toBe(0);
      return proc.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "fixture");
    writeFileSync(join(store, "fixtures", "one.json"), JSON.stringify({ ...fixture("one"), repo, rev: git("rev-parse", "HEAD"), acceptance_probe: "test -f done" }));
    const bin = join(root, "claude-stub");
    writeFileSync(bin, [
      "#!/bin/sh", 'if [ "$1" = "--version" ]; then echo "1.0 (Claude Code)"; exit 0; fi',
      "cat >/dev/null", "touch done", `echo '{"type":"system","subtype":"init","model":"pinned-model"}'`,
      `echo '{"type":"result","is_error":false,"usage":{"input_tokens":5,"output_tokens":5}}'`, "",
    ].join("\n"));
    chmodSync(bin, 0o755);
    const proc = Bun.spawn([
      process.execPath, join(import.meta.dir, "..", "scripts", "knowledge-eval.ts"), "batch", "--arms", "a,b",
      "--substrate", "claude", "--fixtures", "one", "--home-source", somaHome, "--soma-home", somaHome,
      "--model", "pinned-model", "--claude-bin", bin,
    ], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const reportPath = stdout.trim().split("\n")[0].slice("completed: ".length);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as BatchReport;
    expect(report.status).toBe("completed");
    expect(report.trials.map((trial) => trial.arm)).toEqual(["a", "b", "a", "b", "a", "b"]);
    for (const arm of report.scenarios[0].arms) expect(arm).toMatchObject({ scores: [0, 0, 0], median: 0, spread: 0, total_tokens_median: 10 });
    expect(new Set(report.trials.map((trial) => trial.record_path)).size).toBe(6);
  }, 120_000);
});
