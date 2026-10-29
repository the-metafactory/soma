import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { parseJudgeArgs } from "../src/cli/judge";
import { hashJudgmentInput, judgeLabelsPath, judgeLedgerPath, readJudgmentLabels, readJudgments, recordJudgment, type JudgmentRecord } from "../src/core/index";
import { DEFAULT_JUDGE_THRESHOLDS, JUDGE_REGISTRY, assertJudgeRegistry, labelJudgment, summarizeJudgments, type JudgeCaller } from "../src/router/index";

async function fixture(work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "soma-judge-labels-"));
  try {
    await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function judgment(overrides: Partial<JudgmentRecord> = {}): JudgmentRecord {
  return {
    v: 1, ts: "2026-10-28T12:00:00.000Z", caller: "mode-router", inputSha256: hashJudgmentInput("hello"),
    backend: "regex", backendVersion: "test-v1", decision: { mode: "minimal" }, latencyMs: 1, ...overrides,
  };
}

function label(home: string, judgmentId: string, verdict: "right" | "wrong") {
  return labelJudgment({ somaHome: home, judgmentId, verdict, env: { SOMA_PRINCIPAL: "test-principal" } });
}

function cli(home: string, args: string[], principal = "test-principal") {
  return Bun.spawnSync([process.execPath, "src/cli.ts", "judge", ...args, "--soma-home", home], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, SOMA_PRINCIPAL: principal },
    stdout: "pipe", stderr: "pipe",
  });
}

test("every registered enforce caller declares a principal measurement meeting its thresholds", () => {
  assertJudgeRegistry();
  expect(DEFAULT_JUDGE_THRESHOLDS).toEqual({ minLabels: 20, enforceBar: 0.9 });
  expect(JUDGE_REGISTRY.find((caller) => caller.id === "errata-triage")).toMatchObject({ state: "shadow", measuredOn: null });
});

function enforcedCaller(): JudgeCaller {
  return {
    id: "probe-caller", description: "Enforcement eligibility probe", state: "enforce",
    measuredOn: { agreement: 0.9, principalLabels: 20, labelSource: "principal", date: "2026-10-28", backend: "regex", backendVersion: "v1" },
  };
}

test("the registry gate names the caller for missing or insufficient principal evidence", () => {
  expect(() => assertJudgeRegistry([enforcedCaller()])).not.toThrow();
  for (const measurement of [null, { ...enforcedCaller().measuredOn!, principalLabels: 19 },
    { ...enforcedCaller().measuredOn!, agreement: 0.89 }, { ...enforcedCaller().measuredOn!, agreement: NaN },
    { ...enforcedCaller().measuredOn!, principalLabels: 20.5 }]) {
    expect(() => assertJudgeRegistry([{ ...enforcedCaller(), measuredOn: measurement }])).toThrow("probe-caller");
  }
  const modelLabeled = enforcedCaller();
  Object.assign(modelLabeled.measuredOn!, { labelSource: "model", principalLabels: 10000 });
  expect(() => assertJudgeRegistry([modelLabeled])).toThrow("probe-caller");
});

test("caller thresholds override defaults and invalid thresholds cannot bypass the gate", () => {
  const caller = { ...enforcedCaller(), minLabels: 21, enforceBar: 0.95 };
  expect(() => assertJudgeRegistry([caller])).toThrow("probe-caller");
  caller.measuredOn = { ...enforcedCaller().measuredOn!, principalLabels: 21, agreement: 0.95 };
  expect(() => assertJudgeRegistry([caller])).not.toThrow();
  expect(() => assertJudgeRegistry([{ ...caller, minLabels: 0 }])).toThrow("probe-caller");
  expect(() => assertJudgeRegistry([{ ...caller, enforceBar: NaN }])).toThrow("probe-caller");
});

test("right and wrong labels persist principal attribution and update agreement once per judgment", async () => {
  await fixture(async (home) => {
    await recordJudgment(home, judgment({ id: "first" }));
    await recordJudgment(home, judgment({ id: "second" }));
    const before = await readFile(judgeLedgerPath(home), "utf8");
    expect(await label(home, "first", "right")).toMatchObject({ judgmentId: "first", source: "principal", principal: "test-principal", verdict: "right" });
    let history = await readJudgmentLabels(home);
    const { records } = await readJudgments(home);
    expect(summarizeJudgments(records, {}, history.labels)[0]).toMatchObject({ labeled: 1, right: 1, wrong: 0, agreement: 1 });
    await label(home, "second", "wrong");
    history = await readJudgmentLabels(home);
    expect(summarizeJudgments(records, {}, history.labels)[0]).toMatchObject({ labeled: 2, right: 1, wrong: 1, agreement: 0.5 });
    await label(home, "second", "right");
    history = await readJudgmentLabels(home);
    expect(history.labels).toHaveLength(3);
    expect(summarizeJudgments(records, {}, history.labels)[0]).toMatchObject({ labeled: 2, right: 2, wrong: 0, agreement: 1 });
    expect(await readFile(judgeLedgerPath(home), "utf8")).toBe(before);
  });
});

