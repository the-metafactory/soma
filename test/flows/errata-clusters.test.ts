import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendErrata, clusterErrata, dropErrata, errataLedgerPath, readErrata, readErrataClusters, type ErrataClusterDeps } from "../../src/flows/errata";
import { themeQuotesComplaint, validateErrataTheme, type ErrataThemeInput, type ErrataThemeVerdict } from "../../src/flows/errata-classifier";
import { readJudgments, type JudgmentRecord } from "../../src/core/index";
import type { ErrataEvent, ErrataInput, ErrataPassedBy, ErrataRecord } from "../../src/flows/types";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const now = new Date("2026-10-14T06:00:00.000Z");
const check: ErrataPassedBy = { kind: "algorithm-verify", runId: "run-1", criterionId: "C1" };
const receipt: ErrataPassedBy = { kind: "close-receipt", repo: "the-metafactory/soma", nodeId: "#848", receiptCommentId: "123" };

function errata(id: string, overrides: Partial<ErrataRecord> = {}): ErrataRecord {
  return {
    id, status: "active", createdAt: "2026-10-13T10:00:00.000Z", sessionId: `session-${id}`, rejectedTurnUuid: `U-${id}`,
    rejectedAt: "2026-10-13T09:59:00.000Z", complaintAt: "2026-10-13T10:00:00.000Z",
    complaint: `PRIVATE COMPLAINT ${id}: the delivered output ignored the contract`, artifacts: [], passedBy: null, ...overrides,
  };
}
const created = (record: ErrataRecord): ErrataEvent => ({ kind: "created", record });
const dropped = (id: string): ErrataEvent => ({ kind: "dropped", id, at: "2026-10-13T11:00:00.000Z" });

/** In-memory ledger seam: every write lands in `events`, every judgment in `judgments`. */
function harness(initial: ErrataEvent[], theme?: (input: ErrataThemeInput) => ErrataThemeVerdict | Promise<ErrataThemeVerdict>) {
  const events = [...initial];
  const judgments: JudgmentRecord[] = [];
  const inputs: ErrataThemeInput[] = [];
  const deps: ErrataClusterDeps = {
    somaHome: "", now: () => now,
    readLedger: async () => events,
    appendEvent: async (event) => { events.push(event); },
    classifyTheme: async (input) => {
      inputs.push(structuredClone(input));
      if (!theme) throw new Error("Deterministic keys must not call the classifier.");
      return theme(input);
    },
    recordJudgment: async (record) => { judgments.push(record); return true; },
  };
  return { events, judgments, inputs, deps, appended: () => events.slice(initial.length) };
}

