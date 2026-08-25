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
import { resolve, sep } from "node:path";
import {
  abbreviateTrackerEcho,
  authorizeProbe,
  type ProbeAuthorization,
  type ProbeRegistry,
} from "./work-graph-probe-registry";
import { collapseHome, type Probe, type ProbeResult } from "./work-graph";

/**
 * How much of a *failing* command's output survives into the receipt (§2.2: a
 * bounded tail). The tail is where a failure reason lives, so this is the one
 * case worth paying for.
 */
const OBSERVED_TAIL_LIMIT = 1_200;

/**
 * How much of a *passing* command's output survives — far less, because a
 * success has no reason to give (#527).
 *
 * Measured on this repo before choosing: `bun test` emits 16 918 characters, of
 * which the 1 200-char tail kept 7.1% — and that tail *does* end with
 * `2365 pass / 0 fail`, which corrected #527's premise that the summary was
 * being cut off. The shape was right; the size was wrong, and only here. A green
 * probe was spending 1 200 characters to say yes, in a comment a human scrolls
 * past.
 *
 * 200 is enough for a summary line and its neighbours. A command whose success
 * output is *only* meaningful beyond that has put its result somewhere a probe
 * cannot see, which is a declaration problem rather than a bound problem.
 */
const OBSERVED_PASS_TAIL_LIMIT = 200;

/** Git probes carry no `timeoutSec` of their own; local plumbing that outruns this is broken, not slow. */
const GIT_TIMEOUT_SEC = 60;

/** Nor do `url` probes (§2.2 fixes their shape), and an unbounded fetch would hang the close. */
const URL_TIMEOUT_SEC = 30;

/**
 * The whole close's wall-clock ceiling (#527) — 15 minutes, ~6.5× this repo's
 * measured close (132.0s `bun test` + 5.7s `bunx tsc --noEmit` = 138s).
 *
 * A **runtime** deadline, not a check on the declared `timeoutSec` sum, and the
 * distinction is the decision: soma's own node declares 900 + 600 = 1 500s for
 * work that finishes in 138s, so refusing on the declared sum would punish an
 * honest timeout rather than a slow probe. The named cost of choosing runtime is
 * that this is the one bound in §2.2 whose refusal arrives *after* the time is
 * spent — every other one refuses before anything runs.
 *
 * Separate from §3.3's `budget`, which is a per-node circuit breaker read at
 * claim/execution time. This bounds one close.
 *
 * **What it actually guarantees**, stated precisely because "a 15-minute
 * deadline" is not quite it. No probe may *start* past the deadline, and a
 * `command` or git spawn is clamped to what remains, so neither can outlive it.
 * Two bounded overruns survive:
 *
 * - `url` probes run through {@link ProbeRunnerDeps.fetchStatus}, whose seam
 *   takes a target and nothing else, so they keep their own
 *   {@link URL_TIMEOUT_SEC}. Worst case: deadline + 30s.
 * - `git-merged-into` issues two git commands, each clamped to the *same*
 *   remainder computed at the probe's start. Worst case: deadline + one
 *   {@link GIT_TIMEOUT_SEC}.
 *
 * Both are left rather than fixed: closing them means widening the `fetchStatus`
 * seam and threading a live clock through every git call, to buy at most 60
 * seconds on a 900-second bound. Named here so the number is not read as exact.
 */
export const CLOSE_DEADLINE_SEC = 900;

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
  /**
   * Wall-clock left for the *whole close*, in seconds — set by {@link runProbes}
   * as it walks the sequence, and used to clamp this probe's own timeout so a
   * long-running command cannot outlive the deadline (#527).
   *
   * Absent means unclamped, which is what a single `runProbe` call outside a
   * close sequence should get: the deadline is a property of a close, not of a
   * probe.
   */
  remainingSec?: number;
  /** Override the close deadline. Tests and callers that measure their own clock; defaults to {@link CLOSE_DEADLINE_SEC}. */
  deadlineSec?: number;
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

