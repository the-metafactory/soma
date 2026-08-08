/**
 * Probe runner for the work graph (`docs/work-graph.md` §2.2, #498).
 *
 * A {@link Probe} is a machine-checkable expectation *declared up front*; this
 * module is what flips it from `specified` to `probed`. That split is the whole
 * point — the algorithm-runner P1 lesson is that self-declared verification is
 * hollow, so evidence is typed by whether it was specified first and then
 * actually run, never by what a session says about it afterwards.
 *
 * Three rules the spec puts on the runner specifically:
 *
 * - **Timeout expiry is probe failure**, never a hang and never a pass — a
 *   hanging command must not block the close path.
 * - **A runner error is a failure, not an exception.** A probe that could not be
 *   executed (network refused, git missing, bad path) records `outcome: "fail"`
 *   with the reason in `observed`, so {@link assertClosable} refuses the close.
 *   Fail-closed: the one thing a runner may never do is let an unrun probe look
 *   like a passed one.
 * - **A probe the registry refuses is a failure too** (DD-16 Amendment A,
 *   #526) — same shape, same path, deliberately not a new outcome: "the
 *   adopter never authorised this command" and "this command failed" are both
 *   simply *not passed*, and the close gate already knows what to do with that.
 *
 * I/O sits behind {@link ProbeRunnerDeps} so the whole runner is testable
 * without a shell, a network, or a git tree.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { authorizeProbe, type ProbeRegistry } from "./work-graph-probe-registry";
import type { Probe, ProbeResult } from "./work-graph";

/** How much of a command's output survives into the receipt (§2.2: a *bounded* tail). */
const OBSERVED_TAIL_LIMIT = 1_200;

/** Git probes carry no `timeoutSec` of their own; local plumbing that outruns this is broken, not slow. */
const GIT_TIMEOUT_SEC = 60;

/** Nor do `url` probes (§2.2 fixes their shape), and an unbounded fetch would hang the close. */
const URL_TIMEOUT_SEC = 30;

export interface CommandOutcome {
  /** Null when the process was killed before reporting a code (timeout, signal). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandRequest {
  /** Argv form — used for git plumbing, where a shell would let a ref name inject. */
  argv?: readonly string[];
  /** Shell form — the `command` probe's `run` string, as declared. */
  shell?: string;
  cwd?: string;
  timeoutSec: number;
  /**
   * Full replacement environment. Absent means inherit. The confinement check
   * (§3.2 conjunct 2) needs to run `gh` with `GH_TOKEN` *removed*, which is a
   * different thing from setting it empty — hence a whole map, not an overlay.
   */
  env?: Readonly<Record<string, string>>;
}

export interface ProbeRunnerDeps {
  runCommand: (request: CommandRequest) => Promise<CommandOutcome>;
  fetchStatus: (target: string) => Promise<number>;
  pathExists: (path: string) => boolean;
  now: () => Date;
}

export interface ProbeRunnerOptions {
  /**
   * Working directory for probes that do not name one, and the base every
   * probe-relative `cwd`/`repo` resolves against.
   *
   * **Required, and deliberately so** (#580). It used to fall through to
   * `process.cwd()`, which made the tree a probe ran in a property of however
   * the binary happened to be launched — under a launcher that `cd`s, an
   * entirely different checkout than the one being closed (#579). A caller now
   * has to state the tree it means, so a wrong one is a value someone passed
   * rather than a value nobody chose.
   */
  cwd: string;
  /**
   * The adopter's probe registry for the repo this graph lives in (§2.2, DD-16
   * Amendment A). **Absent means refuse**: every `command` and `url` probe fails
   * closed, which is the spec's rule for a machine carrying no declaration.
   * Deliberately not defaulted to a permissive value — a gate you can forget to
   * pass is not a gate.
   */
  registry?: ProbeRegistry;
  deps?: Partial<ProbeRunnerDeps>;
}

/** Keep the tail — the end of a failing command's output is where the reason is. */
export function boundObserved(text: string, limit = OBSERVED_TAIL_LIMIT): string {
  const collapsed = text.replace(/\s+$/u, "");
  if (collapsed.length <= limit) return collapsed;
  return `…${collapsed.slice(collapsed.length - limit)}`;
}

