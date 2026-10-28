/**
 * Probe registry — the gate DD-16 Amendment A puts in front of `command` and
 * `url` probes (`docs/work-graph.md` §2.2 and §4, ticket #526).
 *
 * The question it answers is **whose code is this**. A `command` probe is a
 * shell string living in the node block — *tracker content* — and
 * `soma graph close` executes it on the closing machine. `soma graph` runs
 * against whatever repo an adopter points it at, so soma cannot know that
 * repo's visibility, collaborator set, or issue policy: no rule of the form
 * "trust authors who are X" is available to it. What *is* available is a
 * content-structural rule — tracker content may **parameterise** a probe but may
 * never introduce executable code or a network destination:
 *
 * - **`command`** — refused unless both a command declaration (an exact `run`
 *   string or a test-file prefix) and the resolved `cwd` match for this repo.
 *   A prefix accepts only
 *   one plain relative `.test.ts` path, with no hidden or traversal segments or
 *   shell syntax. That test-file argument is a parameter, not new executable
 *   code: the file is code in the repository at the closed commit. The declared
 *   runner selects that existing code; tracker content cannot supply code.
 *   `cwd` is part of the match: a declared `bun test` executed in an attacker-chosen directory
 *   is a different command.
 * - **`url`** — refused unless the target host is declared. Ungated, a `url`
 *   probe is a blind SSRF oracle: the request issues from the closing machine
 *   and the receipt publishes the observed status back to a possibly
 *   world-readable tracker.
 * - **`git-ref-exists` / `git-merged-into` / `artifact-exists`** — ungated *by
 *   this registry*. They execute as argv with no shell and cause no egress, and
 *   the "local tree" half of that justification is enforced elsewhere: their
 *   `repo`/`path` fields are tracker content that resolves against the runner's
 *   base cwd, so an unconstrained one probes any directory on the closing
 *   machine and publishes the answer (#529, #582). Containment lives in the
 *   runner beside the call to {@link authorizeProbe} — see
 *   `authorizeProbeTree` in `work-graph-probes.ts` — because it is a question
 *   about *which tree*, which no per-repo declaration answers.
 *
 * The document lives in **soma-home, never the repo**: §1 clause 5 keeps
 * enforcement off the tree it guards, and a committed registry is writable by
 * any agent holding Write.
 *
 * The rule is **uniform**: nothing here reads a node's autonomy class, and the
 * gate sits in the runner rather than in any one caller, so an interactive
 * close, an `auto` close and the phase-2 headless tick are gated identically.
 * The registry answers *whose code this is*; headlessness changes who is
 * watching, not what is authorised.
 *
 * Everything here is **deny by default**. No document, an unparsable document, a
 * document with no entry for this repo — all refuse, and refusal is a *failed
 * probe* (`outcome: "fail"`), never an exception and never a skip, so the close
 * refuses through the path {@link assertClosable} already owns. That is the
 * spec's rule verbatim: a machine with no declaration refuses those closes.
 *
 * **Reading is not executing.** Nothing here is on the read path — `soma graph
 * node` and `soma graph frontier` read any node regardless, because a node is
 * data. Only the close path gates.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Probe, ProbeResult } from "./work-graph";
import { parseHostPath } from "./work-graph-ref";

/** Where the registry sits inside soma-home. */
export const PROBE_REGISTRY_RELATIVE_PATH = "policy/probe-registry.json";

/**
 * Every refusal `observed` string opens with this. It lets a caller tell a gate
 * refusal from a command that genuinely ran and failed without adding a field to
 * the `ProbeResult` wire shape §2.2 fixes.
 */
export const PROBE_REFUSED_PREFIX = "probe refused by the probe registry (DD-16 Amendment A):";

/** Only version this binary understands. An unknown version refuses rather than guessing. */
export const PROBE_REGISTRY_VERSION = 2;

/** Tracker-supplied strings are echoed into refusal messages; bound what an author can inject there. */
const ECHO_LIMIT = 200;

/** One authorised command in an absolute directory; exact bytes or one test-file parameter. */
export type DeclaredCommand =
  | { run: string; cwd: string }
  | { prefix: string; cwd: string; arg: "test-file" };

