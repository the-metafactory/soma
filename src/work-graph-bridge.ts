/**
 * The work graph's **read seam for non-graph consumers** — today the planSteps
 * bridge (`docs/work-graph.md` §2.7), which needs to read a node without owning
 * a `GraphStore` or knowing how a repo is resolved.
 *
 * It lives in core rather than in `src/cli/`, where it started: the bridge's own
 * argument is that a second reader means a second answer to "which node backs
 * this step", and a seam only the CLI can import forces a library, MCP or daemon
 * consumer — every one of which can already reach the *write* half through
 * `src/index.ts` — to re-implement repo resolution and become exactly that second
 * reader.
 *
 * It is also where a ref turns into a store (#535 D1): the ref names forge, host
 * and path, and {@link createGraphStore} builds the backend that forge needs.
 */
import { WorkGraph, WorkGraphError } from "./work-graph";
import type { BridgedNodeReport, GraphStore } from "./work-graph";
import { createGitHubGraphStore } from "./work-graph-github";
import { runCommand, type CommandRequest } from "./work-graph-probes";
import { invocationCwd } from "./path-utils";
import {
  GITHUB_DOTCOM,
  isGitHubDotcom,
  formatQualifiedNodeRef,
  formatRepoRef,
  isQualifiedRef,
  parseQualifiedNodeRef,
  parseRemoteUrl,
  parseRepoRef,
  sameStore,
  storeNodeId,
  validateRepoRef,
  type Forge,
  type RemoteLocation,
  type RepoRef,
} from "./work-graph-ref";

/**
 * Wall-clock cap on the host probe: a host that does not answer is
 * unclassified, not slow. A live GitLab answers the version endpoint in well
 * under a second, so this bounds the stall a dead host costs every command.
 */
const HOST_PROBE_TIMEOUT_MS = 5_000;

/** The two answers GitLab gives `/api/v4/version`: anonymous (401) and authenticated (200). */
const GITLAB_VERSION_STATUSES = new Set([200, 401]);

export type FetchLike = (url: string, init: { method: string; redirect: "manual"; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Which forge a host runs (#535 D6). `github.com` is GitHub without asking. Any
 * other host is asked `GET /api/v4/version`: GitLab answers it — with the
 * version when authenticated, and with a 401 carrying its `X-Gitlab-Meta`
 * header when not, which is how `gitlab-int.switch.ch` answers an anonymous
 * probe. Either is GitLab speaking.
 *
 * Anything else — any other status even with the header (a redirect, a 404, a
 * 5xx from whatever sits in front), a network failure, a timeout, a body that
 * is not GitLab's — is **undefined**, and the caller refuses (#536 D4). Nothing
 * here assumes GitHub Enterprise: a GHES user names the forge in the ref.
 */
export async function classifyHost(host: string, fetchImpl: FetchLike = fetch): Promise<Forge | undefined> {
  if (host === GITHUB_DOTCOM) return "github";
  try {
    const response = await fetchImpl(`https://${host}/api/v4/version`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS),
    });
    if (!GITLAB_VERSION_STATUSES.has(response.status)) return undefined;
    if (response.headers.get("x-gitlab-meta") !== null) return "gitlab";
    if (response.status !== 200) return undefined;
    const body = JSON.parse(await response.text()) as unknown;
    const version = typeof body === "object" && body !== null ? (body as Record<string, unknown>).version : undefined;
    return typeof version === "string" && version.length > 0 ? "gitlab" : undefined;
  } catch {
    return undefined;
  }
}

export interface RepoResolutionDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** `git remote get-url origin` in the invocation tree, or undefined when there is none. */
  originRemote: () => Promise<string | undefined>;
  classifyHost: (host: string) => Promise<Forge | undefined>;
}

/**
 * Read in the **invocation** tree, not the process's. The installed launcher
 * `cd`s into soma's own install tree before exec (#662), so a bare `git remote`
 * there answers "soma on github.com" from inside any checkout — harmless while
 * every store was GitHub, and wrong the moment the remote picks the forge
 * (#535 D4): `soma graph node 12` in a GitLab checkout would read soma#12.
 */
export function originRemoteRequest(env: Readonly<Record<string, string | undefined>> = process.env): CommandRequest {
  return { argv: ["git", "remote", "get-url", "origin"], timeoutSec: 30, cwd: invocationCwd(env) };
}

async function defaultOriginRemote(): Promise<string | undefined> {
  const remote = await runCommand(originRemoteRequest());
  return remote.exitCode === 0 ? remote.stdout.trim() : undefined;
}