function probed(
  probe: Probe,
  outcome: "pass" | "fail",
  observed: string,
  at: string,
  cwd?: string,
): ProbeResult {
  return { probe, state: "probed", outcome, observed, at, ...(cwd === undefined ? {} : { cwd }) };
}

/**
 * Command outcome → the `observed` string §2.2 asks for: exit code plus a
 * bounded output tail, bounded **by outcome** (#527).
 *
 * `passed` rather than a re-derivation of it: the caller already compared the
 * exit code against the probe's `expectExit`, and a second comparison here would
 * be a second definition of "did this pass" — the shape #582 and #588 both had
 * to unpick.
 */
function describeCommand(
  outcome: CommandOutcome,
  timeoutSec: number,
  passed: boolean,
  clampedByDeadline = false,
): string {
  if (outcome.timedOut) {
    // Which clock killed it matters to the reader: a probe that outran its own
    // declared timeout is a slow probe, one cut short by the close deadline is a
    // slow *close*, and the fixes are different.
    return clampedByDeadline
      ? `killed after ${timeoutSec}s — the close deadline left no more time`
      : `timed out after ${timeoutSec}s (killed)`;
  }
  const limit = passed ? OBSERVED_PASS_TAIL_LIMIT : OBSERVED_TAIL_LIMIT;
  const tail = boundObserved([outcome.stdout, outcome.stderr].filter((part) => part.trim().length > 0).join("\n"), limit);
  return tail.length === 0 ? `exit ${outcome.exitCode}` : `exit ${outcome.exitCode}: ${tail}`;
}

/**
 * A probe may not outlive the close it belongs to (#527).
 *
 * Clamping the timeout is how the in-flight probe is killed when the deadline
 * arrives mid-run: there is no signal to interrupt an awaited spawn from
 * outside, and the spawn's own timeout already knows how to kill and report. A
 * clamped probe that expires is a *failed* probe on the path §2.2 already owns —
 * no new outcome, no skip.
 *
 * Rounded up, and floored at one second: a sub-second remainder that rounded to
 * zero would spawn a process guaranteed to be killed before it could run, which
 * is worse than letting it have the last second.
 */
function clampToDeadline(timeoutSec: number, remainingSec: number | undefined): number {
  if (remainingSec === undefined) return timeoutSec;
  return Math.max(1, Math.min(timeoutSec, Math.ceil(remainingSec)));
}

async function runGit(
  deps: ProbeRunnerDeps,
  cwd: string,
  args: readonly string[],
  remainingSec?: number,
): Promise<CommandOutcome> {
  return await deps.runCommand({
    argv: ["git", "-C", cwd, ...args],
    timeoutSec: clampToDeadline(GIT_TIMEOUT_SEC, remainingSec),
  });
}

/**
 * Did this git command actually *answer the question*, or could it not look?
 *
 * Git plumbing says "no" with exit 1 and "I could not look" with 128, and before
 * #662 the runner collapsed the two: `git cat-file -e HEAD:docs/x.md` in a
 * directory that is not a repository exits 128, and the receipt read
 * `docs/x.md absent at HEAD` — sending an operator to hunt for a file that was
 * sitting, present, in the tree they ran the close from. The probe base being
 * wrong is a *different defect* from the artifact being missing, and a receipt
 * that cannot tell them apart makes the first one unfindable.
 *
 * **The exit code, not the stderr text.** Git's messages are localizable and
 * have been reworded across versions; the 0/1-answered, everything-else-failed
 * contract has not. Matching on "not a git repository" would be a probe that
 * passes in English and misreports in German.
 *
 * A timeout is unreachable too — a killed spawn reports `exitCode: null`, which
 * would otherwise render as a confident "absent" for a question nobody asked.
 *
 * Still a **fail** either way (§2.2's fail-closed rule): this changes what the
 * receipt *says*, never what the close gate *does*. A new outcome would mean a
 * new branch in {@link assertClosable}, and "could not reach the tree" is no more
 * a pass than "not there" is.
 */