/**
 * The registry as this machine has it for one repo. Deliberately a union rather
 * than an optional bag: "no document", "unusable document" and "document with
 * nothing for this repo" all refuse, but they have different fixes, and the
 * refusal message has to say which one the adopter is looking at.
 */
export type ProbeRegistry =
  | {
      status: "loaded";
      repo: string;
      path: string;
      commands: readonly DeclaredCommand[];
      urlHosts: readonly string[];
    }
  | { status: "absent"; repo: string; path: string }
  | { status: "invalid"; repo: string; path: string; reason: string };

export type ProbeAuthorization = { allowed: true } | { allowed: false; reason: string };

export interface ProbeRegistryHomeOptions {
  homeDir?: string;
  somaHome?: string;
}

export interface LoadProbeRegistryOptions extends ProbeRegistryHomeOptions {
  repo: string;
  /** Resolves to `undefined` when the document does not exist. Injected for tests. */
  readFile?: (path: string) => Promise<string | undefined>;
}

export interface ParseProbeRegistryInput extends Pick<ProbeRegistryHomeOptions, "homeDir"> {
  repo: string;
  path: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function probeRegistryPath(options: ProbeRegistryHomeOptions = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  const somaHome = resolve(options.somaHome ?? join(home, ".soma"));
  return join(somaHome, PROBE_REGISTRY_RELATIVE_PATH);
}

async function defaultReadFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
}

/**
 * Read the registry for `repo`. Never throws: an unreadable document is an
 * `invalid` registry, which refuses, rather than an exception that a caller
 * might turn into a skipped probe.
 */
