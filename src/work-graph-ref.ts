/**
 * Repo and node identity across forges (#536 D1).
 *
 * A work graph lives where its root lives, and the ref names that place: forge,
 * host, path. The forge word comes first because the ref selects the store
 * (#535 D1/D2) — a GitHub store never sees a GitLab ref, and nothing guesses a
 * forge from a host it has not classified.
 *
 * ```
 * github:github.com/the-metafactory/soma           repo (the --repo / SOMA_GRAPH_REPO form)
 * github:github.com/the-metafactory/soma#536       issue
 * gitlab:gitlab-int.switch.ch/csoc/soc-reporter#12 issue or task
 * gitlab:gitlab-int.switch.ch/csoc&5               epic (a GitLab graph root)
 * ```
 *
 * After the host comes the forge's own reference syntax — `#` for an issue,
 * `&` for an epic — which carries #534's `(namespace path, iid)` location.
 *
 * Pure: no I/O. Classifying a host and reading the origin remote live in
 * `work-graph-bridge.ts`.
 */

import { WorkGraphError } from "./work-graph";

export const FORGES = ["github", "gitlab"] as const;
export type Forge = (typeof FORGES)[number];

/** A repository (GitHub) or namespace path (GitLab) on one host of one forge. */
export interface RepoRef {
  forge: Forge;
  /** Lower-cased; hostnames are case-insensitive. No port — a forge's API is addressed by name. */
  host: string;
  /** `owner/name` on GitHub; `group/sub/project` (or a bare group, for an epic) on GitLab. */
  path: string;
}

/** A node named with its full location. `sigil` is `&` only for a GitLab epic. */
export interface QualifiedNodeRef {
  repo: RepoRef;
  sigil: "#" | "&";
  iid: number;
}

const FORGE_PREFIX = new RegExp(`^(${FORGES.join("|")}):`, "u");
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;

export const GITHUB_DOTCOM = "github.com";

/** True when the text starts with a forge word — the only thing that makes a ref qualified. */
export function isQualifiedRef(text: string): boolean {
  return FORGE_PREFIX.test(text.trim());
}

function refError(text: string, why: string): WorkGraphError {
  return new WorkGraphError(
    "invalid-node",
    `"${text}" is not a work-graph ref: ${why}. Expected <forge>:<host>/<path>, e.g. github:github.com/owner/name or gitlab:gitlab.example.com/group/project.`,
  );
}

/**
 * The one rule for what a path is, shared by the ref grammar and the remote
 * parser so the two cannot drift: `/`-separated segments that each start with a
 * word character — so `.`, `..` and dot-prefixed names never reach a URL or a
 * registry key — and at least `minDepth` of them.
 */
function validPath(path: string, minDepth: number): string | undefined {
  const segments = path.split("/");
  if (segments.length < minDepth || segments.some((segment) => !SEGMENT.test(segment))) return undefined;
  return segments.join("/");
}

function parsePath(text: string, path: string): string {
  const valid = validPath(path, 1);
  if (valid === undefined) throw refError(text, `path "${path}" has an empty or malformed segment`);
  return valid;
}

/** GitHub repos are exactly `owner/name`; GitLab namespaces nest arbitrarily. */
function checkForgePath(text: string, repo: RepoRef): RepoRef {
  const depth = repo.path.split("/").length;
  if (repo.forge === "github" && depth !== 2) {
    throw refError(text, `a GitHub path is owner/name, got "${repo.path}"`);
  }
  return repo;
}

function splitHostAndPath(text: string, rest: string): { host: string; path: string } {
  const slash = rest.indexOf("/");
  if (slash <= 0) throw refError(text, "no host/path after the forge");
  const host = rest.slice(0, slash).toLowerCase();
  if (!HOST.test(host)) throw refError(text, `"${host}" is not a hostname`);
  return { host, path: parsePath(text, rest.slice(slash + 1)) };
}

/** Parse a qualified repo ref (`forge:host/path`). Refuses anything without the forge word. */
export function parseRepoRef(text: string): RepoRef {
  const trimmed = text.trim();
  const forge = FORGE_PREFIX.exec(trimmed)?.[1] as Forge | undefined;
  if (forge === undefined) throw refError(trimmed, "it names no forge");
  const { host, path } = splitHostAndPath(trimmed, trimmed.slice(forge.length + 1));
  return checkForgePath(trimmed, { forge, host, path });
}

/**
 * Check a `RepoRef` assembled from parts (a remote's host, a bare `--repo` path)
 * by the same rules {@link parseRepoRef} applies to a string: a hostname, a
 * well-formed path, and `owner/name` depth on GitHub.
 */
