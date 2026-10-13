import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { publishRunFinished, runLedgerSpoolPath } from "../src/run-ledger";
// The side-effect-free list, never the preload itself: importing the preload
// would clear the env on its own and make the control below vacuous.
import { RUN_LEDGER_ENV, RUN_LEDGER_ENV_VARS } from "../src/run-ledger-env";

const PROBE = "the test env carries no run-ledger bus variables";
const repoRoot = join(import.meta.dir, "..");

test(PROBE, async () => {
  for (const name of RUN_LEDGER_ENV_VARS) expect(process.env[name]).toBeUndefined();

  // The default path: no env and no publisher injected, so the funnel reads
  // process.env and would use the real outbox over NATS.
  const dir = await mkdtemp(join(tmpdir(), "soma-run-ledger-env-"));
  try {
    const somaHome = join(dir, ".soma");
    const result = await publishRunFinished(
      {
        kind: "algorithm",
        ref: "env-probe",
        runId: "env-probe",
        outcome: "succeeded",
        startedAt: "2026-05-14T10:00:00.000Z",
        endedAt: "2026-05-14T10:13:00.000Z",
      },
      { somaHome, substrate: "codex" },
    );
    expect(result).toBe("disabled");
    expect(await stat(runLedgerSpoolPath(somaHome)).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Run only the probe above in a child `bun test` whose shell exports the bus env. */
async function probeWithShellBusEnv(extraArgs: string[]): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(["bun", ...extraArgs, "test", "test/run-ledger-test-env.test.ts", "-t", PROBE], {
    cwd: repoRoot,
    // Every listed variable, so a name added to the list is covered here too.
    env: {
      ...process.env,
      ...Object.fromEntries(RUN_LEDGER_ENV_VARS.map((name) => [name, "from-shell"])),
      [RUN_LEDGER_ENV.principal]: "jc",
      [RUN_LEDGER_ENV.natsUrl]: "nats://127.0.0.1:1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

test("a shell that exports the bus env still runs tests with it cleared", async () => {
  const { exitCode, output } = await probeWithShellBusEnv([]);
  expect(output).toContain("1 pass");
  expect(exitCode).toBe(0);
});

test("without the preload the shell's bus env would reach the tests", async () => {
  // Control: an empty bunfig drops the preload, and the same probe fails.
  const dir = await mkdtemp(join(tmpdir(), "soma-run-ledger-bunfig-"));
  try {
    const emptyConfig = join(dir, "bunfig.toml");
    await writeFile(emptyConfig, "", "utf8");
    const { exitCode, output } = await probeWithShellBusEnv([`--config=${emptyConfig}`]);
    expect(output).toContain("1 fail");
    expect(exitCode).not.toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