function defaultResolutionDeps(): RepoResolutionDeps {
  return { env: process.env, originRemote: defaultOriginRemote, classifyHost: async (host) => await classifyHost(host) };
}

const QUALIFIED_HINT = "Pass --repo <forge>:<host>/<path> (e.g. github:github.com/owner/name) or set SOMA_GRAPH_REPO.";

async function classifyOrRefuse(location: RemoteLocation, deps: RepoResolutionDeps): Promise<RepoRef> {
  const forge = await deps.classifyHost(location.host);
  if (forge === undefined) {
    throw new WorkGraphError(
      "backend",
      `Cannot tell which forge ${location.host} runs: it is not github.com, and it did not answer GET /api/v4/version as GitLab. ` +
        `soma never assumes GitHub Enterprise. If it is GitLab, pass --repo gitlab:${location.host}/${location.path}.`,
    );
  }
  return validateRepoRef({ forge, host: location.host, path: location.path });
}

/**
 * Which store backs this graph. One implementation on purpose: the probe
 * registry is scoped by repo identity, so `soma policy probes` has to resolve it
 * the same way `soma graph` does — two answers to "which repo" would mean an
 * adopter declaring commands under a key the close path never looks at.
 *
 * Order: `explicit` (the `--repo` flag), then `SOMA_GRAPH_REPO`, then the origin
 * remote. A qualified ref is taken as written. A bare `owner/name` is qualified
 * through the origin remote's host (#536): it is never looked up host-less, and
 * with no origin remote to lend a host it refuses rather than defaulting to
 * github.com.
 */
export async function resolveGraphRepo(explicit?: string, deps: RepoResolutionDeps = defaultResolutionDeps()): Promise<RepoRef> {
  const configured = [explicit, deps.env.SOMA_GRAPH_REPO].map((value) => value?.trim()).find((value) => value !== undefined && value.length > 0);
  if (configured !== undefined && isQualifiedRef(configured)) return parseRepoRef(configured);

  const remoteText = await deps.originRemote();
  const remote = remoteText === undefined ? undefined : parseRemoteUrl(remoteText);

  if (configured !== undefined) {
    if (remote === undefined) {
      throw new WorkGraphError(
        "backend",
        `"${configured}" names no forge or host, and there is no origin remote to take them from. ${QUALIFIED_HINT}`,
      );
    }
    return await classifyOrRefuse({ host: remote.host, path: configured }, deps);
  }

  if (remote === undefined) {
    throw new WorkGraphError("backend", `Cannot tell which repository backs this graph. ${QUALIFIED_HINT}`);
  }
  return await classifyOrRefuse(remote, deps);
}

/**
 * The probe-registry key for a repo. Registry v1 keys are host-less `owner/name`,
 * which can only ever have meant github.com — so that is the only host this
 * resolves for. Any other host refuses rather than look up its path host-less,
 * where a `csoc/reporter` declared for GitHub would authorise closes on the
 * GitLab project of the same path (#536 D2). Host-qualified keys are registry v2.
 */
export function probeRegistryKey(repo: RepoRef): string {
  if (isGitHubDotcom(repo)) return repo.path;
  throw new WorkGraphError(
    "backend",
    `The probe registry keys repos without a host, so it can only authorise github.com repos; ${formatRepoRef(repo)} is not one.`,
  );
}

/**
 * The store for a ref (#535 D1). The forge in the ref decides, so a GitHub store
 * never opens a GitLab graph. The GitLab backend is not built yet (#539's slice 3);
 * until it is, a GitLab ref refuses here rather than being read by the wrong store.
 *
 * **A GitHub store opens on github.com only.** A ref's host is caller- and
 * tracker-supplied text, and `gh --hostname <host>` hands any non-github.com
 * host the session's `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` — so a
 * `github:attacker.example/x/y#1` pasted from an issue body would ship that
 * token to the attacker's `/api/v3`. GitHub Enterprise needs an explicit
 * allow-list of hosts the adopter vouches for, which nothing declares yet;
 * until one exists, every other GitHub host refuses here, before any `gh` runs.
 */
export function createGraphStore(repo: RepoRef): GraphStore {
  switch (repo.forge) {
    case "github":
      if (!isGitHubDotcom(repo)) {
        throw new WorkGraphError(
          "backend",
          `${formatRepoRef(repo)} names a GitHub Enterprise host. soma opens GitHub stores on github.com only until GHES hosts have an allow-list: a ref's host is untrusted text, and gh would send it the enterprise token.`,
        );
      }
      return createGitHubGraphStore({ repo: repo.path, host: repo.host });
    case "gitlab":
      throw new WorkGraphError(
        "backend",
        `${formatRepoRef(repo)} is a GitLab store, and this soma has no GitLab work-graph backend yet.`,
      );
  }
}

