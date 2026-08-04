import { expect, test } from "bun:test";
import {
  checkConfinement,
  deriveAttestation,
  findGraphRoot,
  parseAuthStatusLogins,
  type AttestationInputs,
  type CommandOutcome,
  type CommandRequest,
  type ConfinementResult,
  type NodeRef,
  type NodeState,
} from "../src/index";

const AT = "2026-08-04T09:00:00.000Z";

function isolated(identity = "ivy-agent"): ConfinementResult {
  return { checked: true, reachableIdentities: [identity], at: AT, probes: [] };
}

/** The shape §3.2 calls verified: isolated session, agent proposed, root author ratified. */
function verifiableInputs(overrides: Partial<AttestationInputs> = {}): AttestationInputs {
  return {
    backendCapability: "verifiable",
    actingIdentity: "ivy-agent",
    confinement: isolated(),
    proposal: { commentId: "c1", author: "ivy-agent" },
    ratification: { kind: "reaction", id: "r1", author: "jcfischer" },
    root: { nodeId: "495", author: "jcfischer" },
    ...overrides,
  };
}

test("all four conjuncts holding yields verified, with no reasons recorded", () => {
  const { attestation, facts } = deriveAttestation(verifiableInputs());
  expect(attestation).toBe("verified");
  expect(facts.reasons).toBeUndefined();
  expect(facts.root).toEqual({ nodeId: "495", author: "jcfischer" });
});

test("conjunct 1 — a backend that cannot attest downgrades the receipt", () => {
  const { attestation, facts } = deriveAttestation(verifiableInputs({ backendCapability: "unverified" }));
  expect(attestation).toBe("unverified");
  expect(facts.reasons?.join(" ")).toContain("backend cannot attest");
});

test("conjunct 2 — #496's worked example: clean authorship, reachable principal credential, unverified", () => {
  const { attestation, facts } = deriveAttestation(
    verifiableInputs({
      confinement: { checked: true, reachableIdentities: ["ivy-agent", "jcfischer"], at: AT, probes: [] },
    }),
  );

  expect(attestation).toBe("unverified");
  expect(facts.reasons?.join(" ")).toContain("jcfischer");
  expect(facts.confinement?.reachableIdentities).toContain("jcfischer");
});

test("conjunct 2 — an unchecked confinement is not an isolated one (downgrade-only)", () => {
  const inputs = verifiableInputs();
  delete inputs.confinement;
  const { attestation, facts } = deriveAttestation(inputs);

  expect(attestation).toBe("unverified");
  expect(facts.reasons?.join(" ")).toContain("confinement was not checked");
});

test("conjunct 3 — one credential wearing both hats never reads as two", () => {
  const { attestation, facts } = deriveAttestation(
    verifiableInputs({
      actingIdentity: "jcfischer",
      confinement: isolated("jcfischer"),
      proposal: { commentId: "c1", author: "jcfischer" },
      ratification: { kind: "reaction", id: "r1", author: "jcfischer" },
    }),
  );

  expect(attestation).toBe("unverified");
  expect(facts.reasons?.join(" ")).toContain("share an author");
});

test("conjunct 4 — a ratifier who is not the graph root's author is not authorized", () => {
  const { attestation, facts } = deriveAttestation(
    verifiableInputs({ ratification: { kind: "reaction", id: "r1", author: "mellanon" } }),
  );

  expect(attestation).toBe("unverified");
  expect(facts.reasons?.join(" ")).toContain("is not the author of graph root 495");
});

test("conjunct 4 — a root authored by the acting identity cannot authorize its own ratification", () => {
  const { attestation, facts } = deriveAttestation(
    verifiableInputs({
      root: { nodeId: "495", author: "ivy-agent" },
      ratification: { kind: "reaction", id: "r1", author: "ivy-agent" },
    }),
  );

  expect(attestation).toBe("unverified");
  expect(facts.reasons?.join(" ")).toContain("authored by the acting identity");
});

test("an auto close has no ratifier at all, so it is honestly unverified", () => {
  const inputs = verifiableInputs();
  delete inputs.proposal;
  delete inputs.ratification;
  const { attestation, facts } = deriveAttestation(inputs);

  expect(attestation).toBe("unverified");
  expect(facts.reasons?.join(" ")).toContain("no ratification found");
});

test("every failed conjunct is recorded, not just the first — remediations differ", () => {
  const { facts } = deriveAttestation(
    verifiableInputs({
      backendCapability: "unverified",
      confinement: { checked: true, reachableIdentities: ["ivy-agent", "jcfischer"], at: AT, probes: [] },
      ratification: { kind: "reaction", id: "r1", author: "mellanon" },
    }),
  );

  expect(facts.reasons?.length).toBeGreaterThanOrEqual(3);
});

// --- confinement probe set --------------------------------------------------

