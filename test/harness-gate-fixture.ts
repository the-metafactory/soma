import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The fixture for the weekly harness gate wrapper (scripts/harness-gate-check.sh),
// shared by test/harness-gate-check.test.ts (its outcomes) and
// test/harness-gate-ledger.test.ts (its run-ledger report, node #821).

export const REPO = join(import.meta.dir, "..");
export const WRAPPER = join(REPO, "scripts", "harness-gate-check.sh");

const temps: string[] = [];

/** Call from `afterEach`: removes every fixture `runGate` made. */
export function cleanupGateFixtures(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
}

export interface GateOptions {
  /** Edit the committed baseline so the guard refuses. */
  dirtyBaseline?: boolean;
  /** False skips `git init`, so the guard's git calls fail. */
  repo?: boolean;
  /** Executables placed in `$HOME/.local/bin`, which the wrapper puts first on its PATH. */
  shims?: Record<string, string>;
}

export interface GateRun {
  code: number | null;
  log: string;
  logFile: string;
  home: string;
}

/**
 * A throwaway repo shaped like soma for the wrapper: its own copy of the
 * wrapper, a committed baseline, and a package.json whose `harness-eval` script
 * is a stub. `stub` null means no such script at all, the #681 state.
 */
export function runGate(stub: string | null, { dirtyBaseline = false, repo = true, shims = {} }: GateOptions = {}): GateRun {
  const root = mkdtempSync(join(tmpdir(), "harness-gate-"));
  temps.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(WRAPPER, join(root, "scripts", "harness-gate-check.sh"));
  writeFileSync(join(root, "scripts", "harness-eval-baseline.json"), "{}\n");
  const scripts = stub === null ? {} : { "harness-eval": "bun stub.ts" };
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gate-fixture", scripts }));
  if (stub !== null) writeFileSync(join(root, "stub.ts"), stub);
  if (repo) {
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "fixture");
  }
  if (dirtyBaseline) writeFileSync(join(root, "scripts", "harness-eval-baseline.json"), "{\"lowered\":true}\n");

  // HOME points into the fixture so the log lands there and no real
  // ~/.local/bin or ~/.bun/bin shadows PATH. Only bun itself is linked onto
  // PATH, not its whole directory, so without a shim there is no `soma`.
  const home = join(root, "home");
  const shimDir = join(home, ".local", "bin");
  mkdirSync(shimDir, { recursive: true });
  for (const [name, body] of Object.entries(shims)) writeFileSync(join(shimDir, name), body, { mode: 0o755 });
  const bunDir = join(root, "bun-bin");
  mkdirSync(bunDir);
  symlinkSync(process.execPath, join(bunDir, "bun"));
  const proc = Bun.spawnSync(["bash", join(root, "scripts", "harness-gate-check.sh")], {
    cwd: root,
    // The ceiling stops git from finding an enclosing repo above the fixture.
    env: { HOME: home, PATH: `${bunDir}:/usr/bin:/bin`, GIT_CEILING_DIRECTORIES: dirname(root) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const logFile = join(home, "Library", "Logs", "soma", "harness-gate.log");
  return { code: proc.exitCode, log: readFileSync(logFile, "utf8"), logFile, home };
}
