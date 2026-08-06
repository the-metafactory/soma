/**
 * Attestation derivation for close receipts (`docs/work-graph.md` §3.2, #502/#498).
 *
 * `attestation` is **derived at close time, never configured**. There is no flag
 * and no provisioning step that turns verification on: an adopter with real
 * credential isolation gets `verified` automatically, one without gets honest
 * `unverified` forever, and neither configures anything.
 *
 * `verified` asserts a *trust* claim — a human the agent cannot impersonate
 * ratified this — not merely that two logins appear. All four conjuncts must
 * hold; any failure yields `unverified`. It is a **label, not a gate**: `close`
 * proceeds either way, because refusing on `unverified` would deadlock the
 * bootstrap (the nodes that establish credential separation are themselves
 * `approve`-class, so they could never close).
 *
 * On conjunct 2, read §3.2's honest limits before trusting it: it runs inside
 * the environment it judges, so §1 clause 5 does not hold for it. It catches the
 * honest-but-unisolated deployment automatically — today's case, and every
 * adopter's until they isolate — and buys nothing against a session that sets
 * out to shim it. Necessary, never sufficient: it may lower `attestation`, and
 * it may not, on its own, raise it.
 */

import type {
  AttestationCapability,
  AttestationFacts,
  AttestationState,
  ConfinementProbeRecord,
  NodeRef,
  NodeState,
} from "./work-graph";
import type { CommandOutcome, CommandRequest } from "./work-graph-probes";

/** Credential-bearing environment variables the confinement check must strip before probing. */
const TOKEN_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** Depth cap on the root walk — a graph deeper than this is malformed, not deep. */
const MAX_ROOT_WALK = 64;

export interface ConfinementResult {
  checked: boolean;
  /** Every GitHub identity the session could reach with the token env stripped. */
  reachableIdentities: string[];
  at: string;
  probes: ConfinementProbeRecord[];
}

export interface ConfinementDeps {
  runCommand: (request: CommandRequest) => Promise<CommandOutcome>;
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  now: () => Date;
}

/** Strip the token env: conjunct 2 asks what the session can *reach*, not which identity `gh` prefers. */
function envWithoutTokens(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((TOKEN_ENV_KEYS as readonly string[]).includes(key)) continue;
    stripped[key] = value;
  }
  return stripped;
}

/**
 * Logins `gh auth status` reports. Both output shapes are matched — `account
 * <login>` (current) and `as <login>` (older) — because a parser that silently
 * matches neither reports an empty reachable set, which reads as *isolated* and
 * would raise attestation on a parse failure.
 */
export function parseAuthStatusLogins(output: string): string[] {
  const logins = new Set<string>();
  for (const match of output.matchAll(/(?:account|as)\s+([A-Za-z0-9][A-Za-z0-9-]*)/gu)) {
    logins.add(match[1]);
  }
  return [...logins].sort();
}

/**
 * Run the confinement probe set with the token env stripped: `gh auth status`,
 * `gh auth token`, and (on darwin) a direct read of the `gh` keychain item —
 * the three ways #496's own probe script reached the principal's credential.
 */
export async function checkConfinement(deps: ConfinementDeps): Promise<ConfinementResult> {
  const env = envWithoutTokens(deps.env);
  const at = deps.now().toISOString();
  const probes: ConfinementProbeRecord[] = [];
  const reachable = new Set<string>();

  const status = await deps.runCommand({ argv: ["gh", "auth", "status"], timeoutSec: 30, env });
  const statusOutput = `${status.stdout}\n${status.stderr}`;
  const logins = parseAuthStatusLogins(statusOutput);
  for (const login of logins) reachable.add(login);
  probes.push({
    name: "gh auth status (token env stripped)",
    observed: `exit ${status.exitCode}; identities: ${logins.length > 0 ? logins.join(", ") : "none"}`,
  });

  const token = await deps.runCommand({ argv: ["gh", "auth", "token"], timeoutSec: 30, env });
  const tokenReachable = token.exitCode === 0 && token.stdout.trim().length > 0;
  if (tokenReachable && logins.length === 0) {
    // A credential is reachable but unnamed — it still counts, and it must not
    // be swallowed just because the status parse came back empty.
    reachable.add("unidentified-credential");
  }
  probes.push({
    name: "gh auth token (token env stripped)",
    observed: tokenReachable ? "printed a credential" : `refused (exit ${token.exitCode})`,
  });

  if (deps.platform === "darwin") {
    const keychain = await deps.runCommand({
      argv: ["security", "find-generic-password", "-s", "gh:github.com"],
      timeoutSec: 30,
      env,
    });
    const keychainReachable = keychain.exitCode === 0;
    if (keychainReachable) reachable.add("keychain:gh:github.com");
    probes.push({
      name: "security find-generic-password -s gh:github.com",
      observed: keychainReachable ? "keychain item readable" : `refused (exit ${keychain.exitCode})`,
    });
  }

  return { checked: true, reachableIdentities: [...reachable].sort(), at, probes };
}

export interface AttestationInputs {
  /** Conjunct 1 — {@link GraphStore.attestation}, the backend's capability. */
  backendCapability: AttestationCapability;
  /** The identity this session acts as; both the confinement baseline and the disqualifier for conjunct 4. */
  actingIdentity: string;
  confinement?: ConfinementResult;
  proposal?: { commentId: string; author: string };
  ratification?: { kind: "reaction" | "comment"; id: string; author: string };
  root?: { nodeId: string; author: string };
  /**
   * True when soma-home declares this machine has one operator
   * (`policy/graph-posture.json`). Never derived — see `work-graph-posture.ts`
   * for why the two attempts to derive it failed.
   */
  singleOperatorDeclared?: boolean;
}

