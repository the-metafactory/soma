import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The weekly harness gate wrapper (scripts/harness-gate-check.sh). #681: the
// package.json script it runs was renamed, every scheduled run exited 1 without
// measuring anything, and exit 1 is also what a real regression looks like.
// These tests pin the wrapper's script name to package.json and each outcome.

const REPO = join(import.meta.dir, "..");
const WRAPPER = join(REPO, "scripts", "harness-gate-check.sh");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
}

/**
 * A throwaway repo shaped like soma for the wrapper: its own copy of the
 * wrapper, a committed baseline, and a package.json whose `harness-eval` script
 * is a stub. `stub` null means no such script at all, the #681 state.
 * `dirtyBaseline` edits the committed baseline so the guard refuses.
 */
function runGate(stub: string | null, { dirtyBaseline = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "harness-gate-"));
  temps.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(WRAPPER, join(root, "scripts", "harness-gate-check.sh"));
  writeFileSync(join(root, "scripts", "harness-eval-baseline.json"), "{}\n");
  const scripts = stub === null ? {} : { "harness-eval": "bun stub.ts" };
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gate-fixture", scripts }));
  if (stub !== null) writeFileSync(join(root, "stub.ts"), stub);
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  if (dirtyBaseline) writeFileSync(join(root, "scripts", "harness-eval-baseline.json"), "{\"lowered\":true}\n");

  // HOME points into the fixture so the log lands there and no real ~/.bun/bin
  // shadows PATH. The wrapper puts $HOME/.bun/bin first, so a no-op osascript
  // there keeps the tests from posting real notifications.
  const home = join(root, "home");
  const shims = join(home, ".bun", "bin");
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, "osascript"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const proc = Bun.spawnSync(["bash", join(root, "scripts", "harness-gate-check.sh")], {
    cwd: root,
    env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = readFileSync(join(home, "Library", "Logs", "soma", "harness-gate.log"), "utf8");
  return { code: proc.exitCode, log };
}

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

  test("harness-eval's own load failure (exit 2) is could-not-run", () => {
    const { code, log } = runGate(`console.error("cannot read baseline"); process.exit(2);`);
    expect(code).toBe(2);
    expect(log).toContain("RESULT could-not-run");
  });
});