/**
 * The default command seam, exported because the verb layer needs the same one
 * for `gh` lookups and the confinement check — one place that knows how a
 * subprocess is spawned, timed out, and captured.
 */
export function runCommand(request: CommandRequest): Promise<CommandOutcome> {
  const argv =
    request.argv !== undefined
      ? [...request.argv]
      : process.platform === "win32"
        ? ["cmd", "/c", request.shell ?? ""]
        : ["/bin/sh", "-c", request.shell ?? ""];

  return runSpawned(argv, request);
}

async function runSpawned(argv: string[], request: CommandRequest): Promise<CommandOutcome> {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
  });

  // A holder rather than a bare `let`: the flag is written from the timer
  // callback, which control-flow analysis cannot see.
  const timeout: { fired: boolean } = { fired: false };
  const timer = setTimeout(() => {
    timeout.fired = true;
    proc.kill("SIGKILL");
  }, request.timeoutSec * 1_000);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      exitCode: timeout.fired ? null : exitCode,
      stdout,
      stderr,
      timedOut: timeout.fired,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `url` probes carry no `timeoutSec` of their own — §2.2 fixes the shape as
 * `{ target, expectStatus }` — so the bound lives here. Without it "timeout
 * expiry is failure, never a hang" would simply be false for this variant: a
 * server that accepts the connection and never answers would block the close
 * indefinitely. An aborted fetch throws, and {@link runProbe} turns a throw into
 * a failed probe, so the fail-closed path is the one already in place.
 */
async function defaultFetchStatus(target: string): Promise<number> {
  const response = await fetch(target, {
    redirect: "manual",
    signal: AbortSignal.timeout(URL_TIMEOUT_SEC * 1_000),
  });
  return response.status;
}

function resolveDeps(options: ProbeRunnerOptions): ProbeRunnerDeps {
  return {
    runCommand: options.deps?.runCommand ?? runCommand,
    fetchStatus: options.deps?.fetchStatus ?? defaultFetchStatus,
    pathExists: options.deps?.pathExists ?? existsSync,
    now: options.deps?.now ?? ((): Date => new Date()),
  };
}

function probed(probe: Probe, outcome: "pass" | "fail", observed: string, at: string): ProbeResult {
  return { probe, state: "probed", outcome, observed, at };
}

/** Command outcome → the `observed` string §2.2 asks for: exit code plus a bounded output tail. */
function describeCommand(outcome: CommandOutcome, timeoutSec: number): string {
  if (outcome.timedOut) {
    return `timed out after ${timeoutSec}s (killed)`;
  }
  const tail = boundObserved([outcome.stdout, outcome.stderr].filter((part) => part.trim().length > 0).join("\n"));
  return tail.length === 0 ? `exit ${outcome.exitCode}` : `exit ${outcome.exitCode}: ${tail}`;
}

async function runGit(
  deps: ProbeRunnerDeps,
  cwd: string,
  args: readonly string[],
): Promise<CommandOutcome> {
  return await deps.runCommand({ argv: ["git", "-C", cwd, ...args], timeoutSec: GIT_TIMEOUT_SEC });
}

/**
 * `repo` on the git/artifact probes is a **local working tree path**, defaulting
 * to the runner's cwd — the reading `artifact-exists`'s `path` + `atRef` pair
 * forces (`git cat-file -e <atRef>:<path>` needs a checkout, not an API).
 */
function probeCwd(probeRepo: string | undefined, fallbackCwd: string): string {
  return probeRepo === undefined ? fallbackCwd : resolve(fallbackCwd, probeRepo);
}

/**
 * Run one probe. Always resolves to a `probed` result — pass or fail — because a
 * probe that throws is a probe that did not pass, and the close gate needs that
 * as data, not as an exception to interpret.
 */