export interface AttestationOutcome {
  attestation: AttestationState;
  facts: AttestationFacts;
}

/**
 * The four conjuncts of §3.2, evaluated together so the receipt can record every
 * failure rather than the first one — a reader fixing a wrong ratifier needs to
 * know the keyring is also reachable.
 */
export function deriveAttestation(inputs: AttestationInputs): AttestationOutcome {
  const reasons: string[] = [];

  if (inputs.backendCapability !== "verifiable") {
    reasons.push(`backend cannot attest (capability: ${inputs.backendCapability})`);
  }

  const confinement = inputs.confinement;
  if (confinement?.checked !== true) {
    reasons.push("confinement was not checked — a session whose credential topology is unknown is not isolated");
  } else {
    const foreign = confinement.reachableIdentities.filter((identity) => identity !== inputs.actingIdentity);
    if (foreign.length > 0) {
      reasons.push(`credentials other than ${inputs.actingIdentity} are reachable from this session: ${foreign.join(", ")}`);
    }
  }

  const { proposal, ratification, root } = inputs;
  const proposer = proposal?.author;
  const ratifier = ratification?.author;

  if (ratifier === undefined) {
    reasons.push("no ratification found — nothing was attested by a second credential");
  }
  if (proposer === undefined) {
    reasons.push("no proposal comment recorded — there is nothing for a ratification to bind to");
  }
  if (proposer !== undefined && proposer === ratifier) {
    reasons.push(`proposal and ratification share an author (${proposer}) — one credential, not two`);
  }

  if (root === undefined) {
    reasons.push("graph root unreachable — cannot tell who is authorized to ratify");
  } else {
    if (root.author === inputs.actingIdentity) {
      reasons.push(`graph root ${root.nodeId} is authored by the acting identity (${inputs.actingIdentity})`);
    }
    if (ratifier !== undefined && ratifier !== root.author) {
      reasons.push(`ratifier ${ratifier} is not the author of graph root ${root.nodeId} (${root.author})`);
    }
  }

  const facts: AttestationFacts = {
    backendCapability: inputs.backendCapability,
    ...(confinement === undefined
      ? {}
      : {
          confinement: {
            checked: confinement.checked,
            reachableIdentities: confinement.reachableIdentities,
            at: confinement.at,
            probes: confinement.probes,
          },
        }),
    ...(proposal === undefined ? {} : { proposal }),
    ...(ratification === undefined ? {} : { ratification }),
    ...(root === undefined ? {} : { root }),
    ...(reasons.length === 0 ? {} : { reasons }),
  };

  if (reasons.length === 0) return { attestation: "verified", facts };

  // A declared single-operator machine, where that operator ratified their own
  // proposal on their own map, is a *known* state rather than an unknown one.
  // `unverified` conflates "a second credential was reachable", "the wrong
  // person approved" and "nobody approved at all" — none of which happened here,
  // and reporting them alike loses the distinction a reader needs.
  //
  // Stated as what must hold, not as "which reasons are absent". Two of the
  // reasons above are *expected* on such a machine and must not disqualify it:
  // the operator's own keyring is reachable (there is no second human whose
  // credential conjunct 2 could be protecting against), and the operator authored
  // the map (there is nobody else to have authored it). Keying on their absence
  // would mean this label never fires on the deployment it exists for.
  //
  // What must still hold is everything that would signal a *different* failure:
  // a backend that can attest at all, a proposal that exists, a ratification
  // that exists, and a ratifier who is both the proposer and the map's owner —
  // i.e. the declared operator, not a passer-by.
  //
  // This never becomes `verified` by any route. One person approving their own
  // work is a weaker claim than §3.2's four conjuncts, and the label says so.
  const selfAttested =
    inputs.singleOperatorDeclared === true &&
    inputs.backendCapability === "verifiable" &&
    proposer !== undefined &&
    ratifier !== undefined &&
    proposer === ratifier &&
    ratifier === root?.author;
  if (selfAttested) return { attestation: "self-attested", facts };

  return { attestation: "unverified", facts };
}

/**
 * Conjunct 4's authorized ratifier: walk native parent edges up from the closing
 * node and read the root's author from the API author field. Deliberately not a
 * configured binding — a configured one is agent-writable, and once the gate
 * keys on *which* human, a rewritable binding is a forgery path.
 *
 * Returns undefined when the walk cannot complete (a broken parent edge, a cycle,
 * or a graph deeper than {@link MAX_ROOT_WALK}); the caller reads that as
 * "root unreachable" and downgrades, never as a pass.
 */
export async function findGraphRoot(
  start: NodeRef,
  readNode: (ref: NodeRef) => Promise<NodeState>,
): Promise<{ nodeId: string; author: string } | undefined> {
  const seen = new Set<string>();
  let current: NodeRef = start;

  for (let depth = 0; depth < MAX_ROOT_WALK; depth += 1) {
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);

    let state: NodeState;
    try {
      state = await readNode(current);
    } catch {
      return undefined;
    }

    if (state.parent === undefined) {
      return state.author.length === 0 ? undefined : { nodeId: state.ref.id, author: state.author };
    }
    current = state.parent;
  }

  return undefined;
}
