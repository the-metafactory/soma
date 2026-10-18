import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import ts from "typescript";
import * as graph from "../src/graph/index";

// The graph surface the deleted root barrel re-exported (node #816), pinned
// so removing an export from the public entry is a reviewed change.
const values = `
  CLOSE_DEADLINE_SEC CLOSE_RECEIPT_MARKER DECISIONS_BEGIN DECISIONS_END FORGES
  PROBE_ESCAPED_PREFIX PROBE_REFUSED_PREFIX PROBE_REGISTRY_RELATIVE_PATH PROBE_REGISTRY_VERSION RECEIPT_COMMENT_BUDGET
  RECEIPT_COMMENT_LIMIT SUBTREE_QUERY_PRIMARY_RATE_POINTS UnreadableBlockersError WorkGraph WorkGraphError
  agentExternalEvidenceKinds allProbesPassed assertClosable authorizeProbe authorizeProbeTree
  boundObserved checkGitHubConfinement checkGitLabConfinement createGhCliTransport createGitHubGraphStore
  createGitLabGraphStore createGlabCliTransport decodeNodeBlock deriveAttestation encodeNodeBlock
  estimateReceiptChars estimateSubtreeQueryPrimaryRatePoints findGraphRoot formatQualifiedNodeRef formatRepoRef
  ghApiArgs hashGatedNodeFields isProbeEscape isProbeRefusal loadProbeRegistry
  normalizeKind parseAuthStatusLogins parseGhApiOutput parseNodeSpec parseProbe
  parseProbeRegistry parseQualifiedNodeRef parseRepoRef probeDirectory probeRegistryPath
  readNodeForBridge renderCloseReceipt resolveClaimRace resolvedProbePaths runCommand
  runProbe runProbes scanCommentsForReceipt spliceSection toNode
`.trim().split(/\s+/);
const types = `
  AttestationCapability AttestationFacts AttestationInputs AttestationOutcome AttestationState
  BlockingRef ClaimResult CloseEvidence CloseReceipt CommandOutcome
  CommandRequest CommentRef ConfinementDeps ConfinementProbeRecord ConfinementResult
  CreateNodeOptions CreateNodeSpec CreatedNode DeclaredCommand DecodedBody
  EdgeWrites Forge FrontierReport GhCliTransportOptions GitHubApiRequest
  GitHubApiTransport GitHubGraphStoreOptions GitLabApiRequest GitLabApiTransport GitLabGraphStoreOptions
  GlabCliTransportOptions GraphReadOptions GraphStore LoadProbeRegistryOptions NodeBudget
  NodeComment NodeRef NodeState NodeStatus ParseProbeRegistryInput
  Probe ProbeAuthorization ProbeRegistry ProbeRegistryHomeOptions ProbeResult
  ProbeRunnerDeps ProbeRunnerOptions ProbeTree ProbeType QualifiedNodeRef
  Ratification Reaction ReadNodeForBridgeOptions ReceiptScan RehomeSelection
  ReleaseResult RepoRef ResolvedProbePath WorkGraphAutonomy WorkGraphErrorCode
  WorkGraphEvidenceKind WorkGraphNode WorkGraphNodeBase
`.trim().split(/\s+/);

test("test-only receipt helpers stay off graph's public entry", () => {
  expect(graph).not.toHaveProperty("collapseHome");
  expect(graph).not.toHaveProperty("redactHome");
});

test("graph's public entry exports the pinned value and type surface", () => {
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("../src/graph/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest);
  const exported = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const symbol of statement.exportClause.elements) exported.add(symbol.name.text);
  }
  const graphExports = graph as Record<string, unknown>;
  for (const name of values) expect(graphExports[name]).toBeDefined();
  for (const name of types) expect(exported.has(name)).toBe(true);
});