test("unknown ids and absent principals refuse before creating any state", async () => {
  await fixture(async (home) => {
    await expect(label(home, "unknown", "right")).rejects.toThrow("Unknown judgment id");
    expect(await readdir(home)).toEqual([]);
    for (const principal of [undefined, "", "   "]) {
      await expect(labelJudgment({ somaHome: home, judgmentId: "unknown", verdict: "right", env: { SOMA_PRINCIPAL: principal } })).rejects.toThrow("SOMA_PRINCIPAL");
    }
    expect(await readdir(home)).toEqual([]);
    await recordJudgment(home, judgment({ id: "known" }));
    await label(home, "known", "right");
    const before = await readFile(judgeLabelsPath(home), "utf8");
    await expect(label(home, "unknown", "wrong")).rejects.toThrow("Unknown judgment id");
    await expect(label(home, "", "wrong")).rejects.toThrow("Unknown judgment id");
    expect(await readFile(judgeLabelsPath(home), "utf8")).toBe(before);
  });
});

test("identical legacy records have distinct stable ids across filters and later appends", async () => {
  await fixture(async (home) => {
    await mkdir(join(home, "memory", "STATE", "judgments"), { recursive: true });
    const line = JSON.stringify(judgment());
    await writeFile(judgeLedgerPath(home), `not json\n${line}\n${line}\n`);
    const { records } = await readJudgments(home);
    expect(records[0].id).not.toBe(records[1].id);
    await label(home, records[0].id, "right");
    await recordJudgment(home, judgment({ caller: "errata-triage" }));
    expect((await readJudgments(home, { caller: "mode-router" })).records).toEqual(records);
    expect(summarizeJudgments((await readJudgments(home)).records, {}, (await readJudgmentLabels(home)).labels)[1]).toMatchObject({ caller: "mode-router", labeled: 1 });
  });
});

test("legacy labels survive reordering unrelated rows and removing malformed rows", async () => {
  await fixture(async (home) => {
    await mkdir(join(home, "memory", "STATE", "judgments"), { recursive: true });
    const line = JSON.stringify(judgment());
    const other = JSON.stringify(judgment({ caller: "errata-triage" }));
    await writeFile(judgeLedgerPath(home), `not json\n${line}\n${other}\n${line}\n`);
    const before = (await readJudgments(home, { caller: "mode-router" })).records;
    await label(home, before[1].id, "right");
    await writeFile(judgeLedgerPath(home), `${line}\n${line}\n${other}\n`);
    const after = (await readJudgments(home, { caller: "mode-router" })).records;
    expect(after).toEqual(before);
    expect(summarizeJudgments(after, {}, (await readJudgmentLabels(home)).labels)[0]).toMatchObject({ labeled: 1, agreement: 1 });
    await label(home, after[0].id, "wrong");
    expect(summarizeJudgments(after, {}, (await readJudgmentLabels(home)).labels)[0]).toMatchObject({ labeled: 2, agreement: 0.5 });
  });
});

test("new records get unique ids even for identical judgments; ambiguous stored ids refuse", async () => {
  await fixture(async (home) => {
    await recordJudgment(home, judgment());
    await recordJudgment(home, judgment());
    const { records } = await readJudgments(home);
    expect(records[0].id).not.toBe(records[1].id);
    await recordJudgment(home, judgment({ id: "duplicate" }));
    await recordJudgment(home, judgment({ id: "duplicate" }));
    await expect(label(home, "duplicate", "right")).rejects.toThrow("Ambiguous judgment id");
    expect((await readJudgmentLabels(home)).labels).toEqual([]);
  });
});

test("label storage preserves the exact judgment id", async () => {
  await fixture(async (home) => {
    await recordJudgment(home, judgment({ id: " recorded-id " }));
    await label(home, " recorded-id ", "right");
    const { labels } = await readJudgmentLabels(home);
    expect(labels[0].judgmentId).toBe(" recorded-id ");
    expect(summarizeJudgments((await readJudgments(home)).records, {}, labels)[0]).toMatchObject({ labeled: 1, agreement: 1 });
  });
});