/**
 * A node named in full, reduced to the id its store reads — refusing one that
 * lives in a different store from `repo`. An edge or a target cannot cross
 * stores: each backend is the sole authority for its own topology (#491). A
 * bare id passes through unchanged.
 */
export function localNodeId(text: string, repo: RepoRef): string {
  if (!isQualifiedRef(text)) {
    // A GitLab store is host-scoped and its ids carry their project
    // (`storeNodeId`), so a bare `12` or `#12` is read in the repo's own path —
    // one id shape per store, whichever way the node was named.
    const bare = /^#?([1-9]\d*)$/u.exec(text.trim());
    return repo.forge === "gitlab" && bare !== null ? `${repo.path}#${bare[1]}` : text;
  }
  const qualified = parseQualifiedNodeRef(text);
  if (!sameStore(qualified.repo, repo)) {
    throw new WorkGraphError(
      "invalid-node",
      `${text} lives in ${formatRepoRef(qualified.repo)}, not in this graph's store (${formatRepoRef(repo)}). A work graph never spans two stores.`,
    );
  }
  return storeNodeId(qualified);
}

/**
 * Which store a node target opens, and the id that store reads (#535 D1). The
 * one path from "what the caller typed" to "which store, which id" — the graph
 * verbs and {@link readNodeForBridge} both come through here, so a qualified
 * step node id and a qualified verb target cannot resolve differently.
 *
 * - A qualified target names its own store. An explicit `--repo` must agree
 *   with it or the target refuses; a bare `--repo` path is read on the
 *   target's forge and host, never through the origin remote, since the target
 *   already says where it lives.
 * - A bare target resolves the repo through `resolveRepo` as it always has.
 */
export async function resolveNodeTarget(
  target: string,
  explicitRepo: string | undefined,
  resolveRepo: (explicit?: string) => Promise<RepoRef> = resolveGraphRepo,
): Promise<{ repo: RepoRef; id: string }> {
  if (!isQualifiedRef(target)) {
    const repo = await resolveRepo(explicitRepo);
    return { repo, id: localNodeId(target, repo) };
  }
  const named = parseQualifiedNodeRef(target).repo;
  const explicit = explicitRepo?.trim();
  const repo =
    explicit === undefined || explicit.length === 0
      ? named
      : isQualifiedRef(explicit)
        ? parseRepoRef(explicit)
        : validateRepoRef({ forge: named.forge, host: named.host, path: explicit });
  return { repo, id: localNodeId(target, repo) };
}

export interface ReadNodeForBridgeOptions {
  /**
   * Explicit `--repo` value: a qualified ref, or a bare `owner/name` that takes
   * the origin remote's host. See {@link resolveNodeTarget}.
   */
  repo?: string;
  /** Injectable so a consumer can supply its own backend or a test double. */
  createStore?: (repo: RepoRef) => GraphStore;
  resolveRepo?: (explicit?: string) => Promise<RepoRef>;
}

/**
 * Read one node for a bridge consumer — the same `WorkGraph.readNode` the
 * `soma graph node` verb calls, over the same target resolution
 * ({@link resolveNodeTarget}), so a qualified step node id opens its own store.
 */
export async function readNodeForBridge(nodeId: string, options: ReadNodeForBridgeOptions = {}): Promise<BridgedNodeReport> {
  const createStore = options.createStore ?? createGraphStore;
  const { repo, id } = await resolveNodeTarget(nodeId, options.repo, options.resolveRepo);
  const store = createStore(repo);
  const state = await new WorkGraph(store).readNode({ id });
  // A qualified target is reported back qualified (canonical form), because the
  // consumer *stores* this id: a step bound to `github:…/arc#498` that kept only
  // `498` would, on its next sync, resolve through the origin remote and read a
  // different repo's #498 without complaint. The location has to survive the
  // round trip, so the next read takes the qualified path again.
  const ref = isQualifiedRef(nodeId) ? { id: formatQualifiedNodeRef(parseQualifiedNodeRef(nodeId)) } : state.ref;
  // The production GraphStore binds this to the current tracker close; bridge
  // consumers never inspect comments and therefore cannot bless stale receipts.
  return { ref, status: state.status, blockedBy: state.blockedBy, hasCloseReceipt: state.currentCloseReceipt === true };
}