describe("clusterErrata", () => {
  test("Errata with the same passedBy check share a cluster id via appended clustered events, and that cluster is ripe", async () => {
    const somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(somaHome);
    const { deps, appended, judgments } = harness([
      created(errata("E1", { passedBy: check, artifacts: ["src/a.ts"] })),
      created(errata("E2", { passedBy: check, artifacts: ["src/b.ts"] })),
      created(errata("E3", { passedBy: { ...check, criterionId: "C2" } })),
      created(errata("E4", { passedBy: receipt })),
    ]);
    deps.somaHome = somaHome;
    const result = await clusterErrata(deps);
    expect(appended()).toEqual([
      { kind: "clustered", id: "E1", clusterId: "EC1", key: { kind: "check", passedBy: check }, at: now.toISOString() },
      { kind: "clustered", id: "E2", clusterId: "EC1", key: { kind: "check", passedBy: check }, at: now.toISOString() },
      { kind: "clustered", id: "E3", clusterId: "EC2", key: { kind: "check", passedBy: { ...check, criterionId: "C2" } }, at: now.toISOString() },
      { kind: "clustered", id: "E4", clusterId: "EC3", key: { kind: "check", passedBy: receipt }, at: now.toISOString() },
    ]);
    expect(result.clustered).toBe(4);
    expect(result.clusters.map((cluster) => [cluster.id, cluster.errataIds, cluster.status])).toEqual([
      ["EC1", ["E1", "E2"], "ripe"], ["EC2", ["E3"], "ripe"], ["EC3", ["E4"], "ripe"],
    ]);
    expect(judgments).toEqual([]);
    expect(JSON.stringify(appended())).not.toContain("PRIVATE");
  });

  test("null-link Errata sharing an artifact path share a cluster without calling the classifier", async () => {
    const { deps, appended } = harness([
      created(errata("E3", { artifacts: ["src/a.ts", "src/x.ts"] })),
      created(errata("E4", { artifacts: ["src/y.ts", "src/a.ts"] })),
    ]);
    deps.somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(deps.somaHome);
    const result = await clusterErrata(deps);
    expect(appended().map((event) => event.kind === "clustered" && [event.id, event.clusterId, event.key])).toEqual([
      ["E3", "EC1", { kind: "artifact", path: "src/a.ts" }], ["E4", "EC1", { kind: "artifact", path: "src/a.ts" }],
    ]);
    expect(result.clusters).toMatchObject([{ id: "EC1", errataIds: ["E3", "E4"], status: "ripe" }]);
  });

  test("a later null-link Errata joins an existing cluster through any member's artifact, and a linked member's artifact never keys it", async () => {
    const { deps, appended } = harness([
      created(errata("E1", { artifacts: ["src/a.ts"] })),
      created(errata("E2", { artifacts: ["src/a.ts", "src/b.ts"] })),
      created(errata("E3", { passedBy: check, artifacts: ["src/c.ts"] })),
      { kind: "clustered", id: "E1", clusterId: "EC1", key: { kind: "artifact", path: "src/a.ts" }, at: now.toISOString() },
      { kind: "clustered", id: "E2", clusterId: "EC1", key: { kind: "artifact", path: "src/a.ts" }, at: now.toISOString() },
      { kind: "clustered", id: "E3", clusterId: "EC2", key: { kind: "check", passedBy: check }, at: now.toISOString() },
      created(errata("E4", { artifacts: ["src/b.ts"] })),
      created(errata("E5", { artifacts: ["src/c.ts", "src/d.ts"] })),
      created(errata("E6", { artifacts: ["src/d.ts"] })),
    ]);
    deps.somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(deps.somaHome);
    await clusterErrata(deps);
    expect(appended().map((event) => event.kind === "clustered" && [event.id, event.clusterId])).toEqual([["E4", "EC1"], ["E5", "EC3"], ["E6", "EC3"]]);
  });

  test("an unlinked Errata with no shared artifact gets a judged theme; the same theme later joins that cluster", async () => {
    const { deps, appended, judgments, inputs } = harness([
      created(errata("E5", { artifacts: ["src/only.ts"], complaint: "Wrong again. token=secret-value" })),
    ], () => ({ theme: "Unverified claim", reason: "Asserted without a probe.", backendVersion: "2.1.296" }));
    deps.somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(deps.somaHome);
    const first = await clusterErrata(deps);
    expect(inputs).toEqual([{ complaint: "Wrong again. [redacted]", themes: [] }]);
    expect(appended()).toEqual([{ kind: "clustered", id: "E5", clusterId: "EC1", key: { kind: "theme", label: "Unverified claim" }, at: now.toISOString() }]);
    expect(first.clusters).toMatchObject([{ id: "EC1", status: "open" }]);
    expect(judgments).toHaveLength(1);
    expect(judgments[0]).toMatchObject({
      v: 1, ts: now.toISOString(), caller: "errata-triage", backend: "claude-p", backendVersion: "2.1.296",
      decision: { verdict: "theme", theme: "Unverified claim", errataId: "E5", clusterId: "EC1", status: "clustered" },
    });
    expect(JSON.stringify(judgments)).not.toContain("Wrong again");
    expect(JSON.stringify(judgments)).not.toContain("secret-value");

    deps.classifyTheme = async (input) => {
      inputs.push(input);
      return { theme: "  unverified CLAIM ", reason: "Same failure kind.", backendVersion: "2.1.296" };
    };
    const events = await deps.readLedger!() as ErrataEvent[];
    events.push(created(errata("E6", { artifacts: ["src/other.ts"], complaintAt: "2026-10-14T05:00:00.000Z" })));
    const second = await clusterErrata(deps);
    expect(inputs[1].themes).toEqual(["Unverified claim"]);
    expect(appended().at(-1)).toMatchObject({ kind: "clustered", id: "E6", clusterId: "EC1", key: { kind: "theme", label: "Unverified claim" } });
    expect(second.clusters).toMatchObject([{ id: "EC1", errataIds: ["E5", "E6"], status: "ripe" }]);
  });

  test("a null-link cluster is ripe on two Errata within 30 Zurich days, not 31", async () => {
    const pair = (first: string, second: string) => [
      created(errata("E1", { artifacts: ["src/a.ts"], complaintAt: first })),
      created(errata("E2", { artifacts: ["src/a.ts"], complaintAt: second })),
    ];
    for (const [first, second, status] of [
      ["2026-09-01T10:00:00.000Z", "2026-10-02T10:00:00.000Z", "open"],   // 31 days
      ["2026-09-03T10:00:00.000Z", "2026-10-02T10:00:00.000Z", "ripe"],   // 29 days
      ["2026-09-02T10:00:00.000Z", "2026-10-02T10:00:00.000Z", "ripe"],   // 30 days, within
      // 22:30Z on 1 Oct is already 2 Oct in Zurich: 30 Zurich days apart, 31 UTC days apart.
      ["2026-10-01T22:30:00.000Z", "2026-11-01T22:30:00.000Z", "ripe"],
      // 23:30Z on 1 Nov is still 1 Nov in Zurich (CET): 31 Zurich days from 1 Oct.
      ["2026-10-01T12:00:00.000Z", "2026-11-01T23:30:00.000Z", "open"],
    ] as const) {
      const { deps } = harness(pair(first, second));
      deps.somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(deps.somaHome);
      expect((await clusterErrata(deps)).clusters.map((cluster) => cluster.status)).toEqual([status]);
    }
  });

  test("a dropped Errata counts toward no cluster and no threshold", async () => {
    const { deps, appended } = harness([
      created(errata("E1", { artifacts: ["src/a.ts"] })),
      created(errata("E2", { artifacts: ["src/a.ts"] })),
      { kind: "clustered", id: "E1", clusterId: "EC1", key: { kind: "artifact", path: "src/a.ts" }, at: now.toISOString() },
      { kind: "clustered", id: "E2", clusterId: "EC1", key: { kind: "artifact", path: "src/a.ts" }, at: now.toISOString() },
      dropped("E2"),
      created(errata("E3", { passedBy: check })),
      dropped("E3"),
      created(errata("E4", { passedBy: check })),
      created(errata("E5", { passedBy: check })),
      { kind: "clustered", id: "E4", clusterId: "EC2", key: { kind: "check", passedBy: check }, at: now.toISOString() },
      { kind: "clustered", id: "E5", clusterId: "EC2", key: { kind: "check", passedBy: check }, at: now.toISOString() },
      dropped("E4"), dropped("E5"),
    ]);
    deps.somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(deps.somaHome);
    const result = await clusterErrata(deps);
    expect(appended()).toEqual([]);
    expect(result.clusters).toEqual([{ id: "EC1", key: { kind: "artifact", path: "src/a.ts" }, errataIds: ["E1"], status: "open", createdAt: now.toISOString() }]);
  });

  test("a refused theme or a judge failure writes no theme; the deterministic assignments written ahead of it stand", async () => {
    const complaint = "The delivered output ignored the contract we agreed on. Please redo it.";
    const { deps, appended, judgments } = harness([
      created(errata("E1", { passedBy: check })),
      created(errata("E2", { artifacts: ["src/a.ts"], complaint })),
      created(errata("E3", { artifacts: ["src/b.ts"], complaint })),
    ], (input) => input.themes.length === 0
      ? { theme: "Missed constraint", reason: "ok", backendVersion: "1" }
      : { theme: "ignored the contract", reason: "ok", backendVersion: "1" });
    deps.somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(deps.somaHome);
    await expect(clusterErrata(deps)).rejects.toThrow("Errata theme quotes the complaint.");
    // E1 is keyed by its check and written before any judge is called; nothing of E2 or E3 is written.
    expect(appended()).toMatchObject([{ kind: "clustered", id: "E1", clusterId: "EC1", key: { kind: "check", passedBy: check } }]);
    expect(judgments).toEqual([]);
    deps.classifyTheme = async () => { throw new Error("PRIVATE SUBPROCESS FAILURE"); };
    await expect(clusterErrata(deps)).rejects.toThrow();
    expect(appended()).toHaveLength(1);
    deps.recordJudgment = async () => false;
    deps.classifyTheme = async () => ({ theme: "Missed constraint", reason: "ok", backendVersion: "1" });
    await expect(clusterErrata(deps)).rejects.toThrow("Errata theme judgment could not be recorded.");
    expect(appended()).toHaveLength(1);
    deps.recordJudgment = async (record) => { judgments.push(record); return true; };
    expect((await clusterErrata(deps)).clustered).toBe(2);
    expect(appended().map((event) => event.kind === "clustered" && [event.id, event.clusterId])).toEqual([["E1", "EC1"], ["E2", "EC2"], ["E3", "EC2"]]);
  });

  test("theme validation: short, single-line, in the judge's words", () => {
    const input = { complaint: "The delivered output ignored the contract. Token leaked.", themes: [] };
    const ok = (theme: string) => validateErrataTheme({ theme, reason: "r", backendVersion: "1" }, input);
    expect(() => ok("Missed constraint")).not.toThrow();
    expect(() => ok("Contract drift in delivered code")).not.toThrow();
    expect(() => ok("output ignored the contract")).toThrow("quotes the complaint");
    expect(() => ok("Ignored The Contract!")).toThrow("quotes the complaint");
    expect(() => ok("Token leaked")).toThrow("quotes the complaint");
    expect(() => ok("")).toThrow("Invalid Errata theme verdict.");
    expect(() => ok("x".repeat(61))).toThrow("Invalid Errata theme verdict.");
    expect(() => ok("two\nlines")).toThrow("Invalid Errata theme verdict.");
    expect(() => validateErrataTheme({ theme: "Fine", reason: "", backendVersion: "1" }, input)).toThrow("Invalid Errata theme verdict.");
    expect(themeQuotesComplaint("contract", "the contract")).toBe(false);
  });

  test("the file ledger persists clusters, folds them on read, and a repeat run clusters nothing", async () => {
    const somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(somaHome);
    const base: ErrataInput = { sessionId: "S", rejectedTurnUuid: "U", rejectedAt: "2026-10-13T09:59:00.000Z", complaintAt: "2026-10-13T10:00:00.000Z", complaint: "PRIVATE COMPLAINT", artifacts: ["src/a.ts"], passedBy: null };
    await appendErrata(somaHome, base);
    await appendErrata(somaHome, { ...base, artifacts: ["src/b.ts"] });
    await appendErrata(somaHome, { ...base, artifacts: ["src/a.ts"] });
    const seenByJudge: unknown[] = [];
    const deps: ErrataClusterDeps = {
      somaHome, now: () => now,
      // The ledger lock is released while the judge runs: a reader sees the artifact cluster already written.
      classifyTheme: async () => { seenByJudge.push(await readErrataClusters(somaHome)); return { theme: "Missed constraint", reason: "r", backendVersion: "1" }; },
    };
    expect((await clusterErrata(deps)).clustered).toBe(3);
    expect(seenByJudge).toMatchObject([[{ id: "EC1", errataIds: ["E1", "E3"], status: "ripe" }]]);
    expect(await readErrataClusters(somaHome)).toMatchObject([
      { id: "EC1", key: { kind: "artifact", path: "src/a.ts" }, errataIds: ["E1", "E3"], status: "ripe" },
      { id: "EC2", key: { kind: "theme", label: "Missed constraint" }, errataIds: ["E2"], status: "open" },
    ]);
    expect((await readErrata(somaHome)).map((record) => record.clusterId)).toEqual(["EC1", "EC2", "EC1"]);
    expect((await readJudgments(somaHome, { caller: "errata-triage" })).records).toHaveLength(1);
    expect((await clusterErrata(deps)).clustered).toBe(0);
    await dropErrata(somaHome, "E3");
    expect(await readErrataClusters(somaHome)).toMatchObject([{ id: "EC1", errataIds: ["E1"], status: "open" }, { id: "EC2" }]);
    expect(await readFile(errataLedgerPath(somaHome), "utf8")).toContain('"kind":"clustered"');
    await appendErrata(somaHome, { ...base, artifacts: [] });
    deps.classifyTheme = async () => ({ theme: "missed constraint", reason: "r", backendVersion: "1" });
    expect((await clusterErrata(deps)).clusters).toMatchObject([{ id: "EC1" }, { id: "EC2", errataIds: ["E2", "E4"], status: "ripe" }]);
  });

  test("a corrupt clustered event refuses the ledger", async () => {
    const somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(somaHome);
    const { deps } = harness([created(errata("E1")), { kind: "clustered", id: "E1", clusterId: "EC1", key: { kind: "theme", label: "x" }, at: now.toISOString() },
      { kind: "clustered", id: "E1", clusterId: "EC2", key: { kind: "theme", label: "y" }, at: now.toISOString() }]);
    deps.somaHome = somaHome;
    await expect(clusterErrata(deps)).rejects.toThrow("Errata already clustered: E1");
  });

  test("null-link Errata bridged by a third one's artifacts form one cluster, not two", async () => {
    const { deps, appended } = harness([
      created(errata("E1", { artifacts: ["src/a.ts"] })),
      created(errata("E2", { artifacts: ["src/b.ts"] })),
      created(errata("E3", { artifacts: ["src/a.ts", "src/b.ts"] })),
      created(errata("E4", { artifacts: ["src/c.ts"] })),
      created(errata("E5", { artifacts: ["src/d.ts", "src/c.ts"] })),
    ]);
    deps.somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(deps.somaHome);
    const result = await clusterErrata(deps);
    expect(appended().map((event) => event.kind === "clustered" && [event.id, event.clusterId, event.key])).toEqual([
      ["E1", "EC1", { kind: "artifact", path: "src/a.ts" }], ["E2", "EC1", { kind: "artifact", path: "src/a.ts" }], ["E3", "EC1", { kind: "artifact", path: "src/a.ts" }],
      ["E4", "EC2", { kind: "artifact", path: "src/c.ts" }], ["E5", "EC2", { kind: "artifact", path: "src/c.ts" }],
    ]);
    expect(result.clusters).toMatchObject([{ id: "EC1", errataIds: ["E1", "E2", "E3"], status: "ripe" }, { id: "EC2", errataIds: ["E4", "E5"], status: "ripe" }]);
  });

  test("a group bridged into an existing cluster joins it whole, the earliest cluster when it touches two", async () => {
    const { deps, appended } = harness([
      created(errata("E1", { artifacts: ["src/a.ts"] })),
      created(errata("E2", { artifacts: ["src/b.ts"] })),
      { kind: "clustered", id: "E1", clusterId: "EC1", key: { kind: "theme", label: "Missed constraint" }, at: now.toISOString() },
      { kind: "clustered", id: "E2", clusterId: "EC2", key: { kind: "theme", label: "Unverified claim" }, at: now.toISOString() },
      created(errata("E3", { artifacts: ["src/x.ts"] })),
      created(errata("E4", { artifacts: ["src/x.ts", "src/a.ts"] })),
      created(errata("E5", { artifacts: ["src/b.ts", "src/a.ts"] })),
    ]);
    deps.somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(deps.somaHome);
    await clusterErrata(deps);
    expect(appended().map((event) => event.kind === "clustered" && [event.id, event.clusterId])).toEqual([["E3", "EC1"], ["E4", "EC1"], ["E5", "EC1"]]);
  });

  test("the ledger is re-read before a verdict is committed: an Errata dropped or shared meanwhile keeps no theme", async () => {
    const { deps, events, appended, judgments } = harness([
      created(errata("E1", { artifacts: ["src/a.ts"] })),
      created(errata("E2", { artifacts: ["src/b.ts"] })),
    ], (input) => {
      // While the judge runs, E1 is dropped and a null-link Errata sharing E2's path is promoted.
      if (input.themes.length === 0) events.push(dropped("E1"), created(errata("E3", { artifacts: ["src/b.ts"] })));
      return { theme: "Missed constraint", reason: "ok", backendVersion: "1" };
    });
    deps.somaHome = await mkdtemp(join(tmpdir(), "soma-clusters-")); homes.push(deps.somaHome);
    const result = await clusterErrata(deps);
    expect(appended().filter((event) => event.kind === "clustered").map((event) => event.kind === "clustered" && [event.id, event.clusterId, event.key.kind]))
      .toEqual([["E2", "EC1", "artifact"], ["E3", "EC1", "artifact"]]);
    expect(judgments).toEqual([]);
    expect(result).toMatchObject({ clustered: 2, clusters: [{ id: "EC1", errataIds: ["E2", "E3"], status: "ripe" }] });
  });
});
