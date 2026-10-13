import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createEnvelope,
  RUN_KINDS as MYELIN_RUN_KINDS,
  RUN_OUTCOMES as MYELIN_RUN_OUTCOMES,
  validateExecutionRunFinished,
  type ExecutionRunFinishedEvent,
} from "@the-metafactory/myelin";
import { runSomaCli } from "../src/cli";
import { runRunCli, type RunCliDeps } from "../src/cli/run";
import { RUN_KINDS, RUN_LEDGER_SOVEREIGNTY, RUN_OUTCOMES, runLedgerSpoolPath, type RunLedgerEnv } from "../src/run-ledger";

// `soma run finished` (node #821): the general verb a scheduled job calls to
// report one finished run through the run ledger. A reporting failure never
// fails the job that called it, so every path returns rather than throws.

const STARTED_AT = "2026-10-12T07:00:00Z";
const NOW = new Date("2026-10-12T07:00:42.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempSomaHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "soma-run-cli-"));
  homes.push(dir);
  return join(dir, ".soma");
}

interface Harness {
  events: ExecutionRunFinishedEvent[];
  stderr: string[];
  deps: RunCliDeps;
}

async function harness(env: RunLedgerEnv = { SOMA_PRINCIPAL: "jc" }): Promise<Harness> {
  const events: ExecutionRunFinishedEvent[] = [];
  const stderr: string[] = [];
  return {
    events,
    stderr,
    deps: {
      env,
      somaHome: await tempSomaHome(),
      now: () => NOW,
      stderr: (line) => stderr.push(line),
      publishRunFinished: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
  };
}

const REQUIRED = ["--kind", "job", "--ref", "soma:harness-gate", "--outcome", "succeeded", "--started-at", STARTED_AT];
const STATE = ["--state-subject", "soma:harness", "--state-value", "ok"];
const DETAIL = ["--detail-ref", "/var/log/harness-gate.log"];

describe("soma run finished", () => {
  test("valid flags publish exactly one envelope with those fields and return", async () => {
    const { events, stderr, deps } = await harness();

    const output = await runRunCli(["finished", ...REQUIRED, ...STATE, ...DETAIL], deps);

    expect(output).toBe("run finished: published");
    expect(stderr).toEqual([]);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.subject).toBe("local.jc.default.execution.run.finished");
    expect(event.input.payload).toMatchObject({
      producer: "soma",
      ran: { kind: "job", ref: "soma:harness-gate" },
      outcome: "succeeded",
      started_at: STARTED_AT,
      ended_at: NOW.toISOString(),
      state: { subject: "soma:harness", value: "ok" },
      detail_ref: "/var/log/harness-gate.log",
    });
    expect(event.input.payload.run_id).toMatch(UUID);
    const envelope = createEnvelope({ ...event.input, sovereignty: { ...RUN_LEDGER_SOVEREIGNTY, ...event.input.sovereignty } });
    expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
  });

  test("each call is its own run: a fresh run_id per call", async () => {
    const { events, deps } = await harness();
    await runRunCli(["finished", ...REQUIRED], deps);
    await runRunCli(["finished", ...REQUIRED], deps);
    expect(events).toHaveLength(2);
    expect(events[0].input.payload.run_id).not.toBe(events[1].input.payload.run_id);
  });

  test("without --detail-ref or state flags the payload has neither and is still published", async () => {
    const { events, deps } = await harness();

    expect(await runRunCli(["finished", ...REQUIRED], deps)).toBe("run finished: published");

    expect(events).toHaveLength(1);
    expect(events[0].input.payload).not.toHaveProperty("detail_ref");
    expect(events[0].input.payload).not.toHaveProperty("state");
  });

  test("accepts every myelin run kind and outcome", async () => {
    const { events, deps } = await harness();
    for (const kind of RUN_KINDS) {
      for (const outcome of RUN_OUTCOMES) {
        await runRunCli(["finished", "--kind", kind, "--ref", "r", "--outcome", outcome, "--started-at", STARTED_AT], deps);
      }
    }
    expect(events).toHaveLength(RUN_KINDS.length * RUN_OUTCOMES.length);
  });

  const without = (flag: string): string[] => {
    const index = REQUIRED.indexOf(flag);
    return [...REQUIRED.slice(0, index), ...REQUIRED.slice(index + 2)];
  };
  const replace = (flag: string, value: string): string[] => REQUIRED.map((arg, index) => (REQUIRED[index - 1] === flag ? value : arg));

  const invalid: [string, string[], string][] = [
    ["an unknown --kind", replace("--kind", "cron"), "--kind"],
    ["an unknown --outcome", replace("--outcome", "regressed"), "--outcome"],
    ["a missing --kind", without("--kind"), "--kind"],
    ["a missing --ref", without("--ref"), "--ref"],
    ["a missing --outcome", without("--outcome"), "--outcome"],
    ["a missing --started-at", without("--started-at"), "--started-at"],
    ["an empty --ref", replace("--ref", ""), "--ref"],
    ["an empty --detail-ref", [...REQUIRED, "--detail-ref", ""], "--detail-ref"],
    ["a --detail-ref with no value", [...REQUIRED, "--detail-ref"], "--detail-ref"],
    ["a --started-at that is not ISO 8601", replace("--started-at", "last monday"), "--started-at"],
    ["a --started-at with a basic-format offset", replace("--started-at", "2026-10-12T09:00:00+0200"), "--started-at"],
    ["a --started-at that is no real date", replace("--started-at", "2026-02-30T09:00:00Z"), "--started-at"],
    ["only --state-subject", [...REQUIRED, "--state-subject", "soma:harness"], "--state-value"],
    ["only --state-value", [...REQUIRED, "--state-value", "ok"], "--state-subject"],
    ["an unknown flag", [...REQUIRED, "--summary", "x"], "--summary"],
  ];
  for (const [name, args, flag] of invalid) {
    test(`${name} publishes nothing, writes one stderr line naming ${flag}, and returns`, async () => {
      const { events, stderr, deps } = await harness();

      const output = await runRunCli(["finished", ...args], deps);

      expect(output).toBe("run finished: rejected");
      expect(events).toEqual([]);
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toContain(flag);
      expect(stderr[0]).not.toContain("\n");
    });
  }

  test("with SOMA_PRINCIPAL unset it publishes nothing, touches no spool, and returns", async () => {
    const { events, stderr, deps } = await harness({});

    expect(await runRunCli(["finished", ...REQUIRED, ...STATE, ...DETAIL], deps)).toBe("run finished: disabled");

    expect(events).toEqual([]);
    expect(stderr).toEqual([]);
    await expect(stat(runLedgerSpoolPath(deps.somaHome!))).rejects.toThrow();
  });

  test("a publisher that fails is reported as failed, not thrown", async () => {
    const { deps } = await harness();
    deps.publishRunFinished = () => Promise.reject(new Error("bus down"));

    expect(await runRunCli(["finished", ...REQUIRED], deps)).toBe("run finished: failed");
  });

  test("an unknown subcommand is a usage error", async () => {
    const { deps } = await harness();
    await expect(runRunCli(["started", ...REQUIRED], deps)).rejects.toThrow("Usage: soma run finished");
  });

  test("soma run finished is wired into the soma CLI", async () => {
    // The test preload clears SOMA_PRINCIPAL, so the real funnel is off.
    expect(await runSomaCli(["run", "finished", ...REQUIRED])).toBe("run finished: disabled");
    expect(await runSomaCli(["run", "finished", "--help"])).toContain("soma run finished --kind <flow|node|algorithm|dispatch|job>");
  });

  test("the verb's kinds and outcomes are myelin's", () => {
    expect([...RUN_KINDS].sort()).toEqual([...MYELIN_RUN_KINDS].sort());
    expect([...RUN_OUTCOMES].sort()).toEqual([...MYELIN_RUN_OUTCOMES].sort());
  });
});
