/**
 * Knowledge-orientation eval: one frozen fixture, one trial.
 *
 *   bun run knowledge-eval trial --fixture <id> --arm <label> --home-source <dir> --substrate claude
 *       [--hint <0-3>] [--model <id>] [--timeout-ms <n>] [--probe-timeout-ms <n>]
 *       [--soma-home <dir>] [--out <dir>] [--claude-bin <path>] [--keep]
 *
 * A trial clones the fixture's repo into the private store's cache, adds a
 * detached worktree at the pinned rev, copies --home-source into a temp
 * SOMA_HOME, applies the fixture's seed, projects Soma into a temp home, runs
 * the substrate headless in the worktree, then runs the fixture's acceptance
 * probe and writes one result record under
 * $SOMA_HOME/evals/knowledge-orientation/results/.
 *
 * The store is private: fixtures, cache and results all live under
 * $SOMA_HOME/evals/knowledge-orientation/, and any fixture or output path that
 * resolves outside it is refused before anything is written. The trial runs
 * with HOME, SOMA_HOME and CLAUDE_CONFIG_DIR pointed at temp dirs, so the
 * principal's ~/.soma and ~/.claude are never read as configuration or written.
 * The caller's environment does not carry over: the trial sees only the
 * variables in TRIAL_PASSTHROUGH_ENV, and the substrate alone also gets the
 * credential variables in TRIAL_AUTH_ENV. This is isolation
 * of configuration, not a sandbox: the substrate runs with the caller's rights.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const PINNED_CLAUDE_MODEL = "claude-sonnet-5-5";
export const DEFAULT_TRIAL_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_PROBE_TIMEOUT_MS = 10 * 60 * 1000;
export const TRIAL_AUTH_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
export const SUPPORTED_SUBSTRATES = ["claude-code"] as const;
/** Spellings accepted on the command line, mapped to the canonical ProjectionSubstrate id the record stores. */
const SUBSTRATE_ALIASES: Readonly<Record<string, string>> = { claude: "claude-code" };

function canonicalSubstrate(name: string): string {
  return SUBSTRATE_ALIASES[name] ?? name;
}
/** Caller variables a trial needs to run tools at all; any other variable, a credential included, stays out. */
export const TRIAL_PASSTHROUGH_ENV = ["PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR"] as const;

const TOTAL_USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const;

const REPO_ROOT = resolve(import.meta.dir, "..");
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const HOME_COPY_EXCLUDED_TOP_LEVEL = new Set(["evals", "runtime", ".build", ".logs", ".tmp"]);

// ---------------------------------------------------------------------------
// Fixture schema
// ---------------------------------------------------------------------------

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const SeedOpSchema = z
  .strictObject({
    op: z.enum(["add", "alter", "remove"]),
    path: z.string().min(1),
    content: z.string().optional(),
  })
  .superRefine((seed, ctx) => {
    if (seed.op === "remove" && seed.content !== undefined) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "remove takes no content" });
    }
    if (seed.op !== "remove" && seed.content === undefined) {
      ctx.addIssue({ code: "custom", path: ["content"], message: `${seed.op} requires content` });
    }
  });

export const FixtureSchema = z.strictObject({
  id: z.string().regex(SLUG),
  domain: z.enum(["soma", "ranger-cortex", "seelite", "abacus"]),
  capability: z.enum(["discover-reuse", "cross-system", "prep-vs-outcome", "recovery"]),
  condition: z.enum(["correct", "misleading", "stale", "missing"]),
  repo: z.string().min(1).refine((url) => !url.startsWith("-"), "repo must not start with '-'"),
  rev: z.string().regex(/^[0-9a-f]{40}$/, "rev must be a full 40-character commit sha"),
  prompt: z.string().min(1),
  seed: z.array(SeedOpSchema),
  recovery_packet: z.string().optional(),
  hints: z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]),
  acceptance_probe: z.string().min(1),
  expected_sources: z.array(z.string().min(1)),
  forbidden_duplicates: z.array(z.string().min(1)),
  known_wrong: z.string(),
});

export type Fixture = z.infer<typeof FixtureSchema>;
export type SeedOp = z.infer<typeof SeedOpSchema>;

