import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import {
  JUDGE_REGISTRY,
  hashJudgmentInput,
  judgeLedgerPath,
  readJudgments,
  recordJudgment,
  regexClassifierVersion,
  summarizeJudgments,
  type JudgmentRecord,
} from "../src/judge";

async function withTempSomaHome(action: (somaHome: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "soma-judge-"));
  try {
    await action(join(root, ".soma"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function record(overrides: Partial<JudgmentRecord> = {}): JudgmentRecord {
  return {
    v: 1,
    ts: "2026-09-28T10:00:00.000Z",
    caller: "mode-router",
    inputSha256: hashJudgmentInput("x"),
    backend: "regex",
    backendVersion: regexClassifierVersion(),
    decision: { mode: "native" },
    latencyMs: 1,
    ...overrides,
  };
}

test("the router starts in shadow with no measurement", () => {
  expect(JUDGE_REGISTRY.find((caller) => caller.id === "mode-router")).toMatchObject({ state: "shadow", measuredOn: null });
});

test("recorded judgments read back and summarize per caller, decision and day", async () => {
  await withTempSomaHome(async (somaHome) => {
    expect(await recordJudgment(somaHome, record())).toBe(true);
    expect(await recordJudgment(somaHome, record({ decision: { mode: "algorithm", effort: "E2" }, latencyMs: 3 }))).toBe(true);
    expect(await recordJudgment(somaHome, record({ ts: "2026-09-29T08:00:00.000Z", latencyMs: 2 }))).toBe(true);
    await writeFile(judgeLedgerPath(somaHome), "not json\n", { flag: "a" });

    const { records, malformed } = await readJudgments(somaHome);
    expect(records).toHaveLength(3);
    expect(malformed).toBe(1);

    const [stats] = summarizeJudgments(records);
    expect(stats).toMatchObject({
      caller: "mode-router",
      state: "shadow",
      total: 3,
      decisions: { mode: { native: 2, algorithm: 1 }, effort: { E2: 1 } },
      days: { "2026-09-28": 2, "2026-09-29": 1 },
      medianLatencyMs: 2,
    });
    expect(summarizeJudgments(records, { since: "2026-09-29" })[0].total).toBe(1);
  });
});

test("a ledger that cannot be written reports false instead of throwing", async () => {
  await withTempSomaHome(async (somaHome) => {
    // A file where the Soma home should be makes every mkdir below it fail.
    await writeFile(join(somaHome, "..", ".soma"), "not a directory");
    expect(await recordJudgment(somaHome, record())).toBe(false);
  });
});

test("classify --record writes one hashed ledger line and leaves the output unchanged", async () => {
  await withTempSomaHome(async (somaHome) => {
    const prompt = "summarize the penguin census";
    const plain = await runSomaCli(["algorithm", "classify", "--prompt", prompt, "--json"]);
    const recorded = await runSomaCli([
      "algorithm", "classify", "--prompt", prompt, "--json",
      "--record", "--session", "sess-1", "--substrate", "claude-code", "--soma-home", somaHome,
    ]);
    expect(recorded).toBe(plain);

    const raw = await readFile(judgeLedgerPath(somaHome), "utf8");
    expect(raw).not.toContain("penguin");
    const { records } = await readJudgments(somaHome);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      caller: "mode-router",
      substrate: "claude-code",
      session: "sess-1",
      inputSha256: hashJudgmentInput(prompt),
      backend: "regex",
      backendVersion: regexClassifierVersion(),
      decision: { mode: JSON.parse(plain).mode },
    });
  });
});

test("classify without --record writes no ledger", async () => {
  await withTempSomaHome(async (somaHome) => {
    await runSomaCli(["algorithm", "classify", "--prompt", "hello there", "--json", "--soma-home", somaHome]);
    expect((await readJudgments(somaHome)).records).toHaveLength(0);
  });
});

test("classify --record still classifies when the ledger cannot be written", async () => {
  await withTempSomaHome(async (somaHome) => {
    await writeFile(join(somaHome, "..", ".soma"), "not a directory");
    const plain = await runSomaCli(["algorithm", "classify", "--prompt", "run the tests", "--json"]);
    const recorded = await runSomaCli(["algorithm", "classify", "--prompt", "run the tests", "--json", "--record", "--soma-home", somaHome]);
    expect(recorded).toBe(plain);
  });
});

test("judge stats reports decision shares; judge registry lists callers", async () => {
  await withTempSomaHome(async (somaHome) => {
    await recordJudgment(somaHome, record());
    await recordJudgment(somaHome, record({ decision: { mode: "algorithm", effort: "E1" } }));

    const stats = await runSomaCli(["judge", "stats", "--soma-home", somaHome]);
    expect(stats).toContain("mode-router (shadow): 2 judgment(s)");
    expect(stats).toContain("mode: native 1 (50%), algorithm 1 (50%)");

    const json = JSON.parse(await runSomaCli(["judge", "stats", "--soma-home", somaHome, "--json"])) as { callers: { total: number }[] };
    expect(json.callers[0].total).toBe(2);

    expect(await runSomaCli(["judge", "registry"])).toContain("mode-router: shadow, not measured");
    expect(await runSomaCli(["judge", "stats", "--soma-home", join(somaHome, "empty")])).toContain("No judgments recorded.");
  });
});
