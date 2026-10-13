import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupGateFixtures, REPO, runGate, WRAPPER } from "./harness-gate-fixture";

// The weekly harness gate wrapper (scripts/harness-gate-check.sh). #681: the
// package.json script it runs was renamed, every scheduled run exited 1 without
// measuring anything, and exit 1 is also what a real regression looks like.
// These tests pin the wrapper's script name to package.json and each outcome.

afterEach(cleanupGateFixtures);

describe("harness gate wrapper", () => {
  test("runs a package.json script that exists and points at harness-eval.ts", () => {
    const wrapper = readFileSync(WRAPPER, "utf8");
    const invoked = /^EVAL_SCRIPT="([^"]+)"$/m.exec(wrapper)?.[1];
    expect(invoked).toBeDefined();
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.scripts[invoked!]).toBe("bun scripts/harness-eval.ts");
  });

  test("a clean check exits 0 and logs ok", () => {
    const { code, log } = runGate(`console.log("\\nOK: no regressions vs baseline");`);
    expect(code).toBe(0);
    expect(log).toContain("RESULT ok");
  });

  test("a measured regression exits 1 and logs regressed", () => {
    const { code, log } = runGate(
      `console.error("\\nREGRESSION: 2 metric(s) degraded past tolerance vs baseline (x):"); process.exit(1);`,
    );
    expect(code).toBe(1);
    expect(log).toContain("RESULT regressed");
  });

  test("a missing script (#681) exits 2 and logs could-not-run, not regressed", () => {
    const { code, log } = runGate(null);
    expect(code).toBe(2);
    expect(log).toContain("RESULT could-not-run");
    expect(log).not.toContain("RESULT regressed");
  });

  test("a crash that exits 1 without a verdict is could-not-run", () => {
    const { code, log } = runGate(`throw new Error("boom");`);
    expect(code).toBe(2);
    expect(log).toContain("RESULT could-not-run");
  });

  test("an exit 0 without harness-eval's OK verdict is could-not-run, not ok", () => {
    const { code, log } = runGate(`console.log("measured nothing");`);
    expect(code).toBe(2);
    expect(log).toContain("RESULT could-not-run");
    expect(log).not.toContain("RESULT ok");
  });

  test("a baseline that differs from HEAD exits 3 and logs guard", () => {
    const { code, log } = runGate(`console.log("\\nOK: no regressions vs baseline");`, { dirtyBaseline: true });
    expect(code).toBe(3);
    expect(log).toContain("RESULT guard");
  });

  test("a git failure in the guard is could-not-run, not guard", () => {
    const { code, log } = runGate(`console.log("\\nOK: no regressions vs baseline");`, { repo: false });
    expect(code).toBe(2);
    expect(log).toContain("RESULT could-not-run");
    expect(log).not.toContain("RESULT guard");
  });

  test("harness-eval's own load failure (exit 2) is could-not-run", () => {
    const { code, log } = runGate(`console.error("cannot read baseline"); process.exit(2);`);
    expect(code).toBe(2);
    expect(log).toContain("RESULT could-not-run");
  });
});
