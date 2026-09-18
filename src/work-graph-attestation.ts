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
  ConfinementResult,
  NodeRef,
  NodeState,
  Ratification,
} from "./work-graph";
import type { CommandOutcome, CommandRequest } from "./work-graph-probes";

/** Depth cap on the root walk — a graph deeper than this is malformed, not deep. */
const MAX_ROOT_WALK = 64;

/**
 * What a store's conjunct-2 probe set runs against — forge-neutral on purpose.
 * The probe sets themselves live with their forge's store (#537 D2): the `gh`
 * set in `work-graph-github.ts`, so no forge's check sits here under a name
 * that reads as if it applied to every forge.
 */
export interface ConfinementDeps {
  runCommand: (request: CommandRequest) => Promise<CommandOutcome>;
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  now: () => Date;
}

/**
 * Strip the named token variables: conjunct 2 asks what the session can
 * *reach*, not which identity a forge CLI prefers. Each forge names its own.
 */
export function envWithoutTokens(
  env: Readonly<Record<string, string | undefined>>,
  tokenKeys: readonly string[],
): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (tokenKeys.includes(key)) continue;
    stripped[key] = value;
  }
  return stripped;
}

export interface AttestationInputs {
  /** Conjunct 1 — {@link GraphStore.attestation}, the backend's capability. */
  backendCapability: AttestationCapability;
  /** The identity this session acts as; both the confinement baseline and the disqualifier for conjunct 4. */
  actingIdentity: string;
  confinement?: ConfinementResult;
  proposal?: { commentId: string; author: string };
  ratification?: Ratification;
  root?: { nodeId: string; author: string };
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

  return { attestation: reasons.length === 0 ? "verified" : "unverified", facts };
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