/** A refusal caused by the request itself; the CLI exits 2 on it. */
export class TrialUsageError extends Error {}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length === 0 ? "(fixture)" : issue.path.join(".");
  if (issue.code === "unrecognized_keys") {
    return `unknown key ${issue.keys.map((key) => `"${key}"`).join(", ")} at ${where}`;
  }
  if (issue.code === "invalid_type" && issue.message.includes("received undefined")) {
    return `missing required key "${where}"`;
  }
  return `${where}: ${issue.message}`;
}

export function parseFixture(raw: unknown, source: string): Fixture {
  const parsed = FixtureSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new TrialUsageError(`Invalid fixture ${source}:\n${parsed.error.issues.map((issue) => `  - ${describeIssue(issue)}`).join("\n")}`);
}

// ---------------------------------------------------------------------------
// Store paths (fail closed)
// ---------------------------------------------------------------------------

export function storeRoot(somaHome: string): string {
  return join(resolve(somaHome), "evals", "knowledge-orientation");
}

function realpathOfDeepestExisting(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    tail.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...tail);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve `path` and refuse it unless it stays inside the store, symlinks included. */
export function resolveInsideStore(path: string, store: string, what: string): string {
  const realStore = realpathOfDeepestExisting(store);
  const realTarget = realpathOfDeepestExisting(path);
  if (!isInside(realStore, realTarget)) {
    throw new TrialUsageError(`Refusing ${what} outside ${store}: ${path}`);
  }
  if (isInside(realpathOfDeepestExisting(REPO_ROOT), realStore)) {
    throw new TrialUsageError(`Refusing a store inside the soma checkout: ${store}`);
  }
  return realTarget;
}

export interface LoadedFixture {
  fixture: Fixture;
  path: string;
  sha: string;
}

export function loadFixture(ref: string, store: string): LoadedFixture {
  const looksLikePath = ref.includes("/") || ref.endsWith(".json");
  if (!looksLikePath && !SLUG.test(ref)) throw new TrialUsageError(`Invalid fixture id: ${ref}`);
  const candidate = looksLikePath ? resolve(ref) : join(store, "fixtures", `${ref}.json`);
  const path = resolveInsideStore(candidate, store, "fixture path");
  if (!existsSync(path)) throw new TrialUsageError(`Fixture not found: ${path}`);
  const bytes = readFileSync(path);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new TrialUsageError(`Fixture is not valid JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { fixture: parseFixture(raw, path), path, sha: createHash("sha256").update(bytes).digest("hex") };
}

// ---------------------------------------------------------------------------
// Prompt, seed
// ---------------------------------------------------------------------------

export function composePrompt(fixture: Fixture, hint: number): string {
  const parts: string[] = [];
  if (fixture.recovery_packet !== undefined) parts.push(`<prior_context>\n${fixture.recovery_packet}\n</prior_context>`);
  parts.push(fixture.prompt);
  const hints = fixture.hints.slice(0, hint).map((text, index) => `Hint ${index + 1}: ${text}`);
  if (hints.length > 0) parts.push(hints.join("\n"));
  return parts.join("\n\n");
}

function seedTarget(somaHome: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new TrialUsageError(`Seed path must be relative and stay inside the trial home: ${path}`);
  }
  const target = resolve(somaHome, path);
  if (!isInside(realpathSync(somaHome), realpathOfDeepestExisting(target)) || target === resolve(somaHome)) {
    throw new TrialUsageError(`Seed path escapes the trial home: ${path}`);
  }
  return target;
}

export function applySeed(somaHome: string, seed: readonly SeedOp[]): void {
  for (const op of seed) {
    const target = seedTarget(somaHome, op.path);
    if (op.op === "remove") {
      rmSync(target, { recursive: true, force: true });
      continue;
    }
    if (op.op === "alter" && !existsSync(target)) {
      throw new TrialUsageError(`Seed alter targets a missing path: ${op.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, op.content ?? "");
  }
}

// ---------------------------------------------------------------------------
// Transcript analysis
// ---------------------------------------------------------------------------

export type Measured = number | "unmeasured";

export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

