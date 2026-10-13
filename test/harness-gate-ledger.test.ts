import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupGateFixtures, runGate, WRAPPER, type GateOptions } from "./harness-gate-fixture";

// Node #821: every run of the weekly harness gate reports itself to Vigil as one
// `job` run through `soma run finished`, and no run raises a macOS banner. A
// `soma` shim in $HOME/.local/bin records each call's argv, one argument per
// line, a sentinel line after each call.

afterEach(cleanupGateFixtures);

const END = "<<end>>";
const OK = `console.log("\\nOK: no regressions vs baseline");`;
const REGRESSION = `console.error("\\nREGRESSION: 2 metric(s) degraded past tolerance vs baseline (x):"); process.exit(1);`;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function recorder(name: string, exitCode = 0): string {
  return `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done >>"$HOME/${name}.argv"\nprintf '%s\\n' '${END}' >>"$HOME/${name}.argv"\nexit ${exitCode}\n`;
}

/** Fails `git diff` and passes every other git call to the real git. */
function failingDiffGit(): string {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git is not on PATH");
  return `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = diff ] && exit 128; done\nexec ${realGit} "$@"\n`;
}

interface Call {
  argv: string[];
  flags: Record<string, string>;
}

function calls(home: string, name = "soma"): Call[] {
  const file = join(home, `${name}.argv`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").slice(0, -1);
  const result: Call[] = [];
  let argv: string[] = [];
  for (const line of lines) {
    if (line !== END) {
      argv.push(line);
      continue;
    }
    const flags: Record<string, string> = {};
    for (let index = 2; index < argv.length; index += 2) flags[argv[index]] = argv[index + 1];
    result.push({ argv, flags });
    argv = [];
  }
  return result;
}

function gate(stub: string | null, options: GateOptions = {}) {
  const run = runGate(stub, { ...options, shims: { soma: recorder("soma"), osascript: recorder("osascript"), ...options.shims } });
  return { ...run, calls: calls(run.home) };
}

/** The one `soma run finished` call a gate run made. Every path is also checked for an osascript call. */
function onlyCall(result: ReturnType<typeof gate>): Call {
  expect(calls(result.home, "osascript")).toEqual([]);
  expect(result.calls).toHaveLength(1);
  const [call] = result.calls;
  expect(call.argv.slice(0, 2)).toEqual(["run", "finished"]);
  return call;
}

describe("harness gate run ledger", () => {
  test("a clean check reports one succeeded job with state ok and exits 0", () => {
    const result = gate(OK);
    const call = onlyCall(result);
    expect(call.flags).toEqual({
      "--kind": "job",
      "--ref": "soma:harness-gate",
      "--outcome": "succeeded",
      "--state-subject": "soma:harness",
      "--state-value": "ok",
      "--started-at": call.flags["--started-at"],
      "--detail-ref": result.logFile,
    });
    expect(call.flags["--started-at"]).toMatch(ISO_UTC);
    expect(result.log).toContain("RESULT ok");
    expect(result.log).not.toContain("EMIT failed");
    expect(result.code).toBe(0);
  });

  test("a measured regression reports succeeded with state regressed and exits 1", () => {
    const result = gate(REGRESSION);
    const call = onlyCall(result);
    expect(call.flags["--outcome"]).toBe("succeeded");
    expect(call.flags["--state-subject"]).toBe("soma:harness");
    expect(call.flags["--state-value"]).toBe("regressed");
    expect(result.code).toBe(1);
  });

  const couldNotRun: [string, string | null, GateOptions][] = [
    ["a missing script", null, {}],
    ["a crash", `throw new Error("boom");`, {}],
    ["exit 0 without the OK verdict", `console.log("measured nothing");`, {}],
    ["harness-eval's own exit 2", `console.error("cannot read baseline"); process.exit(2);`, {}],
    ["an unresolvable HEAD", OK, { repo: false }],
    ["a failing git diff", OK, { shims: { git: failingDiffGit() } }],
  ];
  for (const [name, stub, options] of couldNotRun) {
    test(`${name} reports failed with no state flags and exits 2`, () => {
      const result = gate(stub, options);
      const call = onlyCall(result);
      expect(call.flags["--outcome"]).toBe("failed");
      expect(call.flags["--kind"]).toBe("job");
      expect(call.flags["--ref"]).toBe("soma:harness-gate");
      expect(call.flags["--started-at"]).toMatch(ISO_UTC);
      expect(call.flags["--detail-ref"]).toBe(result.logFile);
      expect(call.flags).not.toHaveProperty("--state-subject");
      expect(call.flags).not.toHaveProperty("--state-value");
      expect(result.log).toContain("RESULT could-not-run");
      expect(result.code).toBe(2);
    });
  }

  test("a baseline that differs from HEAD reports blocked with no state flags and exits 3", () => {
    const result = gate(OK, { dirtyBaseline: true });
    const call = onlyCall(result);
    expect(call.flags["--outcome"]).toBe("blocked");
    expect(call.flags).not.toHaveProperty("--state-subject");
    expect(call.flags).not.toHaveProperty("--state-value");
    expect(result.log).toContain("RESULT guard");
    expect(result.code).toBe(3);
  });

  const emitFailures: [string, Record<string, string>][] = [
    ["soma is not on PATH", {}],
    ["soma exits nonzero", { soma: recorder("soma", 1) }],
  ];
  for (const [name, shims] of emitFailures) {
    for (const [stub, result, code] of [[OK, "ok", 0], [REGRESSION, "regressed", 1], [null, "could-not-run", 2]] as const) {
      test(`when ${name}, a ${result} run keeps its RESULT and exit code and logs one EMIT failed`, () => {
        const run = runGate(stub, { shims });
        expect(run.log).toContain(`RESULT ${result}`);
        expect(run.log.match(/EMIT failed/g)).toHaveLength(1);
        expect(run.code).toBe(code);
      });
    }
  }

  // Each outcome test above runs with a recording osascript shim; this covers
  // the paths no fixture reaches (the `cd` failure).
  test("the wrapper names no osascript call", () => {
    expect(readFileSync(WRAPPER, "utf8")).not.toContain("osascript");
  });
});
