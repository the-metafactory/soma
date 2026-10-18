import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  errataClusterSlug, proposeFromCluster, readErrataLandingRegistry, runErrataTriage,
  type ErrataProposalDeps, type ErrataTriageDeps,
} from "../src/errata";
import { proposalQuotesComplaint, type ErrataProposalInput, type ErrataProposalVerdict } from "../src/errata-classifier";
import { proposalNodeSpec, readProposalFile } from "../src/graph/index";
import { publishRunFinished, runLedgerSpoolPath } from "../src/run-ledger";
import { loadSomaConfig } from "../src/home/index";
import type { ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import type { ErrataCluster, ErrataEvent, ErrataPassedBy, ErrataRecord, SomaMemoryEvent } from "../src/types";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const CLOSED_LOOPBACK = "nats://127.0.0.1:1";
const at = "2026-10-15T06:00:00.000Z";
const registry = { "the-metafactory/soma": 909 };

const check = { kind: "algorithm-verify", runId: "outline-empty-section", criterionId: "C3" } as const satisfies ErrataPassedBy;
const receipt: ErrataPassedBy = { kind: "close-receipt", repo: "the-metafactory/soma", nodeId: "848", receiptCommentId: "6177164346" };
/** The ref and checkpoint `soma graph file-proposal` will see for the `check` cluster below. */
const SLUG = "check-algorithm-verify-outline-empty-section-C3";
const complaint = "You said the outline was verified, but the Thursday section had no slot in it at all.";

const buildBrief: ErrataProposalVerdict = {
  proposal_kind: "deterministic-check",
  title: "Refuse an outline whose section is empty",
  defect: "An outline section reached the principal with nothing in it, and the pass reported the criterion as met.",
  check: "An Algorithm probe that reads the outline sections and fails when one holds neither a slot nor a draft.",
  deliverable: "A probe over the outline file, wired to the criterion it proves, that refuses an empty section.",
  criteria: [
    "The probe fails on an outline fixture whose section holds nothing.",
    "The probe passes on an outline whose every section has a slot or a draft.",
  ],
  reason: "Every one of these is caught by reading the file the pass already opened.",
  backendVersion: "test-cli-1",
};

const grilling: ErrataProposalVerdict = {
  proposal_kind: "reviewer-standard",
  title: "Settle what a section must hold before it counts as written",
  defect: "The work counted a heading with no content as a finished section, and nothing said that was wrong.",
  question: "Is an outline section written when it names a slot, when it names a slot and a draft, or only when you have approved it?",
  reason: "The rule is a judgement the principal owns, not a check.",
  backendVersion: "test-cli-1",
};

function member(id: string, overrides: Partial<ErrataRecord> = {}): ErrataRecord {
  return {
    id, status: "active", createdAt: "2026-10-15T05:00:00.000Z", sessionId: `session-${id}`, rejectedTurnUuid: `U-${id}`,
    rejectedAt: "2026-10-15T05:58:00.000Z", complaintAt: "2026-10-15T05:59:00.000Z", complaint, artifacts: ["src/goal-outline.ts"],
    passedBy: check, ...overrides,
  };
}

const cluster = (members: string[], key: ErrataCluster["key"] = { kind: "check", passedBy: check }): ErrataCluster =>
  ({ id: "EC1", key, errataIds: members, status: "ripe", createdAt: "2026-10-15T05:00:00.000Z" });

const created = (record: ErrataRecord): ErrataEvent => ({ kind: "created", record });
const clustered = (id: string, at2: string): ErrataEvent => ({ kind: "clustered", id, clusterId: "EC1", key: { kind: "check", passedBy: check }, at: at2 });
const proposed = (generation: number, at2: string): ErrataEvent =>
  ({ kind: "proposed", clusterId: "EC1", ref: `errata-${SLUG}-g${generation}`, generation, landing: "the-metafactory/soma", proposalKind: "deterministic-check", at: at2 });
const answered = (kind: "expired" | "dismissed" | "resolved", generation: number, at2: string): ErrataEvent =>
  ({ kind, clusterId: "EC1", ref: `errata-${SLUG}-g${generation}`, at: at2 });

/** In-memory ledger over a real soma-home, so committed files can be read back through file-proposal. */
async function harness(initial: ErrataEvent[], verdict: ErrataProposalVerdict | (() => ErrataProposalVerdict)) {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-proposals-")); homes.push(somaHome);
  const events = [...initial];
  const inputs: ErrataProposalInput[] = [];
  const deps: ErrataProposalDeps = {
    somaHome, cluster: cluster(["E1"]), landing: registry, now: () => new Date(at),
    readLedger: async () => events,
    appendEvent: async (event) => { events.push(event); },
    readTurn: async (sessionId) => ({ sessionId, cwd: "/checkout/soma", excerpt: "Delivered: wrote the weekly outline and reported the section as complete." }),
    resolveRepo: async (cwd) => cwd === "/checkout/soma" ? "the-metafactory/soma" : undefined,
    classify: async (input) => {
      inputs.push(structuredClone(input));
      return typeof verdict === "function" ? verdict() : verdict;
    },
  };
  return { somaHome, events, inputs, deps, appended: () => events.slice(initial.length) };
}

async function proposalFiles(somaHome: string): Promise<string[]> {
  try { return (await readdir(join(somaHome, "proposals"))).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("proposeFromCluster", () => {
  test("a ripe rejected-pass cluster mints one deterministic-check brief that file-proposal accepts", async () => {
    const { somaHome, deps, inputs, appended } = await harness([created(member("E1")), clustered("E1", "2026-10-15T05:00:00.000Z")], buildBrief);
    deps.members = [member("E1")];

    expect(await proposeFromCluster(deps)).toMatchObject({
      status: "proposed", ref: `errata-${SLUG}-g1`, envelopeRef: `soma:proposals/errata-${SLUG}-g1.md`, generation: 1, proposalKind: "deterministic-check",
    });
    expect(await proposalFiles(somaHome)).toEqual([`errata-${SLUG}-g1.md`]);

    // The read `soma graph file-proposal` performs on approve, not a copy of its schema.
    const proposal = await readProposalFile(somaHome, `errata-${SLUG}-g1`);
    expect(proposal.frontMatter).toEqual({
      proposal_kind: "deterministic-check", landing: "the-metafactory/soma", map_root: 909,
      title: buildBrief.title, checkpoint: `errata-${SLUG}`, cites: ["E1"],
    });
    expect(proposal.body).toContain("## Deliverable");
    expect(proposal.body).toContain("## Acceptance criteria");
    expect(proposal.body).toContain("An Algorithm probe");
    expect(proposal.body).toContain("Cites: E1.");
    expect(proposalNodeSpec(proposal)).toMatchObject({ kind: "build", autonomy: "propose", checkpointId: `errata-${SLUG}` });
    expect(proposalQuotesComplaint(`${proposal.frontMatter.title} ${proposal.body}`, [complaint])).toBe(false);
    expect(appended()).toEqual([{
      kind: "proposed", clusterId: "EC1", ref: `errata-${SLUG}-g1`, generation: 1, landing: "the-metafactory/soma", proposalKind: "deterministic-check", at,
    }]);

    // The draft reads the cluster, its check and the rejected turn; nothing of the home leaks in.
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ cluster: SLUG, landing: "the-metafactory/soma", privateStrings: [somaHome, "/checkout/soma"] });
    expect(inputs[0].members[0]).toMatchObject({ id: "E1", passedBy: "algorithm-verify outline-empty-section C3" });
    expect(inputs[0].sessions).toEqual([{ errataId: "E1", sessionId: "session-E1", excerpt: expect.stringContaining("Delivered:") }]);
    expect(JSON.stringify(appended()) + proposal.body).not.toContain("You said");
  });

  test("a judgement-call cluster is filed as a grilling question, not a build brief", async () => {
    const { somaHome, deps } = await harness([created(member("E1")), clustered("E1", "2026-10-15T05:00:00.000Z")], grilling);
    deps.members = [member("E1")];

    expect(await proposeFromCluster(deps)).toMatchObject({ status: "proposed", proposalKind: "reviewer-standard" });
    const proposal = await readProposalFile(somaHome, `errata-${SLUG}-g1`);
    expect(proposal.frontMatter.proposal_kind).toBe("reviewer-standard");
    expect(proposal.body).toContain("## Question");
    expect(proposal.body).toContain("Is an outline section written");
    expect(proposal.body).not.toContain("## Deliverable");
    expect(proposalNodeSpec(proposal)).toMatchObject({ kind: "grilling", autonomy: "approve" });
  });

  test("a cluster whose members share two Errata cites every one of them", async () => {
    const { somaHome, deps } = await harness([
      created(member("E1")), created(member("E2", { complaintAt: "2026-10-15T05:59:30.000Z" })),
      clustered("E1", "2026-10-15T05:00:00.000Z"), clustered("E2", "2026-10-15T06:00:00.000Z"),
    ], buildBrief);
    deps.cluster = cluster(["E1", "E2"]);
    deps.members = [member("E1"), member("E2", { complaintAt: "2026-10-15T05:59:30.000Z" })];

    await proposeFromCluster(deps);
    expect((await readProposalFile(somaHome, `errata-${SLUG}-g1`)).frontMatter.cites).toEqual(["E1", "E2"]);
  });

  test("a draft that carries more than 40 characters of a complaint is refused and writes nothing", async () => {
    const quoted = { ...buildBrief, defect: `${buildBrief.defect} ${complaint}` };
    const { somaHome, deps, appended } = await harness([created(member("E1")), clustered("E1", "2026-10-15T05:00:00.000Z")], quoted);
    deps.members = [member("E1")];

    await expect(proposeFromCluster(deps)).rejects.toThrow(/quotes a complaint/);
    expect(await proposalFiles(somaHome)).toEqual([]);
    expect(appended()).toEqual([]);
  });

  test("a draft naming a local path is refused", async () => {
    const leaked = { ...buildBrief, deliverable: "Read /checkout/soma/src/goal-outline.ts and refuse an empty section." };
    const { somaHome, deps } = await harness([created(member("E1")), clustered("E1", "2026-10-15T05:00:00.000Z")], leaked);
    deps.members = [member("E1")];

    await expect(proposeFromCluster(deps)).rejects.toThrow(/names a private path/);
    expect(await proposalFiles(somaHome)).toEqual([]);
  });

  test("an unanswered proposal stays the only one: a second run writes nothing new", async () => {
    const seed = [created(member("E1")), clustered("E1", "2026-10-15T05:00:00.000Z"), proposed(1, "2026-10-15T05:30:00.000Z")];
    const { somaHome, deps, appended } = await harness(seed, buildBrief);
    deps.members = [member("E1")];

    expect(await proposeFromCluster(deps)).toEqual({ status: "waiting" });
    expect(appended()).toEqual([]);
    expect(await proposalFiles(somaHome)).toEqual([]);
  });

  test("a new Errata that joined while the proposal was open does not mint a generation either", async () => {
    const { somaHome, deps, appended } = await harness([
      created(member("E1")), created(member("E2")),
      clustered("E1", "2026-10-15T05:00:00.000Z"), proposed(1, "2026-10-15T05:30:00.000Z"), clustered("E2", "2026-10-15T05:40:00.000Z"),
    ], buildBrief);
    deps.cluster = cluster(["E1", "E2"]);
    deps.members = [member("E1"), member("E2")];

    expect(await proposeFromCluster(deps)).toEqual({ status: "waiting" });
    expect(appended()).toEqual([]);
    expect(await proposalFiles(somaHome)).toEqual([]);
  });

  test.each(["expired", "dismissed", "resolved"] as const)("a %s answer and a new Errata mint the next generation", async (kind) => {
    const { somaHome, deps, appended } = await harness([
      created(member("E1")), created(member("E2")),
      clustered("E1", "2026-10-15T05:00:00.000Z"), proposed(1, "2026-10-15T05:30:00.000Z"),
      answered(kind, 1, "2026-10-15T06:00:00.000Z"), clustered("E2", "2026-10-16T05:00:00.000Z"),
    ], buildBrief);
    deps.cluster = cluster(["E1", "E2"]);
    deps.members = [member("E1"), member("E2")];

    expect(await proposeFromCluster(deps)).toMatchObject({ status: "proposed", ref: `errata-${SLUG}-g2`, envelopeRef: `soma:proposals/errata-${SLUG}-g2.md`, generation: 2 });
    expect(await proposalFiles(somaHome)).toEqual([`errata-${SLUG}-g2.md`]);
    expect(appended().at(-1)).toMatchObject({ kind: "proposed", generation: 2, ref: `errata-${SLUG}-g2` });
    expect((await readProposalFile(somaHome, `errata-${SLUG}-g2`)).frontMatter.cites).toEqual(["E1", "E2"]);
  });

  test("an answer alone, with no Errata after it, proposes nothing", async () => {
    const { deps, appended } = await harness([
      created(member("E1")), clustered("E1", "2026-10-15T05:00:00.000Z"),
      proposed(1, "2026-10-15T05:30:00.000Z"), answered("expired", 1, "2026-10-15T06:00:00.000Z"),
    ], buildBrief);
    deps.members = [member("E1")];

    expect(await proposeFromCluster(deps)).toEqual({ status: "waiting" });
    expect(appended()).toEqual([]);
  });

  test("a close receipt names the landing repo without reading a transcript", async () => {
    const sessions: string[] = [];
    const { somaHome, deps, inputs } = await harness([created(member("E1", { passedBy: receipt })), clustered("E1", "2026-10-15T05:00:00.000Z")], buildBrief);
    deps.cluster = cluster(["E1"], { kind: "check", passedBy: receipt });
    deps.members = [member("E1", { passedBy: receipt })];
    deps.readTurn = async (sessionId) => { sessions.push(sessionId); return { sessionId, excerpt: "Delivered: nothing." }; };

    await proposeFromCluster(deps);
    expect(sessions).toEqual(["session-E1"]);
    expect(inputs[0]).toMatchObject({ landing: "the-metafactory/soma", members: [{ passedBy: "close-receipt the-metafactory/soma 848" }] });
    expect((await readProposalFile(somaHome, `errata-check-close-receipt-the-metafactory-soma-848-6177164346-g1`)).frontMatter.landing).toBe("the-metafactory/soma");
  });
});

describe("errataClusterSlug", () => {
  test("a theme label is slugged to the ref alphabet, and a long one keeps its head and a hash", () => {
    expect(errataClusterSlug({ kind: "theme", label: "Skipped the probe" })).toBe("theme-Skipped-the-probe");
    expect(errataClusterSlug({ kind: "theme", label: "Über assumption, twice stated ✓" })).toBe("theme-Uber-assumption-twice-stated");

    const label = "very long label ".repeat(10).trim();
    const slug = errataClusterSlug({ kind: "theme", label });
    expect(slug.startsWith("theme-very-long-label")).toBe(true);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).toMatch(/[a-f0-9]{8}$/);
    expect(`errata-${slug}`).toMatch(/^errata-[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(errataClusterSlug({ kind: "theme", label: `${label} twice` })).not.toBe(slug);
  });
});

describe("errata.landing registry", () => {
  test("config declares the registry, and a row outside the proposal grammar is refused", async () => {
    const somaHome = await mkdtemp(join(tmpdir(), "soma-landing-")); homes.push(somaHome);
    expect(await readErrataLandingRegistry(somaHome)).toEqual({});
    await writeFile(join(somaHome, "config.yaml"), "errata:\n  landing:\n    the-metafactory/soma: 909\n", "utf8");
    expect(await readErrataLandingRegistry(somaHome)).toEqual(registry);
    expect((await loadSomaConfig({ somaHome })).errata?.landing).toEqual(registry);
    await writeFile(join(somaHome, "config.yaml"), "errata:\n  landing:\n    two/segments/deep: 909\n", "utf8");
    await expect(readErrataLandingRegistry(somaHome)).rejects.toThrow(/Invalid errata\.landing entry/);
    await writeFile(join(somaHome, "config.yaml"), "errata:\n  landing:\n    the-metafactory/soma: zero\n", "utf8");
    await expect(readErrataLandingRegistry(somaHome)).rejects.toThrow(/Invalid Soma config/);
  });
});

/** Triage drives the envelope and the registry: promote one candidate, cluster it, propose it. */
async function triageHarness(overrides: Partial<ErrataTriageDeps> = {}) {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-triage-proposal-")); homes.push(somaHome);
  const candidate: SomaMemoryEvent = {
    id: "evt-1", timestamp: at, substrate: "claude-code", kind: "feedback.candidate", summary: "Feedback candidate",
    metadata: { actor: "interactive", sessionId: "S1", transcriptPath: join(somaHome, "transcript.jsonl"), redactedExcerpt: complaint },
  };
  const reports: { resultRef?: string; proposalRefs?: readonly string[] }[] = [];
  const deps: ErrataTriageDeps = {
    somaHome, now: () => new Date(at), readEvents: async () => [candidate],
    classify: async () => ({ verdict: "promote", reason: "Rejects delivered output.", backendVersion: "test-cli-1" }),
    classifyTheme: async () => { throw new Error("A linked pass needs no theme."); },
    link: async () => ({
      status: "linked", warnings: [],
      errata: { sessionId: "S1", rejectedTurnUuid: "U1", rejectedAt: "2026-10-15T05:58:00.000Z", complaintAt: "2026-10-15T05:59:00.000Z", complaint, artifacts: ["src/goal-outline.ts"], passedBy: check },
    }),
    classifyProposal: async () => buildBrief,
    readTurn: async (sessionId) => ({ sessionId, cwd: "/checkout/soma", excerpt: "Delivered: wrote the weekly outline." }),
    resolveRepo: async (cwd) => cwd === "/checkout/soma" ? "the-metafactory/soma" : undefined,
    publishRun: async (report) => { reports.push(report); },
    ...overrides,
  };
  return { somaHome, candidate, deps, reports };
}

async function triageBacklog(count: number) {
  const h = await triageHarness({ landing: registry });
  const link = h.deps.link!;
  h.deps.readEvents = async () => Array.from({ length: count }, (_, i) => ({
    ...h.candidate, id: `evt-${i + 1}`,
    metadata: { ...h.candidate.metadata, sessionId: `S${i + 1}` },
  }));
  h.deps.link = async (candidate) => {
    const linked = await link(candidate);
    if (linked.status !== "linked") throw new Error("Expected linked fixture.");
    return { ...linked, errata: { ...linked.errata, sessionId: candidate.sessionId,
      passedBy: { ...check, runId: `${check.runId}-${candidate.sessionId}` } } };
  };
  const refs = Array.from({ length: count }, (_, i) => `errata-${errataClusterSlug({
    kind: "check", passedBy: { ...check, runId: `${check.runId}-S${i + 1}` },
  })}-g1`);
  return { ...h, refs };
}

describe("runErrataTriage proposals", () => {
  test("a later commit failure leaves earlier proposals pending for the next successful run", async () => {
    const { somaHome, deps, reports, refs } = await triageBacklog(2);
    const obstruction = join(somaHome, "proposals", `${refs[1]}.md`);
    await mkdir(obstruction, { recursive: true });
    expect((await runErrataTriage(deps)).outcome).toBe("failed");
    const original = await readFile(join(somaHome, "proposals", `${refs[0]}.md`), "utf8");
    expect(reports[0].proposalRefs).toBeUndefined();

    await rm(obstruction, { recursive: true });
    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", proposed: 1 });
    expect(reports[1].proposalRefs).toEqual(refs.map((ref) => `soma:proposals/${ref}.md`));
    expect(await readFile(join(somaHome, "proposals", `${refs[0]}.md`), "utf8")).toBe(original);
    await runErrataTriage(deps);
    expect(reports[2].proposalRefs).toBeUndefined();
  });

  test("a report write failure leaves the committed proposal pending without redrafting", async () => {
    const { somaHome, deps, reports } = await triageHarness({ landing: registry });
    const obstruction = join(somaHome, "memory", "STATE", "errata", "triage-runs");
    await mkdir(join(obstruction, ".."), { recursive: true });
    await writeFile(obstruction, "block the report directory");
    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "failed", proposed: 1 });
    expect(reports[0].proposalRefs).toBeUndefined();

    await rm(obstruction);
    deps.classifyProposal = async () => { throw new Error("Must not redraft a committed proposal."); };
    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", proposed: 0 });
    expect(reports[1].proposalRefs).toEqual([`soma:proposals/errata-${SLUG}-g1.md`]);
  });

  test("failure before spooling retains pending delivery across runs", async () => {
    const { somaHome, deps } = await triageHarness({ landing: registry, publishRun: undefined });
    deps.env = { SOMA_PRINCIPAL: "jc", SOMA_NATS_CREDS: join(somaHome, "missing.creds") };
    expect((await runErrataTriage(deps)).proposed).toBe(1);
    const events: ExecutionRunFinishedEvent[] = [];
    deps.env = { SOMA_PRINCIPAL: "jc" };
    deps.publishRunFinished = async (event) => { events.push(event); };
    expect((await runErrataTriage(deps)).proposed).toBe(0);
    expect(events[0].input.payload.proposal_refs).toEqual([`soma:proposals/errata-${SLUG}-g1.md`]);
    await runErrataTriage(deps);
    expect(events[1].input.payload.proposal_refs).toBeUndefined();
    expect(await proposalFiles(somaHome)).toEqual([`errata-${SLUG}-g1.md`]);
  });

  test("proposal planning is bounded and every plan finishes before any commit", async () => {
    const { somaHome, deps } = await triageBacklog(9);
    let active = 0;
    let peak = 0;
    let calls = 0;
    const filesDuringPlanning: string[][] = [];
    deps.classifyProposal = async () => {
      active++;
      peak = Math.max(peak, active);
      calls++;
      filesDuringPlanning.push(await proposalFiles(somaHome));
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return buildBrief;
    };
    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", proposed: 9 });
    expect(calls).toBe(9);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(filesDuringPlanning.every((files) => files.length === 0)).toBe(true);
  });

  test("a refused plan settles in-flight workers and commits no part of the batch", async () => {
    const { somaHome, deps } = await triageBacklog(9);
    let active = 0;
    let calls = 0;
    deps.classifyProposal = async () => {
      const index = calls++;
      active++;
      try {
        await new Promise((resolve) => setTimeout(resolve, index === 0 ? 0 : 20));
        if (index === 0) throw new Error("Refuse the first draft.");
        return buildBrief;
      } finally { active--; }
    };
    expect((await runErrataTriage(deps)).outcome).toBe("failed");
    expect(active).toBe(0);
    expect(calls).toBe(3);
    expect(await proposalFiles(somaHome)).toEqual([]);
    expect(await readFile(join(somaHome, "memory", "STATE", "errata", "ledger.jsonl"), "utf8")).not.toContain('"kind":"proposed"');
  });

  test("overlapping jobs acknowledge a pending proposal only once", async () => {
    const { deps, reports } = await triageHarness({ landing: registry });
    await Promise.all([runErrataTriage(deps), runErrataTriage(deps)]);
    expect(reports.flatMap((report) => report.proposalRefs ?? [])).toEqual([`soma:proposals/errata-${SLUG}-g1.md`]);
  });

  test("disabled delivery leaves the proposal pending, and a throwing publisher does too", async () => {
    const { deps, reports } = await triageHarness({ landing: registry });
    deps.publishRun = async () => "disabled";
    expect((await runErrataTriage(deps)).proposed).toBe(1);
    deps.publishRun = async () => { throw new Error("Delivery unavailable."); };
    await expect(runErrataTriage(deps)).rejects.toThrow("Delivery unavailable.");
    deps.publishRun = async (report) => { reports.push(report); };
    expect((await runErrataTriage(deps)).proposed).toBe(0);
    expect(reports[0].proposalRefs).toEqual([`soma:proposals/errata-${SLUG}-g1.md`]);
  });

  test("a ripe cluster's ref rides the run envelope, and the next run carries nothing and writes nothing", async () => {
    const { somaHome, deps, reports } = await triageHarness({ landing: registry });

    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", promoted: 1, clustered: 1, ripe: 1, proposed: 1, unroutable: 0 });
    expect(await proposalFiles(somaHome)).toEqual([`errata-${SLUG}-g1.md`]);
    expect(reports[0]).toMatchObject({ proposalRefs: [`soma:proposals/errata-${SLUG}-g1.md`] });

    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", promoted: 0, proposed: 0, unroutable: 0 });
    expect(await proposalFiles(somaHome)).toEqual([`errata-${SLUG}-g1.md`]);
    expect(reports[1].proposalRefs).toBeUndefined();
  });

  test("myelin builds the envelope: proposal_refs are soma refs on a succeeded run", async () => {
    const { somaHome, deps } = await triageHarness({ landing: registry, publishRun: undefined });
    const events: ExecutionRunFinishedEvent[] = [];
    deps.env = { SOMA_PRINCIPAL: "jc" };
    deps.publishRunFinished = async (event) => { events.push(event); };

    expect((await runErrataTriage(deps)).outcome).toBe("succeeded");
    expect(await proposalFiles(somaHome)).toEqual([`errata-${SLUG}-g1.md`]);
    expect(events).toHaveLength(1);
    expect(events[0].input.payload).toMatchObject({
      ran: { kind: "job", ref: "errata-triage" }, outcome: "succeeded", proposal_refs: [`soma:proposals/errata-${SLUG}-g1.md`],
    });
    expect(JSON.stringify(events)).not.toContain(complaint);
  });

  test("a refused draft fails the run and writes nothing, so the next run still owes generation 1", async () => {
    const { somaHome, deps, reports } = await triageHarness({ landing: registry, classifyProposal: async () => { throw new Error("PRIVATE BACKEND FAILURE"); } });

    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "failed", proposed: 0 });
    expect(await proposalFiles(somaHome)).toEqual([]);
    expect(reports[0].proposalRefs).toBeUndefined();
    const failed = await readFile(join(somaHome, "memory", "STATE", "errata", "ledger.jsonl"), "utf8");
    expect(failed).not.toContain('"kind":"proposed"');

    deps.classifyProposal = async () => buildBrief;
    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", proposed: 1 });
    expect(await proposalFiles(somaHome)).toEqual([`errata-${SLUG}-g1.md`]);
    expect(reports[1]).toMatchObject({ proposalRefs: [`soma:proposals/errata-${SLUG}-g1.md`] });
  });

  test("an unreachable bus spools the envelope, and the proposal file is still written once", async () => {
    const { somaHome, deps } = await triageHarness({ landing: registry, publishRun: undefined });
    deps.env = { SOMA_PRINCIPAL: "jc", SOMA_NATS_URL: CLOSED_LOOPBACK };

    expect((await runErrataTriage(deps)).proposed).toBe(1);
    const spool = (await readFile(runLedgerSpoolPath(somaHome), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { op: string; envelope?: { payload?: { proposal_refs?: string[] } } });
    expect(spool).toHaveLength(1);
    expect(spool[0]).toMatchObject({ op: "put", envelope: { payload: { proposal_refs: [`soma:proposals/errata-${SLUG}-g1.md`] } } });

    expect((await runErrataTriage(deps)).proposed).toBe(0);
    expect(await proposalFiles(somaHome)).toEqual([`errata-${SLUG}-g1.md`]);
    const delivered: ExecutionRunFinishedEvent[] = [];
    deps.publishRunFinished = async (event) => { delivered.push(event); };
    await runErrataTriage(deps);
    expect(delivered[0].input.payload.proposal_refs).toBeUndefined();
  });

  test("an unregistered landing repo is reported once, as a waiting result naming the repo", async () => {
    const { somaHome, deps, reports } = await triageHarness({ landing: { "the-metafactory/cortex": 12 } });

    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", proposed: 0, unroutable: 1, ripe: 1 });
    const filename = "errata-unroutable-2026-10-15.md";
    const report = await readFile(join(somaHome, "outputs", filename), "utf8");
    expect(reports[0]).toMatchObject({ resultRef: `soma:outputs/${filename}` });
    expect(reports[0].proposalRefs).toBeUndefined();
    expect(report).toContain("`errata-check-algorithm-verify-outline-empty-section-C3`");
    expect(report).toContain("the-metafactory/soma");
    expect(report).not.toContain(complaint);
    const ledger = await readFile(join(somaHome, "memory", "STATE", "errata", "ledger.jsonl"), "utf8");
    expect(ledger).toContain('"kind":"unroutable"');
    expect(ledger.split('"kind":"unroutable"').length - 1).toBe(1);

    // Reported once: the next run appends nothing and offers no result again.
    expect(await runErrataTriage(deps)).toMatchObject({ outcome: "succeeded", unroutable: 0 });
    const repeated = await readFile(join(somaHome, "memory", "STATE", "errata", "ledger.jsonl"), "utf8");
    expect(repeated.split('"kind":"unroutable"').length - 1).toBe(1);
    expect(reports[1].resultRef).toBeUndefined();
  });

  test("a cluster no session can place is reported as naming no repo", async () => {
    const { somaHome, deps, reports } = await triageHarness({ landing: registry, readTurn: async () => null });

    expect((await runErrataTriage(deps)).unroutable).toBe(1);
    const report = await readFile(join(somaHome, "outputs", "errata-unroutable-2026-10-15.md"), "utf8");
    expect(report).toContain("name no repo");
    expect(reports[0].resultRef).toContain("errata-unroutable-");
  });

  test("the proposal stage reads the config registry when the caller injects none", async () => {
    const { somaHome, deps } = await triageHarness({ landing: undefined });
    await mkdir(somaHome, { recursive: true });
    await writeFile(join(somaHome, "config.yaml"), "errata:\n  landing:\n    the-metafactory/soma: 909\n", "utf8");

    expect((await runErrataTriage(deps)).proposed).toBe(1);
    expect(await proposalFiles(somaHome)).toEqual([`errata-${SLUG}-g1.md`]);
  });
});