export interface StreamFacts {
  model: string | undefined;
  startTokens: Measured;
  totalTokens: Measured;
  toolUses: ToolUse[];
  resultIsError: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Sum of the named usage fields, or undefined when the first one (input_tokens) is absent. */
function sumUsage(usage: Record<string, unknown> | undefined, fields: readonly string[]): number | undefined {
  if (usage === undefined || num(usage[fields[0] ?? ""]) === undefined) return undefined;
  return fields.reduce((sum, field) => sum + (num(usage[field]) ?? 0), 0);
}

export function parseStream(stdout: string): StreamFacts {
  const facts: StreamFacts = { model: undefined, startTokens: "unmeasured", totalTokens: "unmeasured", toolUses: [], resultIsError: false };
  const perMessage = new Map<string, number>();
  let resultTotal: number | undefined;
  let sawStart = false;
  let anonymous = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(line));
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (event === undefined) continue;
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") facts.model = event.model;
    if (event.type === "result") {
      facts.resultIsError = event.is_error === true;
      resultTotal = sumUsage(asRecord(event.usage), TOTAL_USAGE_FIELDS);
    }
    if (event.type !== "assistant") continue;
    const message = asRecord(event.message);
    if (message === undefined) continue;
    const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
    for (const block of content) {
      const record = asRecord(block);
      if (record?.type === "tool_use" && typeof record.name === "string") {
        facts.toolUses.push({ name: record.name, input: asRecord(record.input) ?? {} });
      }
    }
    if (message.model === "<synthetic>") continue;
    const usage = asRecord(message.usage);
    if (!sawStart) {
      const start = sumUsage(usage, ["input_tokens", "cache_creation_input_tokens"]);
      if (start !== undefined) {
        facts.startTokens = start;
        sawStart = true;
      }
    }
    const total = sumUsage(usage, TOTAL_USAGE_FIELDS);
    if (total !== undefined) perMessage.set(typeof message.id === "string" ? message.id : `anonymous-${String((anonymous += 1))}`, total);
  }
  if (resultTotal !== undefined) facts.totalTokens = resultTotal;
  else if (perMessage.size > 0) facts.totalTokens = [...perMessage.values()].reduce((sum, value) => sum + value, 0);
  return facts;
}

function routePath(source: string): string {
  const withoutFragment = source.split("#")[0] ?? source;
  const route = /^[A-Za-z][\w.-]*:(?!\/)(.+)$/.exec(withoutFragment);
  return (route?.[1] ?? withoutFragment).replace(/^\.\//, "");
}

function pathMatches(actual: string, target: string): boolean {
  const normalized = actual.replaceAll("\\", "/");
  return normalized === target || normalized.endsWith(`/${target}`);
}

const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "bat", "nl", "grep", "rg", "awk", "sed"]);

/**
 * True when a segment of `command` runs a read command with `target` as an
 * argument. Naming a path is not reading it: `rm`, `echo` and `sed -i` do not
 * count.
 */
function bashReads(command: string, target: string): boolean {
  return command.split(/\|\||&&|[|;\n]/u).some((segment) => {
    const [program = "", ...args] = segment.trim().split(/\s+/u);
    const name = basename(program);
    if (!READ_COMMANDS.has(name)) return false;
    if (name === "sed" && args.some((arg) => /^-[^-]*i/u.test(arg) || arg.startsWith("--in-place"))) return false;
    return args.some((arg) => pathMatches(arg.replace(/^["']|["']$/gu, ""), target));
  });
}

function usesRead(use: ToolUse, target: string): boolean {
  const str = (key: string): string => {
    const value = use.input[key];
    return typeof value === "string" ? value : "";
  };
  if (use.name === "Read") return pathMatches(str("file_path"), target);
  if (use.name === "Grep") return pathMatches(str("path"), target);
  if (use.name === "Bash") return bashReads(str("command"), target);
  return false;
}

/** Expected sources the transcript read; a route counts when its file was read. */
export function sourcesRead(expected: readonly string[], toolUses: readonly ToolUse[]): string[] {
  return expected.filter((source) => {
    const target = routePath(source);
    return toolUses.some((use) => usesRead(use, target));
  });
}

/** A Bash call after the last file edit; no edit at all is not a probe. */
export function probedAfterLastEdit(toolUses: readonly ToolUse[]): boolean {
  const lastEdit = toolUses.map((use) => EDIT_TOOLS.has(use.name)).lastIndexOf(true);
  return lastEdit >= 0 && toolUses.slice(lastEdit + 1).some((use) => use.name === "Bash");
}

// ---------------------------------------------------------------------------
// Diff analysis
// ---------------------------------------------------------------------------

export interface DiffFile {
  path: string;
  isNew: boolean;
  added: string[];
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = { path: paths?.[2] ?? "", isNew: false, added: [] };
      files.push(current);
    } else if (current === undefined) {
      continue;
    } else if (line.startsWith("new file mode")) {
      current.isNew = true;
    } else if (line.startsWith("+++ b/")) {
      current.path = line.slice("+++ b/".length);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.added.push(line.slice(1));
    }
  }
  return files;
}

/**
 * Forbidden duplicates present in the diff. An entry is a path (a new file at
 * that path), a symbol (text on an added line), or `<symbol> outside <path>`
 * (the symbol on an added line of any other file).
 */
export function duplicatesCreated(forbidden: readonly string[], files: readonly DiffFile[]): string[] {
  return forbidden.filter((entry) => {
    const scoped = /^(.+?) outside (\S+)$/.exec(entry);
    if (scoped) {
      const [, symbol = "", exempt = ""] = scoped;
      return files.some((file) => file.path !== exempt && file.added.some((added) => added.includes(symbol)));
    }
    if (entry.includes("/") && !/\s/.test(entry)) return files.some((file) => file.isNew && file.path === entry);
    return files.some((file) => file.added.some((added) => added.includes(entry)));
  });
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function drain(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) sink.push(decoder.decode(chunk, { stream: true }));
}

const GROUP_EXIT_WAIT_MS = 5000;

/**
 * Signal every process in the group led by `pid`; false when no live member
 * is left. Darwin answers EPERM for a group of zombies awaiting reaping.
 */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw error;
  }
}