function confinementDeps(
  responses: (request: CommandRequest) => CommandOutcome,
  env: Record<string, string | undefined> = { GH_TOKEN: "agent-pat", PATH: "/usr/bin" },
  platform = "darwin",
): { deps: Parameters<typeof checkConfinement>[0]; seen: CommandRequest[] } {
  const seen: CommandRequest[] = [];
  return {
    seen,
    deps: {
      runCommand: async (request) => {
        seen.push(request);
        return responses(request);
      },
      env,
      platform,
      now: () => new Date(AT),
    },
  };
}

test("the confinement check strips the token env before probing what is reachable", async () => {
  const { deps, seen } = confinementDeps(() => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }));
  await checkConfinement(deps);

  expect(seen.length).toBeGreaterThan(0);
  for (const request of seen) {
    expect(request.env?.GH_TOKEN).toBeUndefined();
    expect(request.env?.PATH).toBe("/usr/bin");
  }
});

test("a reachable keychain item and a foreign login both land in reachableIdentities", async () => {
  const { deps } = confinementDeps((request) => {
    if (request.argv?.join(" ") === "gh auth status") {
      return { exitCode: 0, stdout: "", stderr: "✓ Logged in to github.com account jcfischer (keyring)", timedOut: false };
    }
    if (request.argv?.join(" ") === "gh auth token") {
      return { exitCode: 0, stdout: "gho_xxx\n", stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  });

  const result = await checkConfinement(deps);
  expect(result.checked).toBe(true);
  expect(result.reachableIdentities).toContain("jcfischer");
  expect(result.reachableIdentities).toContain("keychain:gh:github.com");
  expect(result.probes).toHaveLength(3);
});

test("a credential that prints but names no login still counts as reachable", async () => {
  const { deps } = confinementDeps((request) =>
    request.argv?.join(" ") === "gh auth token"
      ? { exitCode: 0, stdout: "gho_xxx\n", stderr: "", timedOut: false }
      : { exitCode: 1, stdout: "", stderr: "", timedOut: false },
  );

  const result = await checkConfinement(deps);
  expect(result.reachableIdentities).toContain("unidentified-credential");
});

test("an isolated session reaches nothing", async () => {
  const { deps } = confinementDeps(
    () => ({ exitCode: 1, stdout: "", stderr: "not logged in", timedOut: false }),
    { PATH: "/usr/bin" },
    "linux",
  );

  const result = await checkConfinement(deps);
  expect(result.reachableIdentities).toEqual([]);
  expect(result.probes).toHaveLength(2);
});

test("both gh auth status output shapes parse — a silent parse miss would read as isolated", () => {
  expect(parseAuthStatusLogins("✓ Logged in to github.com account ivy-agent (keyring)")).toEqual(["ivy-agent"]);
  expect(parseAuthStatusLogins("✓ Logged in to github.com as jcfischer (oauth_token)")).toEqual(["jcfischer"]);
});

// --- root walk --------------------------------------------------------------

function graphOf(nodes: Record<string, { author: string; parent?: string }>): (ref: NodeRef) => Promise<NodeState> {
  return async (ref) => {
    const entry = nodes[ref.id];
    if (entry === undefined) throw new Error(`no such node ${ref.id}`);
    return {
      ref: { id: ref.id },
      node: { id: ref.id, title: `node ${ref.id}`, autonomy: "approve" },
      status: "open",
      assignees: [],
      blockedBy: [],
      author: entry.author,
      typed: true,
      ...(entry.parent === undefined ? {} : { parent: { id: entry.parent } }),
    };
  };
}

test("findGraphRoot walks parent edges to the top and reads the author from there", async () => {
  const root = await findGraphRoot(
    { id: "520" },
    graphOf({
      "520": { author: "ivy-agent", parent: "498" },
      "498": { author: "jcfischer", parent: "495" },
      "495": { author: "jcfischer" },
    }),
  );

  expect(root).toEqual({ nodeId: "495", author: "jcfischer" });
});

test("a broken parent edge leaves the root unreachable — never a pass", async () => {
  const root = await findGraphRoot({ id: "520" }, graphOf({ "520": { author: "ivy-agent", parent: "999" } }));
  expect(root).toBeUndefined();
});

test("a parent cycle terminates the walk instead of hanging it", async () => {
  const root = await findGraphRoot(
    { id: "a" },
    graphOf({ a: { author: "x", parent: "b" }, b: { author: "y", parent: "a" } }),
  );
  expect(root).toBeUndefined();
});

test("an unreachable root downgrades the receipt", () => {
  const inputs = verifiableInputs();
  delete inputs.root;
  const { attestation, facts } = deriveAttestation(inputs);

  expect(attestation).toBe("unverified");
  expect(facts.reasons?.join(" ")).toContain("graph root unreachable");
});