describe("publishRunFinished proposalRefs", () => {
  const finished = {
    kind: "job", ref: "errata-triage", runId: "run-1", outcome: "succeeded",
    startedAt: "2026-10-15T06:00:00Z", endedAt: "2026-10-15T06:01:00Z",
  } as const;

  test("the funnel carries proposal_refs, and an empty list is not an envelope field", async () => {
    const somaHome = await mkdtemp(join(tmpdir(), "soma-refs-")); homes.push(somaHome);
    const payloads: ExecutionRunFinishedEvent["input"]["payload"][] = [];
    const options = { somaHome, substrate: "claude-code" as const, env: { SOMA_PRINCIPAL: "jc" } };
    const publish = async (event: ExecutionRunFinishedEvent) => { payloads.push(event.input.payload); };

    expect(await publishRunFinished({ ...finished, proposalRefs: [`soma:proposals/${SLUG}-g1.md`] }, { ...options, publish })).toBe("published");
    expect(payloads[0].proposal_refs).toEqual([`soma:proposals/${SLUG}-g1.md`]);
    expect(await publishRunFinished({ ...finished, proposalRefs: [] }, { ...options, publish })).toBe("published");
    expect(payloads[1].proposal_refs).toBeUndefined();
    expect(await publishRunFinished(finished, { ...options, publish })).toBe("published");
    expect(payloads[2].proposal_refs).toBeUndefined();
  });
});