async function killGroup(pid: number): Promise<void> {
  if (!signalGroup(pid, "SIGKILL")) return;
  const deadline = Date.now() + GROUP_EXIT_WAIT_MS;
  while (signalGroup(pid, 0) && Date.now() < deadline) await Bun.sleep(25);
}

/**
 * Run `command` as the leader of its own process group. Once the leader exits
 * or times out, the whole group is killed and awaited, so a background tool
 * command that stayed in the group cannot keep editing the worktree while the
 * trial scores it. A descendant that called setsid leaves the group and is not
 * stopped; this is hygiene, not a sandbox.
 */
export async function runProcess(
  command: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number },
): Promise<ProcessResult> {
  const out: string[] = [];
  const err: string[] = [];
  const state = { timedOut: false };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...command], {
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
  }
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    state.timedOut = true;
    signalGroup(proc.pid, "SIGKILL");
  }, options.timeoutMs);
  const drained = Promise.all([
    drain(proc.stdout as ReadableStream<Uint8Array>, out),
    drain(proc.stderr as ReadableStream<Uint8Array>, err),
  ]);
  const exitCode = await proc.exited;
  if (timer !== undefined) clearTimeout(timer);
  await killGroup(proc.pid);
  // A descendant that left the group can still hold the pipes open.
  await Promise.race([drained, new Promise((done) => setTimeout(done, 2000))]);
  return { exitCode: state.timedOut ? null : exitCode, stdout: out.join(""), stderr: err.join(""), timedOut: state.timedOut };
}

/** Config overrides that win over anything the substrate wrote into the shared cache repo config. */
const SAFE_GIT_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;