function gitUnreachable(outcome: CommandOutcome, cwd: string, target: string): string | undefined {
  if (!outcome.timedOut && (outcome.exitCode === 0 || outcome.exitCode === 1)) return undefined;
  const reason = outcome.timedOut ? "git timed out (killed)" : `git exited ${outcome.exitCode}`;
  // The stderr tail carries the actual reason (`fatal: not a git repository`,
  // `fatal: bad object`), and it is safe to echo *here specifically*: the three
  // git probes are containment-checked before dispatch, so this directory is
  // already inside the stated probe tree and already named on the line above.
  const detail = boundObserved(outcome.stderr.trim().length > 0 ? outcome.stderr : outcome.stdout);
  return `could not reach ${target} in ${cwd} — ${reason}${detail.length === 0 ? "" : `: ${detail}`}`;
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
 * Where this probe will run, resolved against `baseCwd` — `undefined` for `url`,
 * which runs against a host and no tree.
 *
 * Exported because the close path needs the answer *before* the run, to describe
 * each tree as it stood going in. Deriving it there independently would be two
 * expressions of one rule, and the pair drifting is #579 exactly: the receipt
 * describing one directory while the probe used another.
 */
export function probeDirectory(probe: Probe, baseCwd: string): string | undefined {
  const base = resolve(baseCwd);
  switch (probe.type) {
    case "url":
      return undefined;
    case "command":
      return probeCwd(probe.cwd, base);
    default:
      return probeCwd(probe.repo, base);
  }
}

/**
 * Every refusal `observed` string from the containment check opens with this, the
 * way {@link PROBE_REFUSED_PREFIX} opens a registry refusal. Two prefixes, not
 * one, because the two have different fixes: a registry refusal is answered by
 * declaring something in soma-home, this one only by changing the node.
 */
export const PROBE_ESCAPED_PREFIX = "probe refused — outside the probe tree (DD-16 Amendment A):";

/**
 * Did this probe fail because its path escaped the tree, rather than because it
 * ran and failed? The sibling of {@link isProbeRefusal}, and separate from it for
 * the reason the prefixes are separate: a registry refusal is fixed by declaring
 * something in soma-home, an escape only by changing the node, and a close path
 * that told an adopter to edit their registry over an escape would be sending
 * them to widen a gate that was never the one refusing.
 */
export function isProbeEscape(result: ProbeResult): boolean {
  return result.state === "probed" && result.outcome === "fail" && result.observed.startsWith(PROBE_ESCAPED_PREFIX);
}

/**
 * Is this probe type contained to the stated probe tree?
 *
 * Exhaustive with no `default`, for the reason #526 gave the gate the same
 * shape: a probe type added later must not inherit "contained" by omission — it
 * has to be classified here, or the build fails.
 *
 * `command` and `url` answer **false** because a stricter rule already holds
 * them. A `command`'s resolved `cwd` must match an absolute directory the
 * adopter declared in soma-home byte for byte, and a `url` names a host and no
 * tree at all. Containment on top would forbid the adopter's own declaration —
 * a registry entry pointing at a sibling checkout is that adopter's deliberate
 * act, which is exactly the authority the three argv probes do not pass through.
 */
function containmentApplies(probe: Probe): boolean {
  switch (probe.type) {
    case "command":
    case "url":
      return false;
    case "git-ref-exists":
    case "git-merged-into":
    case "artifact-exists":
      return true;
  }
}

/** One path a probe resolves, and the node field it came from. */
export interface ResolvedProbePath {
  /** The node field that produced it. */
  field: "cwd" | "repo" | "path";
  /** What the node declared, verbatim (bounded before it is echoed anywhere). */
  value: string;
  /** Absolute, resolved against the base. */
  resolved: string;
}

/**
 * Where an `artifact-exists` probe with no `atRef` looks on disk.
 *
 * One expression, two callers — the containment check and the runner's own
 * branch. Deriving it twice is exactly the shape #579 was: two resolutions that
 * agree today, and a receipt describing one path while the probe used another
 * the day one of them changes.
 */
function artifactFilePath(path: string, directory: string): string {
  return resolve(directory, path);
}

/**
 * Every filesystem path an ungated probe is about to touch, resolved against the
 * base, with the node field each one came from.
 *
 * **Two per probe, not one.** #529 asked whether `repo` is bounded; it is not the
 * only escape. `artifact-exists` with no `atRef` resolves `path` against the
 * probe directory itself, so an *absolute* `path` escapes with no `repo` at all
 * — verified live at `dfea720`, where `path: "/etc/passwd"` passed. A
 * containment check that saw only the directory would be the defect, not the fix.
 *
 * The directory half comes from {@link probeDirectory} rather than a second
 * resolution of the same fields: "the directory we checked" and "the directory
 * we ran in" have to be one value, which is #579's whole lesson.
 */
export function resolvedProbePaths(probe: Probe, baseCwd: string): ResolvedProbePath[] {
  const directory = probeDirectory(probe, baseCwd);
  if (directory === undefined) return [];
  const field = probe.type === "command" ? "cwd" : "repo";
  const declared = (probe.type === "command" ? probe.cwd : probe.type === "url" ? undefined : probe.repo) ?? ".";
  const paths: ResolvedProbePath[] = [{ field, value: declared, resolved: directory }];
  if (probe.type === "artifact-exists" && probe.atRef === undefined) {
    // The `atRef` branch reads through `git cat-file <ref>:<path>`, where `path`
    // is a repository-relative object name and never touches the filesystem —
    // so the directory is the only thing to contain there.
    paths.push({ field: "path", value: probe.path, resolved: artifactFilePath(probe.path, directory) });
  }
  return paths;
}

/**
 * Is `candidate` the base tree or a descendant of it?
 *
 * Separator-aware on purpose: a bare `startsWith(base)` would call `/base-evil` a
 * descendant of `/base`. Both sides arrive already resolved to absolute form.
 *
 * **Lexical, not `realpath`.** A symlink *inside* the tree that points outside it
 * still escapes, and saying so is more honest than implying otherwise: resolving
 * links would mean filesystem I/O in a predicate the runner calls before it has
 * decided to touch anything, and the result would still race the probe itself.
 */
function isWithin(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  return candidate.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * Containment: an ungated probe may read the stated probe tree (#580) or a
 * descendant, and nothing else.
 *
 * DD-16 Amendment A ungates the three argv probes as "argv, no shell, no egress,
 * bounded to existence checks in a local tree". Sage's review of #528 showed the
 * last clause was false as written — `repo` and `path` are *tracker content*
 * resolved against the runner's cwd with no bound, so a node body could probe
 * any directory on the closing machine and read the answer back out of the close
 * receipt (`~/.ssh/id_rsa exists`). This is that clause made true.
 *
 * An escape is a **failed probe**, never an exception and never a skip, so the
 * close refuses through the path {@link assertClosable} already owns — the same
 * shape a registry refusal takes, for the same reason.
 *
 * The message names the **resolved** path and the base tree, not just the field:
 * the two differ, and #526's `cwd` lesson is that an adopter who cannot see
 * which of the two the runtime meant cannot fix anything. Published paths are
 * home-collapsed, since a refusal lands in a receipt on a tracker whose
 * visibility soma cannot know.
 */
export function authorizeProbeTree(probe: Probe, baseCwd: string): ProbeAuthorization {
  if (!containmentApplies(probe)) return { allowed: true };
  const base = resolve(baseCwd);
  for (const path of resolvedProbePaths(probe, base)) {
    if (isWithin(path.resolved, base)) continue;
    return {
      allowed: false,
      reason: [
        `${PROBE_ESCAPED_PREFIX} \`${path.field}: ${JSON.stringify(abbreviateTrackerEcho(path.value))}\``,
        `resolves to ${collapseHome(path.resolved)}, which is not ${collapseHome(base)} or a descendant of it.`,
        `An ungated probe reads the stated probe tree and nothing else: its result is published to the tracker,`,
        `so any directory it can reach is a directory it can disclose.`,
      ].join("\n"),
    };
  }
  return { allowed: true };
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

  // One directory per probe, computed once, used by the gate, the spawn, the
  // result, and — through the same exported rule — the receipt. The registry's
  // exact-match guarantee is only worth anything while "the cwd we authorised",
  // "the cwd we executed in", and "the cwd we recorded" are the same value;
  // equivalent expressions would hold today and drift silently tomorrow, which
  // is how #579 happened.
  //
  // `ranIn` is undefined for `url`: it runs against a host, so recording a
  // directory for it would be a fact about nothing. The gate and the (unused)
  // spawn base still need *some* directory, hence the fallback.
  const ranIn = probeDirectory(probe, baseCwd);
  const resolvedCwd = ranIn ?? baseCwd;

  // Every result carries the same probe, timestamp, and directory; only the
  // outcome and the observation differ. Binding them once keeps a branch from
  // quietly omitting one — which is how `cwd` would go missing on the path that
  // needs it most.
  const finish = (outcome: "pass" | "fail", observed: string): ProbeResult =>
    probed(probe, outcome, observed, at, ranIn);

  try {
    // Both gates run before dispatch, not inside the cases they apply to, so a
    // probe type added later cannot slip past either by forgetting to call it.
    // They answer different questions — `authorizeProbe` asks whose code this is,
    // `authorizeProbeTree` asks which tree it may read — and every probe passes
    // through both.
    const containment = authorizeProbeTree(probe, baseCwd);
    if (!containment.allowed) {
      return finish("fail", containment.reason);
    }

    const authorization = authorizeProbe(probe, resolvedCwd, options.registry);
    if (!authorization.allowed) {
      return finish("fail", authorization.reason);
    }

    switch (probe.type) {
      case "command": {
        const timeoutSec = clampToDeadline(probe.timeoutSec, options.remainingSec);
        const outcome = await deps.runCommand({
          shell: probe.run,
          cwd: resolvedCwd,
          timeoutSec,
        });
        const passed = !outcome.timedOut && outcome.exitCode === probe.expectExit;
        const observed = describeCommand(outcome, timeoutSec, passed, timeoutSec < probe.timeoutSec);
        return finish(passed ? "pass" : "fail", passed ? observed : `${observed} (expected exit ${probe.expectExit})`);
      }

      case "url": {
        const status = await deps.fetchStatus(probe.target);
        const passed = status === probe.expectStatus;
        return finish(passed ? "pass" : "fail", `status ${status}${passed ? "" : ` (expected ${probe.expectStatus})`}`);
      }

      case "git-ref-exists": {
        const outcome = await runGit(deps, resolvedCwd, ["rev-parse", "--verify", "--quiet", `${probe.ref}^{commit}`], options.remainingSec);
        const unreachable = gitUnreachable(outcome, resolvedCwd, probe.ref);
        if (unreachable !== undefined) return finish("fail", unreachable);
        const sha = outcome.stdout.trim();
        const passed = outcome.exitCode === 0 && sha.length > 0;
        return finish(passed ? "pass" : "fail", passed ? `${probe.ref} → ${sha}` : `${probe.ref} does not resolve in ${resolvedCwd}`);
      }

      case "git-merged-into": {
        const resolvedRef = await runGit(deps, resolvedCwd, ["rev-parse", "--verify", "--quiet", `${probe.ref}^{commit}`], options.remainingSec);
        const refUnreachable = gitUnreachable(resolvedRef, resolvedCwd, probe.ref);
        if (refUnreachable !== undefined) return finish("fail", refUnreachable);
        const sha = resolvedRef.stdout.trim();
        if (resolvedRef.exitCode !== 0 || sha.length === 0) {
          return finish("fail", `${probe.ref} does not resolve in ${resolvedCwd}`);
        }
        const ancestor = await runGit(deps, resolvedCwd, ["merge-base", "--is-ancestor", probe.ref, probe.into], options.remainingSec);
        // Checked on `into` as well as on `ref`: `merge-base --is-ancestor` exits
        // 128 for an `into` that does not resolve, and "is not an ancestor of
        // main" is a plausible-sounding way to say "there is no main here".
        const intoUnreachable = gitUnreachable(ancestor, resolvedCwd, probe.into);
        if (intoUnreachable !== undefined) return finish("fail", intoUnreachable);
        const passed = ancestor.exitCode === 0;
        return finish(passed ? "pass" : "fail", `${probe.ref} (${sha}) ${passed ? "is" : "is not"} an ancestor of ${probe.into}`);
      }

      case "artifact-exists": {
        if (probe.atRef === undefined) {
          // Same expression the containment check used — see {@link artifactFilePath}.
          const full = artifactFilePath(probe.path, resolvedCwd);
          const passed = deps.pathExists(full);
          return finish(passed ? "pass" : "fail", `${full} ${passed ? "exists" : "is absent"}`);
        }
        const outcome = await runGit(deps, resolvedCwd, ["cat-file", "-e", `${probe.atRef}:${probe.path}`], options.remainingSec);
        // #662's reported symptom lives on this line: the probe base was the
        // install tree, `cat-file` exited 128, and the receipt said `absent`.
        const unreachable = gitUnreachable(outcome, resolvedCwd, probe.atRef);
        if (unreachable !== undefined) return finish("fail", unreachable);
        const passed = outcome.exitCode === 0;
        return finish(passed ? "pass" : "fail", `${probe.path} ${passed ? "present" : "absent"} at ${probe.atRef}`);
      }
    }
  } catch (error) {
    // Fail-closed: an unrunnable probe is a failed probe, never a skipped one.
    return finish("fail", `probe runner error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Run every declared probe, in order, under one close deadline (#527).
 *
 * Sequential on purpose: probes are commands against a shared working tree, and
 * a parallel run would make their outcomes depend on each other's side effects.
 * The deadline rides that sequence — one clock, started at the first probe,
 * clamping each probe's own timeout to what is left.
 *
 * Past the deadline, the remaining probes are recorded as **failed** without
 * running. Not skipped: §2.2 has one rule for a probe that could not run, and
 * this is that case. The close then refuses through {@link assertClosable}, which
 * already knows what a failed probe means — no new outcome, no new gate.
 */
export async function runProbes(
  probes: readonly Probe[],
  options: ProbeRunnerOptions,
): Promise<ProbeResult[]> {
  const deps = resolveDeps(options);
  const deadlineSec = options.deadlineSec ?? CLOSE_DEADLINE_SEC;
  const startedMs = deps.now().getTime();

  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const elapsedSec = (deps.now().getTime() - startedMs) / 1_000;
    const remainingSec = deadlineSec - elapsedSec;

    if (remainingSec <= 0) {
      // No `cwd` on this result: the probe ran nowhere, and naming a directory
      // it never entered would be a true-looking fact about nothing (#579).
      results.push(
        probed(
          probe,
          "fail",
          `close deadline of ${deadlineSec}s exceeded after ${elapsedSec.toFixed(1)}s — this probe did not run`,
          deps.now().toISOString(),
        ),
      );
      continue;
    }

    results.push(await runProbe(probe, { ...options, remainingSec }));
  }
  return results;
}

/** Did every declared probe run *and* pass? The close gate's machine-checkable half (§3.1). */
export function allProbesPassed(results: readonly ProbeResult[]): boolean {
  return results.every((result) => result.state === "probed" && result.outcome === "pass");
}