export async function runProbe(probe: Probe, options: ProbeRunnerOptions): Promise<ProbeResult> {
  const deps = resolveDeps(options);
  const baseCwd = resolve(options.cwd);
  const at = deps.now().toISOString();

  try {
    // One directory, computed once, used by both the gate and the spawn. The
    // registry's exact-match guarantee is only worth anything while "the cwd we
    // authorised" and "the cwd we executed in" are the same value — two
    // equivalent expressions would hold today and drift silently tomorrow.
    const resolvedCwd = probe.type === "command" ? probeCwd(probe.cwd, baseCwd) : baseCwd;

    // The gate runs before dispatch, not inside the two gated cases, so a probe
    // type added later cannot slip past by forgetting to call it.
    const authorization = authorizeProbe(probe, resolvedCwd, options.registry);
    if (!authorization.allowed) {
      return probed(probe, "fail", authorization.reason, at);
    }

    switch (probe.type) {
      case "command": {
        const outcome = await deps.runCommand({
          shell: probe.run,
          cwd: resolvedCwd,
          timeoutSec: probe.timeoutSec,
        });
        const passed = !outcome.timedOut && outcome.exitCode === probe.expectExit;
        const observed = describeCommand(outcome, probe.timeoutSec);
        return probed(probe, passed ? "pass" : "fail", passed ? observed : `${observed} (expected exit ${probe.expectExit})`, at);
      }

      case "url": {
        const status = await deps.fetchStatus(probe.target);
        const passed = status === probe.expectStatus;
        return probed(probe, passed ? "pass" : "fail", `status ${status}${passed ? "" : ` (expected ${probe.expectStatus})`}`, at);
      }

      case "git-ref-exists": {
        const cwd = probeCwd(probe.repo, baseCwd);
        const outcome = await runGit(deps, cwd, ["rev-parse", "--verify", "--quiet", `${probe.ref}^{commit}`]);
        const sha = outcome.stdout.trim();
        const passed = outcome.exitCode === 0 && sha.length > 0;
        return probed(probe, passed ? "pass" : "fail", passed ? `${probe.ref} → ${sha}` : `${probe.ref} does not resolve in ${cwd}`, at);
      }

      case "git-merged-into": {
        const cwd = probeCwd(probe.repo, baseCwd);
        const resolved = await runGit(deps, cwd, ["rev-parse", "--verify", "--quiet", `${probe.ref}^{commit}`]);
        const sha = resolved.stdout.trim();
        if (resolved.exitCode !== 0 || sha.length === 0) {
          return probed(probe, "fail", `${probe.ref} does not resolve in ${cwd}`, at);
        }
        const ancestor = await runGit(deps, cwd, ["merge-base", "--is-ancestor", probe.ref, probe.into]);
        const passed = ancestor.exitCode === 0;
        return probed(
          probe,
          passed ? "pass" : "fail",
          `${probe.ref} (${sha}) ${passed ? "is" : "is not"} an ancestor of ${probe.into}`,
          at,
        );
      }

      case "artifact-exists": {
        const cwd = probeCwd(probe.repo, baseCwd);
        if (probe.atRef === undefined) {
          const full = resolve(cwd, probe.path);
          const passed = deps.pathExists(full);
          return probed(probe, passed ? "pass" : "fail", `${full} ${passed ? "exists" : "is absent"}`, at);
        }
        const outcome = await runGit(deps, cwd, ["cat-file", "-e", `${probe.atRef}:${probe.path}`]);
        const passed = outcome.exitCode === 0;
        return probed(
          probe,
          passed ? "pass" : "fail",
          `${probe.path} ${passed ? "present" : "absent"} at ${probe.atRef}`,
          at,
        );
      }
    }
  } catch (error) {
    // Fail-closed: an unrunnable probe is a failed probe, never a skipped one.
    return probed(probe, "fail", `probe runner error: ${error instanceof Error ? error.message : String(error)}`, at);
  }
}

/**
 * Run every declared probe, in order. Sequential on purpose: probes are commands
 * against a shared working tree, and a parallel run would make their outcomes
 * depend on each other's side effects.
 */
export async function runProbes(
  probes: readonly Probe[],
  options: ProbeRunnerOptions,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    results.push(await runProbe(probe, options));
  }
  return results;
}

/** Did every declared probe run *and* pass? The close gate's machine-checkable half (§3.1). */
export function allProbesPassed(results: readonly ProbeResult[]): boolean {
  return results.every((result) => result.state === "probed" && result.outcome === "pass");
}
