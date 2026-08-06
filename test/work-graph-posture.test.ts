import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicyArgs, runPolicyCli } from "../src/cli/policy";
import { selectRatification } from "../src/cli/graph";
import {
  declaresSingleOperator,
  deriveAttestation,
  graphPosturePath,
  loadGraphPosture,
  parseGraphPosture,
  GRAPH_POSTURE_RELATIVE_PATH,
  type GraphPosture,
  type Reaction,
} from "../src/index";

const PATH = "/home/.soma/policy/graph-posture.json";

function declared(singleOperator: boolean): GraphPosture {
  return { status: "declared", path: PATH, singleOperator };
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

test("only an explicit singleOperator:true declares anything", () => {
  expect(declaresSingleOperator(declared(true))).toBe(true);
  expect(declaresSingleOperator(declared(false))).toBe(false);
  // Absence is not a claim, and neither is a broken document.
  expect(declaresSingleOperator({ status: "absent", path: PATH })).toBe(false);
  expect(declaresSingleOperator({ status: "invalid", path: PATH, reason: "is not valid JSON" })).toBe(false);
  expect(declaresSingleOperator(undefined)).toBe(false);
});

test("a malformed declaration declares nothing and says why", () => {
  const reason = (raw: string): string => {
    const parsed = parseGraphPosture(PATH, raw);
    if (parsed.status !== "invalid") throw new Error(`expected invalid, got ${parsed.status}`);
    return parsed.reason;
  };
  expect(reason("{")).toContain("not valid JSON");
  expect(reason("[]")).toContain("must be a JSON object");
  expect(reason(JSON.stringify({ version: 2, singleOperator: true }))).toContain(`"version": 1`);
  expect(reason(JSON.stringify({ version: 1 }))).toContain("must be true or false");
  expect(reason(JSON.stringify({ version: 1, singleOperator: "yes" }))).toContain("must be true or false");
  expect(reason(JSON.stringify({ version: 1, singleOperator: true, allow: 1 }))).toContain("unknown key");
});

test("the declaration is per home, and read from soma-home", async () => {
  const home = await mkdtemp(join(tmpdir(), "soma-posture-"));
  await mkdir(join(home, ".soma", "policy"), { recursive: true });
  const path = join(home, ".soma", GRAPH_POSTURE_RELATIVE_PATH);
  expect(graphPosturePath({ homeDir: home })).toBe(path);

  // No repo argument anywhere: posture is about who sits at this machine.
  expect((await loadGraphPosture({ homeDir: home })).status).toBe("absent");

  await writeFile(path, JSON.stringify({ version: 1, singleOperator: true }), "utf8");
  expect(declaresSingleOperator(await loadGraphPosture({ homeDir: home }))).toBe(true);
});

// ---------------------------------------------------------------------------
// What it unlocks, and what it does not
// ---------------------------------------------------------------------------

test("a self-👍 ratifies only where one operator is declared", () => {
  const own: Reaction[] = [{ id: "r1", content: "+1", author: "jcfischer" }];

  // Undeclared: refused, which is why #499 needed a hand override.
  expect(selectRatification(own, "jcfischer", "jcfischer")).toBeUndefined();
  expect(selectRatification(own, "jcfischer", "jcfischer", false)).toBeUndefined();
  // Declared: it ratifies.
  expect(selectRatification(own, "jcfischer", "jcfischer", true)?.author).toBe("jcfischer");
});

test("the declaration never outranks a second credential", () => {
  // Even on a declared single-operator machine, a real other account wins — the
  // fallback is last resort, not preference.
  const both: Reaction[] = [
    { id: "r1", content: "+1", author: "jcfischer" },
    { id: "r2", content: "+1", author: "someone-else" },
  ];
  expect(selectRatification(both, "jcfischer", "jcfischer", true)?.author).toBe("someone-else");

  // And a 👎 from the root author still suppresses everything.
  expect(
    selectRatification(
      [
        { id: "r1", content: "+1", author: "jcfischer" },
        { id: "r2", content: "-1", author: "jcfischer" },
      ],
      "jcfischer",
      "jcfischer",
      true,
    ),
  ).toBeUndefined();
});

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

const SOLO = {
  backendCapability: "verifiable" as const,
  actingIdentity: "jcfischer",
  confinement: {
    checked: true,
    // The operator's own keyring — expected here, and not a second human.
    reachableIdentities: ["jcfischer", "keychain:gh:github.com"],
    at: "2026-08-06T00:00:00.000Z",
    probes: [],
  },
  proposal: { commentId: "c1", author: "jcfischer" },
  ratification: { kind: "reaction" as const, id: "r1", author: "jcfischer" },
  root: { nodeId: "495", author: "jcfischer" },
};

test("a declared solo close is self-attested, not unverified", () => {
  const declaredOutcome = deriveAttestation({ ...SOLO, singleOperatorDeclared: true });
  expect(declaredOutcome.attestation).toBe("self-attested");
  // The facts are unchanged — the label is more precise, nothing is hidden.
  expect(declaredOutcome.facts.reasons?.join(" ")).toContain("share an author");

  // Identical inputs without the declaration stay unverified.
  expect(deriveAttestation({ ...SOLO, singleOperatorDeclared: false }).attestation).toBe("unverified");
});

test("self-attested never covers a different failure", () => {
  const withDeclaration = (overrides: Partial<typeof SOLO>): string =>
    deriveAttestation({ ...SOLO, ...overrides, singleOperatorDeclared: true }).attestation;

  // A stranger ratified — that is the wrong person, not a solo close.
  expect(withDeclaration({ ratification: { kind: "reaction", id: "r1", author: "passer-by" } })).toBe("unverified");
  // Ratifier is not the map's owner.
  expect(withDeclaration({ root: { nodeId: "495", author: "someone-else" } })).toBe("unverified");
  // Backend cannot attest at all.
  expect(
    deriveAttestation({ ...SOLO, backendCapability: "unverified", singleOperatorDeclared: true }).attestation,
  ).toBe("unverified");
});

test("self-attested is never reachable from a clean four-conjunct close", () => {
  // A genuinely verified close stays verified — the declaration cannot downgrade
  // it, and nothing upgrades a solo close to verified.
  const clean = deriveAttestation({
    backendCapability: "verifiable",
    actingIdentity: "ivy-agent",
    confinement: { checked: true, reachableIdentities: ["ivy-agent"], at: SOLO.confinement.at, probes: [] },
    proposal: { commentId: "c1", author: "ivy-agent" },
    ratification: { kind: "reaction", id: "r1", author: "jcfischer" },
    root: { nodeId: "495", author: "jcfischer" },
    singleOperatorDeclared: true,
  });
  expect(clean.attestation).toBe("verified");
});

// ---------------------------------------------------------------------------
// The read verb
// ---------------------------------------------------------------------------

test("`soma policy posture` shows the declaration and how to make one", async () => {
  const home = await mkdtemp(join(tmpdir(), "soma-posture-cli-"));
  await mkdir(join(home, ".soma", "policy"), { recursive: true });
  const path = join(home, ".soma", GRAPH_POSTURE_RELATIVE_PATH);
  const show = async (): Promise<string> =>
    await runPolicyCli(parsePolicyArgs(["policy", "posture", "--home-dir", home]));

  const absent = await show();
  expect(absent).toContain("status: absent");
  expect(absent).toContain(`"singleOperator": true`);

  await writeFile(path, JSON.stringify({ version: 1, singleOperator: true }), "utf8");
  const listed = await show();
  expect(listed).toContain("status: declared");
  expect(listed).toContain("self-attested");
  expect(listed).toContain("never `verified`");
});