export async function loadProbeRegistry(options: LoadProbeRegistryOptions): Promise<ProbeRegistry> {
  const path = probeRegistryPath(options);
  const read = options.readFile ?? defaultReadFile;

  let raw: string | undefined;
  try {
    raw = await read(path);
  } catch (error) {
    return { status: "invalid", repo: options.repo, path, reason: `could not be read: ${describe(error)}` };
  }

  if (raw === undefined) return { status: "absent", repo: options.repo, path };
  return parseProbeRegistry({
    repo: options.repo,
    path,
    raw,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse and validate the whole document, not just the entry for `repo`.
 *
 * Validating only the matching entry would let a typo elsewhere pass unnoticed;
 * in an authorisation list a silently-ignored key is the bug that makes an
 * adopter believe something is declared when it is not. Whole-document
 * validation makes every mistake loud, and loud here still means closed.
 */
export function parseProbeRegistry(input: ParseProbeRegistryInput): ProbeRegistry {
  const wanted = normalizeRegistryRepoKey(input.repo);
  const parsed = parseRegistryDocument(input);
  if ("invalid" in parsed) return { status: "invalid", repo: input.repo, path: input.path, reason: parsed.invalid };
  if (wanted === undefined) {
    return { status: "invalid", repo: input.repo, path: input.path, reason: `requested repository ${JSON.stringify(input.repo)} is not a host-qualified key` };
  }

  const match = parsed.repos.get(wanted);
  return {
    status: "loaded",
    repo: input.repo,
    path: input.path,
    commands: match?.commands ?? [],
    urlHosts: match?.urlHosts ?? [],
  };
}

/** One declared command, tagged with the registry key of the repo that declares it. */
export type RegistryCommandEntry = DeclaredCommand & { repo: string };

/**
 * The whole document as a flat list, for `soma graph audit`: stale-entry
 * reporting has to see every repo's commands, which {@link ProbeRegistry}
 * deliberately narrows away. Never authorises anything; the close path does
 * not call it.
 */
export type ProbeRegistryEntries =
  | { status: "loaded"; path: string; commands: readonly RegistryCommandEntry[] }
  | { status: "absent"; path: string }
  | { status: "invalid"; path: string; reason: string };

export async function listProbeRegistryEntries(
  options: ProbeRegistryHomeOptions & Pick<LoadProbeRegistryOptions, "readFile"> = {},
): Promise<ProbeRegistryEntries> {
  const path = probeRegistryPath(options);
  const read = options.readFile ?? defaultReadFile;

  let raw: string | undefined;
  try {
    raw = await read(path);
  } catch (error) {
    return { status: "invalid", path, reason: `could not be read: ${describe(error)}` };
  }
  if (raw === undefined) return { status: "absent", path };

  const parsed = parseRegistryDocument({ path, raw, ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }) });
  if ("invalid" in parsed) return { status: "invalid", path, reason: parsed.invalid };
  return {
    status: "loaded",
    path,
    commands: [...parsed.repos].flatMap(([repo, entry]) => entry.commands.map((command) => ({ repo, ...command }))),
  };
}

function parseRegistryDocument(
  input: Pick<ParseProbeRegistryInput, "path" | "raw" | "homeDir">,
): { repos: Map<string, RepoEntry> } | { invalid: string } {
  let document: unknown;
  try {
    document = JSON.parse(input.raw) as unknown;
  } catch (error) {
    return { invalid: `is not valid JSON: ${describe(error)}` };
  }

  if (!isRecord(document)) return { invalid: "must be a JSON object" };

  const unknownKeys = Object.keys(document).filter((key) => key !== "version" && key !== "repos");
  if (unknownKeys.length > 0) {
    return { invalid: `has unknown top-level key(s): ${unknownKeys.join(", ")} — expected only "version" and "repos"` };
  }
  if (document.version === 1) {
    return {
      invalid: `uses registry version 1, whose host-less keys are no longer safe. Rewrite every repos key: prefix every key with "github.com/", then set "version" to ${PROBE_REGISTRY_VERSION}.`,
    };
  }
  if (document.version !== PROBE_REGISTRY_VERSION) {
    return { invalid: `must declare "version": ${PROBE_REGISTRY_VERSION} (found ${JSON.stringify(document.version)})` };
  }
  if (!isRecord(document.repos)) {
    return { invalid: `"repos" must be an object keyed by "host/path" (for example "github.com/owner/name")` };
  }

  const repos = new Map<string, RepoEntry>();

  for (const [key, value] of Object.entries(document.repos)) {
    const normalized = normalizeRegistryRepoKey(key);
    if (normalized === undefined) {
      return {
        invalid: `"repos" key ${JSON.stringify(key)} must be host-qualified as "host/path" (for example "github.com/owner/name"); bare owner/name keys are invalid`,
      };
    }
    if (repos.has(normalized)) {
      return { invalid: `"repos" declares ${normalized} more than once — repository keys are compared case-insensitively` };
    }

    const entry = parseRepoEntry(value, normalized, input.homeDir);
    if ("error" in entry) return { invalid: entry.error };
    repos.set(normalized, entry);
  }

  return { repos };
}

interface RepoEntry {
  commands: DeclaredCommand[];
  urlHosts: string[];
}

function parseRepoEntry(value: unknown, repo: string, homeDir: string | undefined): RepoEntry | { error: string } {
  if (!isRecord(value)) return { error: `repos["${repo}"] must be an object` };

  const unknownKeys = Object.keys(value).filter((key) => key !== "commands" && key !== "urlHosts");
  if (unknownKeys.length > 0) {
    return {
      error: `repos["${repo}"] has unknown key(s): ${unknownKeys.join(", ")} — expected only "commands" and "urlHosts"`,
    };
  }

  const commands: DeclaredCommand[] = [];
  if (value.commands !== undefined) {
    if (!Array.isArray(value.commands)) return { error: `repos["${repo}"].commands must be an array` };
    for (const [index, raw] of value.commands.entries()) {
      const parsed = parseDeclaredCommand(raw, repo, index, homeDir);
      if ("error" in parsed) return parsed;
      commands.push(parsed.command);
    }
  }

  const urlHosts: string[] = [];
  if (value.urlHosts !== undefined) {
    if (!Array.isArray(value.urlHosts)) return { error: `repos["${repo}"].urlHosts must be an array` };
    for (const [index, raw] of value.urlHosts.entries()) {
      const parsed = parseDeclaredHost(raw, repo, index);
      if ("error" in parsed) return parsed;
      urlHosts.push(parsed.host);
    }
  }

  return { commands, urlHosts };
}

function parseDeclaredCommand(
  raw: unknown,
  repo: string,
  index: number,
  homeDir: string | undefined,
): { command: DeclaredCommand } | { error: string } {
  const where = `repos["${repo}"].commands[${index}]`;
  if (!isRecord(raw)) return { error: `${where} must be an object with "run" and "cwd"` };

  const isPrefix = "prefix" in raw;
  const unknownKeys = Object.keys(raw).filter((key) =>
    isPrefix ? key !== "prefix" && key !== "cwd" && key !== "arg" : key !== "run" && key !== "cwd",
  );
  if (unknownKeys.length > 0) {
    return { error: `${where} has unknown key(s): ${unknownKeys.join(", ")} — expected only ${isPrefix ? '"prefix", "cwd" and "arg"' : '"run" and "cwd"'}` };
  }

  const { cwd } = raw;
  const command = isPrefix ? raw.prefix : raw.run;
  if (typeof command !== "string" || command.length === 0) {
    return { error: `${where}.${isPrefix ? "prefix" : "run"} must be a non-empty string` };
  }
  if (isPrefix && raw.arg !== "test-file") return { error: `${where}.arg must be "test-file"` };
  if (typeof cwd !== "string" || cwd.length === 0) return { error: `${where}.cwd must be a non-empty string` };

  const expanded = expandTilde(cwd, homeDir);
  if (!isAbsolute(expanded)) {
    // A relative declaration would authorise a *different* directory depending
    // on where the close was invoked from — which is the exact substitution
    // `cwd`-in-the-match exists to prevent.
    return { error: `${where}.cwd must be an absolute path (got ${JSON.stringify(cwd)})` };
  }

  return { command: isPrefix
    ? { prefix: command, cwd: resolve(expanded), arg: "test-file" }
    : { run: command, cwd: resolve(expanded) } };
}

function parseDeclaredHost(raw: unknown, repo: string, index: number): { host: string } | { error: string } {
  const where = `repos["${repo}"].urlHosts[${index}]`;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { error: `${where} must be a non-empty string` };
  }

  const host = raw.trim().toLowerCase();
  if (host.includes("*")) {
    // Rejected explicitly rather than left to never match: an adopter who writes
    // `*` means "any host", and a declaration that silently authorises nothing
    // reads as a working wildcard until a close mysteriously refuses.
    return { error: `${where} may not contain "*" — the host set is exact, with no wildcards` };
  }

  const normalized = normalizeHost(host);
  if (normalized === undefined || normalized !== host) {
    return {
      error: `${where} must be a bare hostname — no scheme, port, path, or credentials (got ${JSON.stringify(raw)})`,
    };
  }

  return { host: normalized };
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/**
 * The gate. `resolvedCwd` is the directory the runner would actually execute in
 * — already resolved against the runner's base cwd — because that, not the
 * literal `cwd` field on the node, is what the match has to be about.
 *
 * The switch is exhaustive on purpose: a probe type added later cannot inherit
 * "ungated" by omission, it has to be classified here (DD-16 Amendment A's
 * recorded limit — the three argv probes are ungated *because* they are argv and
 * read-only today).
 */
export function authorizeProbe(
  probe: Probe,
  resolvedCwd: string,
  registry: ProbeRegistry | undefined,
): ProbeAuthorization {
  switch (probe.type) {
    case "git-ref-exists":
    case "git-merged-into":
    case "artifact-exists":
      return { allowed: true };
    case "command":
      return authorizeCommand(probe.run, resolvedCwd, registry);
    case "url":
      return authorizeUrl(probe.target, registry);
  }
}

function authorizeCommand(run: string, resolvedCwd: string, registry: ProbeRegistry | undefined): ProbeAuthorization {
  const snippet = `{"run": ${JSON.stringify(abbreviate(run))}, "cwd": ${JSON.stringify(resolvedCwd)}}`;
  if (registry?.status !== "loaded") {
    return gateUnavailable(registry, "command", snippet);
  }

  const declared = registry.commands.some((entry) => matchesDeclaredCommand(entry, { run, cwd: resolvedCwd }));
  if (declared) return { allowed: true };

  return refuse(
    [
      `\`${abbreviate(run)}\` in ${resolvedCwd} is not declared for ${registry.repo}`,
      `(${registry.commands.length} command(s) declared in ${registry.path}).`,
      `The match requires the declared \`cwd\` and either exact \`run\` bytes or a declared prefix with one plain relative test-file argument. To allow it, add under repos["${registry.repo}"].commands:`,
      snippet,
    ].join("\n"),
  );
}

/** Shared by authorization and stale-entry audit so both apply the same command rule. */
export function matchesDeclaredCommand(entry: DeclaredCommand, probe: { run: string; cwd: string }): boolean {
  if (entry.cwd !== probe.cwd) return false;
  if ("run" in entry) return entry.run === probe.run;
  const start = `${entry.prefix} `;
  if (!probe.run.startsWith(start)) return false;
  const argument = probe.run.slice(start.length);
  return argument.endsWith(".test.ts")
    && /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.test\.ts$/.test(argument);
}

function authorizeUrl(target: string, registry: ProbeRegistry | undefined): ProbeAuthorization {
  if (registry?.status !== "loaded") {
    return gateUnavailable(registry, "url", undefined);
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return refuse(`target \`${abbreviate(target)}\` is not a parsable URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // Falls out of the host rule rather than extending it: a `file:` or `data:`
    // target has no host for a host set to authorise. Said explicitly because
    // "host `` is not declared" is a useless thing to read.
    return refuse(
      `target \`${abbreviate(target)}\` is not an http(s) URL — the registry declares hosts, and only http and https targets have one.`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (registry.urlHosts.includes(host)) return { allowed: true };

  return refuse(
    [
      `host \`${abbreviate(host)}\` is not declared for ${registry.repo}`,
      `(${registry.urlHosts.length} host(s) declared in ${registry.path}).`,
      `To allow it, add ${JSON.stringify(host)} under repos["${registry.repo}"].urlHosts.`,
    ].join("\n"),
  );
}

/** The registry states that refuse every gated probe, whatever the probe says. */
function gateUnavailable(
  registry: Exclude<ProbeRegistry, { status: "loaded" }> | undefined,
  probeType: "command" | "url",
  snippet: string | undefined,
): ProbeAuthorization {
  if (registry === undefined) {
    return refuse(`\`${probeType}\` probes are gated and the probe runner was given no registry.`);
  }

  if (registry.status === "absent") {
    return refuse(
      [
        `\`${probeType}\` probes are gated and no registry exists at ${registry.path}.`,
        `A machine with no declaration refuses these closes. Create the file for ${registry.repo}:`,
        renderStarterDocument(registry.repo, snippet),
      ].join("\n"),
    );
  }

  return refuse(
    [
      `the registry at ${registry.path} is unusable — it ${registry.reason}.`,
      `Every \`command\` and \`url\` probe is refused until the document parses.`,
    ].join("\n"),
  );
}

function renderStarterDocument(repo: string, commandSnippet: string | undefined): string {
  const commands = commandSnippet === undefined ? "" : `\n        ${commandSnippet}\n      `;
  return [
    `{`,
    `  "version": ${PROBE_REGISTRY_VERSION},`,
    `  "repos": {`,
    `    ${JSON.stringify(repo)}: {`,
    `      "commands": [${commands}],`,
    `      "urlHosts": []`,
    `    }`,
    `  }`,
    `}`,
  ].join("\n");
}

function refuse(reason: string): ProbeAuthorization {
  return { allowed: false, reason: `${PROBE_REFUSED_PREFIX} ${reason}` };
}

/**
 * Did this probe fail because the gate refused it, rather than because it ran
 * and failed? Callers need the distinction to point the adopter at the registry;
 * `assertClosable` deliberately does not, since both are simply "not passed".
 */
export function isProbeRefusal(result: ProbeResult): boolean {
  return result.state === "probed" && result.outcome === "fail" && result.observed.startsWith(PROBE_REFUSED_PREFIX);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRegistryRepoKey(repo: string): string | undefined {
  const parsed = parseHostPath(repo);
  return !parsed?.host.includes(".") ? undefined : `${parsed.host}/${parsed.path.toLowerCase()}`;
}

/** `example.com` → `example.com`; anything carrying a scheme, port, path or userinfo → `undefined`. */
function normalizeHost(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function expandTilde(path: string, homeDir: string | undefined): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  return join(resolve(homeDir ?? homedir()), path.slice(1));
}

/** Refusal messages quote tracker content; a node author does not get to choose how much. */
function abbreviate(text: string, limit = ECHO_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated — copy the exact value from the node block)`;
}

/**
 * The same bound, for the containment refusal in `work-graph-probes.ts`. Aliased
 * rather than re-spelled: both refusals echo a field the node author wrote, and
 * two limits would be two answers to one question.
 */
export { abbreviate as abbreviateTrackerEcho };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
