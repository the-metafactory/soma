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
 * - **`command`** — refused unless the exact `run` string **and** the resolved
 *   `cwd` are declared for this repo. `cwd` is part of the match, not
 *   incidental: a declared `bun test` executed in an attacker-chosen directory
 *   is a different command.
 * - **`url`** — refused unless the target host is declared. Ungated, a `url`
 *   probe is a blind SSRF oracle: the request issues from the closing machine
 *   and the receipt publishes the observed status back to a possibly
 *   world-readable tracker.
 * - **`git-ref-exists` / `git-merged-into` / `artifact-exists`** — ungated. They
 *   execute as argv with no shell, cause no egress, and are bounded to existence
 *   checks in a local tree.
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

/** Where the registry sits inside soma-home. */
export const PROBE_REGISTRY_RELATIVE_PATH = "policy/probe-registry.json";

/**
 * Every refusal `observed` string opens with this. It lets a caller tell a gate
 * refusal from a command that genuinely ran and failed without adding a field to
 * the `ProbeResult` wire shape §2.2 fixes.
 */
export const PROBE_REFUSED_PREFIX = "probe refused by the probe registry (DD-16 Amendment A):";

/** Only version this binary understands. An unknown version refuses rather than guessing. */
export const PROBE_REGISTRY_VERSION = 1;

/** Tracker-supplied strings are echoed into refusal messages; bound what an author can inject there. */
const ECHO_LIMIT = 200;

/** One authorised command. Both halves must match a probe exactly for it to run. */
export interface DeclaredCommand {
  /** The `run` string a probe must carry, byte for byte. */
  run: string;
  /** Absolute directory the command is authorised to run in. */
  cwd: string;
}

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
  const invalid = (reason: string): ProbeRegistry => ({
    status: "invalid",
    repo: input.repo,
    path: input.path,
    reason,
  });

  let document: unknown;
  try {
    document = JSON.parse(input.raw) as unknown;
  } catch (error) {
    return invalid(`is not valid JSON: ${describe(error)}`);
  }

  if (!isRecord(document)) return invalid("must be a JSON object");

  const unknownKeys = Object.keys(document).filter((key) => key !== "version" && key !== "repos");
  if (unknownKeys.length > 0) {
    return invalid(`has unknown top-level key(s): ${unknownKeys.join(", ")} — expected only "version" and "repos"`);
  }
  if (document.version !== PROBE_REGISTRY_VERSION) {
    return invalid(`must declare "version": ${PROBE_REGISTRY_VERSION} (found ${JSON.stringify(document.version)})`);
  }
  if (!isRecord(document.repos)) {
    return invalid(`"repos" must be an object keyed by "owner/name"`);
  }

  const wanted = normalizeRepo(input.repo);
  const seen = new Set<string>();
  let match: RepoEntry | undefined;

  for (const [key, value] of Object.entries(document.repos)) {
    const normalized = normalizeRepo(key);
    if (normalized.length === 0) return invalid(`"repos" has an empty repository key`);
    if (seen.has(normalized)) {
      return invalid(`"repos" declares ${normalized} more than once — repository keys are compared case-insensitively`);
    }
    seen.add(normalized);

    const entry = parseRepoEntry(value, normalized, input.homeDir);
    if ("error" in entry) return invalid(entry.error);
    if (normalized === wanted) match = entry;
  }

  return {
    status: "loaded",
    repo: input.repo,
    path: input.path,
    commands: match?.commands ?? [],
    urlHosts: match?.urlHosts ?? [],
  };
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

  const unknownKeys = Object.keys(raw).filter((key) => key !== "run" && key !== "cwd");
  if (unknownKeys.length > 0) {
    return { error: `${where} has unknown key(s): ${unknownKeys.join(", ")} — expected only "run" and "cwd"` };
  }

  const { run, cwd } = raw;
  if (typeof run !== "string" || run.length === 0) return { error: `${where}.run must be a non-empty string` };
  if (typeof cwd !== "string" || cwd.length === 0) return { error: `${where}.cwd must be a non-empty string` };

  const expanded = expandTilde(cwd, homeDir);
  if (!isAbsolute(expanded)) {
    // A relative declaration would authorise a *different* directory depending
    // on where the close was invoked from — which is the exact substitution
    // `cwd`-in-the-match exists to prevent.
    return { error: `${where}.cwd must be an absolute path (got ${JSON.stringify(cwd)})` };
  }

  return { command: { run, cwd: resolve(expanded) } };
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

  const declared = registry.commands.some((entry) => entry.run === run && entry.cwd === resolvedCwd);
  if (declared) return { allowed: true };

  return refuse(
    [
      `\`${abbreviate(run)}\` in ${resolvedCwd} is not declared for ${registry.repo}`,
      `(${registry.commands.length} command(s) declared in ${registry.path}).`,
      `The match is exact on both \`run\` and \`cwd\`. To allow it, add under repos["${registry.repo}"].commands:`,
      snippet,
    ].join("\n"),
  );
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

function normalizeRepo(repo: string): string {
  return repo.trim().toLowerCase();
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