async function git(args: readonly string[], cwd?: string, env?: Record<string, string | undefined>): Promise<string> {
  const result = await runProcess(["git", ...SAFE_GIT_CONFIG, ...args], {
    cwd,
    env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${String(result.exitCode)}): ${result.stderr.trim()}`);
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Trial
// ---------------------------------------------------------------------------

export interface SubstrateRun {
  cwd: string;
  env: Record<string, string | undefined>;
  prompt: string;
  model: string;
  timeoutMs: number;
}

export interface SubstrateRunner {
  name: string;
  version(env: Record<string, string | undefined>): Promise<string>;
  run(input: SubstrateRun): Promise<ProcessResult>;
}

export function claudeRunner(bin: string): SubstrateRunner {
  return {
    name: "claude",
    async version(env) {
      const result = await runProcess([bin, "--version"], { env, timeoutMs: 30_000 });
      return result.exitCode === 0 ? (result.stdout.trim().split(/\s+/)[0] ?? "unknown") : "unknown";
    },
    run(input) {
      return runProcess(
        [
          bin, "-p", "--output-format", "stream-json", "--verbose", "--model", input.model,
          "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Edit,Write,Read,Grep,Glob",
        ],
        { cwd: input.cwd, env: input.env, stdin: input.prompt, timeoutMs: input.timeoutMs },
      );
    },
  };
}

export interface TrialDeps {
  runner: SubstrateRunner;
  installProjection(input: { somaHome: string; homeDir: string; env: Record<string, string | undefined> }): Promise<void>;
}

async function installClaudeProjection(input: { somaHome: string; homeDir: string; env: Record<string, string | undefined> }): Promise<void> {
  const result = await runProcess(
    [process.execPath, join(REPO_ROOT, "src", "cli.ts"), "install", "claude-code", "--apply", "--soma-home", input.somaHome, "--home-dir", input.homeDir],
    { cwd: REPO_ROOT, env: input.env, timeoutMs: 5 * 60 * 1000 },
  );
  if (result.exitCode !== 0) throw new Error(`soma install claude-code failed (${String(result.exitCode)}): ${result.stderr.trim() || result.stdout.trim()}`);
}

export interface TrialOptions {
  fixture: string;
  arm: string;
  homeSource: string;
  substrate: string;
  hint: number;
  model: string;
  somaHome: string;
  out?: string;
  timeoutMs: number;
  probeTimeoutMs: number;
  keep: boolean;
}

export interface TrialRecord {
  fixture_id: string;
  fixture_sha: string;
  arm: string;
  substrate: string;
  cli: { name: string; version: string };
  model: string;
  soma_sha: string;
  hint_level: number;
  outcome: "completed" | "errored";
  substrate_exit: number | null;
  timed_out: boolean;
  error: string | null;
  probe_exit: number | null;
  start_of_session_tokens: Measured;
  total_tokens: Measured;
  wall_time_ms: number;
  sources_read: string[];
  duplicates_created: string[];
  probed_after_last_edit: boolean;
  started_at: string;
  transcript_path: string;
}

export interface TrialResult {
  record: TrialRecord;
  recordPath: string;
}

const SLUG_ARM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateOptions(options: TrialOptions): void {
  if (!SLUG_ARM.test(options.arm)) throw new TrialUsageError(`Invalid arm label: ${options.arm}`);
  if (!(SUPPORTED_SUBSTRATES as readonly string[]).includes(options.substrate)) {
    throw new TrialUsageError(`Unsupported substrate "${options.substrate}"; supported: ${SUPPORTED_SUBSTRATES.join(", ")}`);
  }
  if (!Number.isInteger(options.hint) || options.hint < 0 || options.hint > 3) throw new TrialUsageError("--hint must be 0, 1, 2 or 3");
  if (!existsSync(options.homeSource)) throw new TrialUsageError(`--home-source not found: ${options.homeSource}`);
}

/**
 * The substrate runs with the caller's rights and can rewrite the shared cache
 * repo (config, hooks, attributes) during a trial. The next trial's clone, fetch
 * and checkout run with the caller's credentials, so the cache is put back to a
 * known state before any git command touches it: a fresh config that holds only
 * the origin remote, and none of the files that can carry executable behavior.
 */
function resetCache(cache: string, repo: string): void {
  const quoted = repo.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  writeFileSync(
    join(cache, "config"),
    `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n[remote "origin"]\n\turl = "${quoted}"\n\tfetch = +refs/*:refs/*\n\tmirror = true\n`,
  );
  for (const name of ["hooks", "config.worktree", join("info", "attributes")]) rmSync(join(cache, name), { recursive: true, force: true });
}

async function ensureRevision(cache: string, fixture: Fixture): Promise<void> {
  if (existsSync(cache)) {
    resetCache(cache, fixture.repo);
  } else {
    mkdirSync(dirname(cache), { recursive: true });
    await git(["clone", "--mirror", "--", fixture.repo, cache]);
  }
  const has = await runProcess(["git", ...SAFE_GIT_CONFIG, "cat-file", "-e", `${fixture.rev}^{commit}`], { cwd: cache });
  if (has.exitCode !== 0) {
    await git(["fetch", "--prune", "origin"], cache);
    await git(["cat-file", "-e", `${fixture.rev}^{commit}`], cache);
  }
}

function copyHomeSource(source: string, destination: string): void {
  const root = realpathSync(source);
  cpSync(root, destination, {
    recursive: true,
    filter: (path) => {
      const rel = relative(root, path);
      const top = rel.split(sep)[0] ?? "";
      return rel === "" || !HOME_COPY_EXCLUDED_TOP_LEVEL.has(top);
    },
  });
}

function callerEnv(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function trialEnv(root: string): Record<string, string | undefined> {
  const home = join(root, "home");
  const env: Record<string, string | undefined> = {
    ...callerEnv(TRIAL_PASSTHROUGH_ENV),
    HOME: home,
    SOMA_HOME: join(root, "soma"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_TERMINAL_PROMPT: "0",
  };
  return env;
}

interface RecordInputs {
  fixture: Fixture;
  fixtureSha: string;
  options: TrialOptions;
  runnerName: string;
  version: string;
  somaSha: string;
  run: ProcessResult;
  probe: ProcessResult;
  facts: StreamFacts;
  diff: string;
  startedAt: Date;
  wallTimeMs: number;
  transcriptPath: string;
}

function buildRecord(input: RecordInputs): TrialRecord {
  const { fixture, options, run, probe, facts } = input;
  const errored = run.timedOut || run.exitCode !== 0 || facts.resultIsError;
  const reason = run.timedOut
    ? `timed out after ${String(options.timeoutMs)} ms`
    : run.stderr.trim().slice(0, 2000) || (facts.resultIsError ? "result event flagged is_error" : null);
  return {
    fixture_id: fixture.id,
    fixture_sha: input.fixtureSha,
    arm: options.arm,
    substrate: options.substrate,
    cli: { name: input.runnerName, version: input.version },
    model: facts.model ?? options.model,
    soma_sha: input.somaSha,
    hint_level: options.hint,
    outcome: errored ? "errored" : "completed",
    substrate_exit: run.exitCode,
    timed_out: run.timedOut,
    error: errored ? reason : null,
    probe_exit: probe.exitCode,
    start_of_session_tokens: facts.startTokens,
    total_tokens: facts.totalTokens,
    wall_time_ms: input.wallTimeMs,
    sources_read: sourcesRead(fixture.expected_sources, facts.toolUses),
    duplicates_created: duplicatesCreated(fixture.forbidden_duplicates, parseDiff(input.diff)),
    probed_after_last_edit: probedAfterLastEdit(facts.toolUses),
    started_at: input.startedAt.toISOString(),
    transcript_path: input.transcriptPath,
  };
}

function writeRecord(recordPath: string, record: TrialRecord): void {
  const pending = `${recordPath}.tmp`;
  writeFileSync(pending, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(pending, recordPath);
}

export async function runTrial(rawOptions: TrialOptions, deps: TrialDeps): Promise<TrialResult> {
  const options = { ...rawOptions, substrate: canonicalSubstrate(rawOptions.substrate) };
  validateOptions(options);
  const store = storeRoot(options.somaHome);
  const loaded = loadFixture(options.fixture, store);
  const { fixture } = loaded;
  const outDir = resolveInsideStore(options.out ?? join(store, "results"), store, "output path");
  const cache = resolveInsideStore(join(store, "cache", `${createHash("sha256").update(fixture.repo).digest("hex").slice(0, 16)}.git`), store, "cache path");

  const somaSha = (await git(["rev-parse", "HEAD"], REPO_ROOT)).trim();
  await ensureRevision(cache, fixture);

  const root = realpathSync(mkdtempSync(join(tmpdir(), "ko-trial-")));
  const worktree = join(root, "worktree");
  let worktreeAdded = false;
  try {
    await git(["worktree", "add", "--detach", worktree, fixture.rev], cache);
    worktreeAdded = true;

    const somaHome = join(root, "soma");
    const homeDir = join(root, "home");
    mkdirSync(homeDir, { recursive: true });
    copyHomeSource(options.homeSource, somaHome);
    applySeed(somaHome, fixture.seed);
    const env = trialEnv(root);
    await deps.installProjection({ somaHome, homeDir, env });

    const substrateEnv = { ...env, ...callerEnv(TRIAL_AUTH_ENV) };
    const probeEnv = env;

    const version = await deps.runner.version(substrateEnv);
    const startedAt = new Date();
    const started = performance.now();
    const run = await deps.runner.run({
      cwd: worktree,
      env: substrateEnv,
      prompt: composePrompt(fixture, options.hint),
      model: options.model,
      timeoutMs: options.timeoutMs,
    });
    const wallTimeMs = Math.round(performance.now() - started);

    const facts = parseStream(run.stdout);
    // The substrate can edit the cache repo's config, which the worktree shares:
    // score its edits with a stripped environment and fixed config overrides.
    const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    await git(["add", "-A"], worktree, gitEnv);
    const diff = await git(["diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", fixture.rev], worktree, gitEnv);

    const probe = await runProcess(["sh", "-c", fixture.acceptance_probe], { cwd: worktree, env: probeEnv, timeoutMs: options.probeTimeoutMs });

    const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const base = `${fixture.id}.${options.arm}.h${String(options.hint)}.${stamp}.${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(outDir, { recursive: true });
    const transcriptPath = join(outDir, `${base}.transcript.jsonl`);
    const recordPath = join(outDir, `${base}.json`);
    writeFileSync(transcriptPath, run.stdout);

    const record = buildRecord({
      fixture, fixtureSha: loaded.sha, options, runnerName: deps.runner.name, version, somaSha, run, probe, facts, diff, startedAt, wallTimeMs, transcriptPath,
    });
    writeRecord(recordPath, record);
    return { record, recordPath };
  } finally {
    if (options.keep) {
      process.stderr.write(`Kept trial workdir: ${root}\n`);
    } else {
      const cleanEnv = { ...trialEnv(root), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
      if (worktreeAdded) await runProcess(["git", ...SAFE_GIT_CONFIG, "worktree", "remove", "--force", worktree], { cwd: cache, env: cleanEnv });
      rmSync(root, { recursive: true, force: true });
      await runProcess(["git", ...SAFE_GIT_CONFIG, "worktree", "prune"], { cwd: cache, env: cleanEnv });
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: bun run knowledge-eval trial --fixture <id> --arm <label> --home-source <dir> --substrate claude " +
  "[--hint <0-3>] [--model <id>] [--timeout-ms <n>] [--probe-timeout-ms <n>] [--soma-home <dir>] [--out <dir>] [--claude-bin <path>] [--keep]";

interface ParsedArgs {
  options: TrialOptions;
  claudeBin: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "trial") throw new TrialUsageError(USAGE);
  const values = new Map<string, string>();
  let keep = false;
  const valueFlags = ["--fixture", "--arm", "--home-source", "--substrate", "--hint", "--model", "--timeout-ms", "--probe-timeout-ms", "--soma-home", "--out", "--claude-bin"];
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? "";
    if (flag === "--keep") {
      keep = true;
    } else if (valueFlags.includes(flag)) {
      const value = rest.at(index + 1);
      if (value === undefined || value.startsWith("--")) throw new TrialUsageError(`${flag} requires a value.\n${USAGE}`);
      values.set(flag, value);
      index += 1;
    } else {
      throw new TrialUsageError(`Unknown option: ${flag}\n${USAGE}`);
    }
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new TrialUsageError(`${flag} is required.\n${USAGE}`);
    return value;
  };
  const integer = (flag: string, fallback: number): number => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new TrialUsageError(`${flag} must be a non-negative integer`);
    return Number(raw);
  };
  return {
    claudeBin: values.get("--claude-bin") ?? "claude",
    options: {
      fixture: required("--fixture"),
      arm: required("--arm"),
      homeSource: resolve(required("--home-source")),
      substrate: required("--substrate"),
      hint: integer("--hint", 0),
      model: values.get("--model") ?? PINNED_CLAUDE_MODEL,
      somaHome: resolve(values.get("--soma-home") ?? process.env.SOMA_HOME ?? join(homedir(), ".soma")),
      out: values.get("--out"),
      timeoutMs: integer("--timeout-ms", DEFAULT_TRIAL_TIMEOUT_MS),
      probeTimeoutMs: integer("--probe-timeout-ms", DEFAULT_PROBE_TIMEOUT_MS),
      keep,
    },
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof TrialUsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  try {
    const { record, recordPath } = await runTrial(parsed.options, {
      runner: claudeRunner(parsed.claudeBin),
      installProjection: installClaudeProjection,
    });
    console.log(`${record.outcome}: ${recordPath}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof TrialUsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