export function validateRepoRef(repo: RepoRef): RepoRef {
  const text = formatRepoRef(repo);
  const host = repo.host.toLowerCase();
  if (!HOST.test(host)) throw refError(text, `"${repo.host}" is not a hostname`);
  return checkForgePath(text, { forge: repo.forge, host, path: parsePath(text, repo.path) });
}

/** The canonical string form: what `--repo` and `SOMA_GRAPH_REPO` take. */
export function formatRepoRef(repo: RepoRef): string {
  return `${repo.forge}:${repo.host}/${repo.path}`;
}

/** Parse a qualified node ref (`forge:host/path#N` or, on GitLab, `forge:host/group&N`). */
export function parseQualifiedNodeRef(text: string): QualifiedNodeRef {
  const trimmed = text.trim();
  const match = /^(.*)([#&])([1-9]\d*)$/u.exec(trimmed);
  if (match === null) throw refError(trimmed, "a node ref ends in #<number> (or &<number> for a GitLab epic)");
  const repo = parseRepoRef(match[1]);
  const sigil = match[2] as "#" | "&";
  if (sigil === "&" && repo.forge !== "gitlab") throw refError(trimmed, "only GitLab has epics (&N)");
  return { repo, sigil, iid: Number(match[3]) };
}

export function formatQualifiedNodeRef(ref: QualifiedNodeRef): string {
  return `${formatRepoRef(ref.repo)}${ref.sigil}${ref.iid}`;
}

/**
 * Whether two repo refs open the same store. A GitHub store is one repository;
 * a GitLab store is one host, because an epic lives in a group and its nodes in
 * the group's projects (#534 D1) — one project path cannot scope it.
 */
export function sameStore(a: RepoRef, b: RepoRef): boolean {
  if (a.forge !== b.forge || a.host !== b.host) return false;
  return a.forge === "gitlab" || a.path.toLowerCase() === b.path.toLowerCase();
}

/**
 * The id a store's {@link NodeRef} carries for a qualified node. GitHub ids stay
 * the bare issue number. GitLab ids carry their location (`csoc/reporter#12`,
 * `csoc&5`), since iids repeat across projects and a host-scoped store cannot
 * tell `#12` in one project from `#12` in another.
 */
export function storeNodeId(ref: QualifiedNodeRef): string {
  return ref.repo.forge === "github" ? String(ref.iid) : `${ref.repo.path}${ref.sigil}${ref.iid}`;
}

/**
 * How a repo is named in human-facing output. github.com repos print as
 * `owner/name`, exactly as before there was a second forge; every other host
 * prints qualified, since a bare path there would not say where it lives.
 */
export function displayRepo(repo: RepoRef): string {
  return isGitHubDotcom(repo) ? repo.path : formatRepoRef(repo);
}

/** A repo on github.com itself — the one host a host-less name ever meant. */
export function isGitHubDotcom(repo: RepoRef): boolean {
  return repo.forge === "github" && repo.host === GITHUB_DOTCOM;
}

/** Where a git remote points: host and full path, forge still unknown. */
export interface RemoteLocation {
  host: string;
  path: string;
}

const URL_SCHEMES = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"]);

function cleanRemotePath(path: string): string | undefined {
  return validPath(path.replace(/^\/+/u, "").replace(/\/+$/u, "").replace(/\.git$/u, ""), 2);
}

/**
 * Host and path out of any shape a git remote takes (#536): scp-style SSH
 * (`git@host:a/b/c.git`), `ssh://git@host:2222/a/b.git`, and http(s), with
 * arbitrarily nested paths. The forge is **not** decided here — `github.com`
 * resolves directly and any other host is probed (#535 D6).
 *
 * Credentials embedded in an https remote are dropped with the rest of the
 * userinfo: only host and path come out. Returns undefined for anything that is
 * not a two-or-more-segment path on a named host, including local paths.
 */
export function parseRemoteUrl(remote: string): RemoteLocation | undefined {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return undefined;

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!URL_SCHEMES.has(url.protocol)) return undefined;
    const host = url.hostname.toLowerCase();
    if (!HOST.test(host)) return undefined;
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // A malformed %-escape is not a remote this parser can name.
      return undefined;
    }
    const path = cleanRemotePath(pathname);
    return path === undefined ? undefined : { host, path };
  }

  // scp-like: [user@]host:path — the colon must not start a `//`, and a
  // one-letter "host" is a Windows drive, not a machine.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/u.exec(trimmed);
  if (scp === null) return undefined;
  const host = scp[1].toLowerCase();
  if (host.length < 2 || !HOST.test(host)) return undefined;
  const path = cleanRemotePath(scp[2]);
  return path === undefined ? undefined : { host, path };
}