test("model labels and malformed labels never count; unmatched ids do not inflate stats", async () => {
  await fixture(async (home) => {
    await recordJudgment(home, judgment({ id: "known" }));
    const valid = await label(home, "known", "right");
    await writeFile(judgeLabelsPath(home), [
      { ...valid, source: "model", verdict: "wrong" }, { ...valid, principal: "" }, { ...valid, verdict: "maybe" },
      { ...valid, ts: "invalid" }, { ...valid, judgmentId: "unknown" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\nnot json\n", { flag: "a" });
    const history = await readJudgmentLabels(home);
    expect(history.malformed).toBe(5);
    expect(summarizeJudgments((await readJudgments(home)).records, {}, history.labels)[0]).toMatchObject({ labeled: 1, agreement: 1 });
    expect(await runSomaCli(["judge", "stats", "--soma-home", home])).toContain("malformed labels skipped: 5");
  });
});

test("stats labels follow caller and judgment-date filters", async () => {
  await fixture(async (home) => {
    await recordJudgment(home, judgment({ id: "old" }));
    await recordJudgment(home, judgment({ id: "new", ts: "2026-10-29T12:00:00.000Z" }));
    await recordJudgment(home, judgment({ id: "errata", caller: "errata-triage" }));
    await label(home, "old", "wrong");
    await label(home, "new", "right");
    const { records } = await readJudgments(home);
    const { labels } = await readJudgmentLabels(home);
    expect(summarizeJudgments(records, { caller: "mode-router", since: "2026-10-29" }, labels)).toMatchObject([{ total: 1, labeled: 1, agreement: 1 }]);
    expect(summarizeJudgments(records, { caller: "errata-triage" }, labels)).toMatchObject([{ labeled: 0, agreement: null }]);
  });
});

test("label storage failures propagate; unreadable label history is not empty stats", async () => {
  await fixture(async (home) => {
    await recordJudgment(home, judgment({ id: "known" }));
    await mkdir(judgeLabelsPath(home));
    await expect(label(home, "known", "right")).rejects.toThrow();
    await expect(runSomaCli(["judge", "stats", "--soma-home", home])).rejects.toThrow();
  });
});

test("label lookup propagates ledger read failures without writing labels", async () => {
  await fixture(async (home) => {
    await mkdir(judgeLedgerPath(home), { recursive: true });
    await expect(label(home, "known", "right")).rejects.toThrow();
    expect(await readdir(join(home, "memory", "STATE", "judgments"))).toEqual(["ledger.jsonl"]);
  });
});

test("label CLI requires one verdict and an id and rejects conflicting arguments", () => {
  for (const args of [[], ["known"], ["--right"], ["known", "--right", "--wrong"], ["known", "--right", "--right"],
    ["known", "--right", "--caller", "mode-router"], ["known", "--wrong", "--since", "2026-10-28"],
    ["known", "--right", "another-id"], ["known", "--right", "--home-dir"], ["known", "--wrong", "--soma-home"]]) {
    expect(() => parseJudgeArgs(["judge", "label", ...args])).toThrow();
  }
  expect(() => parseJudgeArgs(["judge", "stats", "--right"])).toThrow();
  expect(() => parseJudgeArgs(["judge", "registry", "--wrong"])).toThrow();
  expect(parseJudgeArgs(["judge", "label", "known", "--wrong", "--json", "--home-dir", "/home", "--soma-home", "/soma"])).toEqual({
    command: "judge", action: "label", judgmentId: "known", verdict: "wrong",
    options: { json: true, homeDir: "/home", somaHome: "/soma" },
  });
});

test("real CLI labels a classifier judgment and reports count and agreement", async () => {
  await fixture(async (home) => {
    await runSomaCli(["algorithm", "classify", "--prompt", "hello", "--record", "--soma-home", home]);
    const { records } = await readJudgments(home);
    const right = cli(home, ["label", records[0].id, "--right", "--json"]);
    expect(right.exitCode).toBe(0);
    expect(JSON.parse(right.stdout.toString())).toMatchObject({ source: "principal", principal: "test-principal", verdict: "right" });
    expect(cli(home, ["stats"]).stdout.toString()).toContain("1 labeled, 1 right, 0 wrong; agreement: 100%");
    const stats = JSON.parse(cli(home, ["stats", "--json"]).stdout.toString());
    expect(stats.callers[0]).toMatchObject({ caller: "mode-router", labeled: 1, agreement: 1 });
    expect(stats.judgments[0].id).toBe(records[0].id);
    expect(cli(home, ["label", records[0].id, "--wrong"]).exitCode).toBe(0);
    expect(cli(home, ["stats"]).stdout.toString()).toContain("1 labeled, 0 right, 1 wrong; agreement: 0%");
  });
});

test("CLI missing principal and unknown ids exit nonzero without writes", async () => {
  await fixture(async (home) => {
    await recordJudgment(home, judgment({ id: "known" }));
    const absent = cli(home, ["label", "known", "--right"], "");
    expect(absent.exitCode).not.toBe(0);
    expect(absent.stderr.toString()).toContain("SOMA_PRINCIPAL");
    const unknown = cli(home, ["label", "unknown", "--right"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr.toString()).toContain("Unknown judgment id");
    expect((await readJudgmentLabels(home)).labels).toEqual([]);
    expect(await readdir(join(home, "memory", "STATE", "judgments"))).toEqual(["ledger.jsonl"]);
  });
});
