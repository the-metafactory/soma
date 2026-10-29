import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendErrata, errataLedgerPath } from "../src/flows/errata";
import { parseErrataArgs } from "../src/cli/errata";
import { stageRuntimeArtifact } from "../src/substrates/runtime-artifact";
import type { ErrataEvent, ErrataInput } from "../src/flows/types";
import { appendEventBatch, somaMemoryEventsPath } from "../src/events/index";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function cli(args: string[], entry = resolve(import.meta.dir, "../src/cli.ts")) {
  const child = Bun.spawn([process.execPath, entry, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

async function sessionFixture() {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-errata-session-cli-")); homes.push(somaHome);
  const input: ErrataInput = {
    sessionId: "S", rejectedTurnUuid: "U1", rejectedAt: "2026-10-14T04:00:30Z",
    complaintAt: "2026-10-14T04:00:40Z", complaint: "private complaint",
    artifacts: ["src/a.ts"], passedBy: { kind: "algorithm-verify", runId: "run-1", criterionId: "C1" },
  };
  const e1 = await appendErrata(somaHome, input);
  const e2 = await appendErrata(somaHome, {
    ...input, rejectedTurnUuid: "U2", artifacts: ["src/b.ts", "docs/b.md"],
    passedBy: { kind: "close-receipt", repo: "example/repo", nodeId: "42", receiptCommentId: "123" },
  });
  await appendErrata(somaHome, { ...input, sessionId: "T", passedBy: null });
  await appendErrata(somaHome, { ...input, sessionId: "S-suffix", passedBy: null });
  return { somaHome, e1, e2 };
}

test("session list returns only matching complete Errata records without changing the ledger", async () => {
  const { somaHome, e1, e2 } = await sessionFixture();
  const before = await readFile(errataLedgerPath(somaHome), "utf8");
  const list = await cli(["errata", "list", "--session", "S", "--json", "--soma-home", somaHome]);
  expect(list.exit).toBe(0);
  expect(list.stderr).toBe("");
  expect(JSON.parse(list.stdout)).toEqual([e1, e2]);
  const text = await cli(["errata", "list", "--session", "S", "--soma-home", somaHome]);
  expect(text.exit).toBe(0);
  expect(text.stdout.trim().split("\n")).toEqual([
    "E1\tactive\tS\tU1\tsrc/a.ts", "E2\tactive\tS\tU2\tsrc/b.ts, docs/b.md",
  ]);
  expect(await readFile(errataLedgerPath(somaHome), "utf8")).toBe(before);
});

test("session JSON list with no matching Errata prints [] and exits zero", async () => {
  const { somaHome } = await sessionFixture();
  for (const flags of [[], ["--all"]]) {
    const result = await cli(["errata", "list", "--session", "missing", "--json", ...flags, "--soma-home", somaHome]);
    expect(result).toEqual({ stdout: "[]\n", stderr: "", exit: 0 });
  }
  const emptyHome = await mkdtemp(join(tmpdir(), "soma-errata-empty-cli-")); homes.push(emptyHome);
  expect(await cli(["errata", "list", "--session", "S", "--json", "--soma-home", emptyHome]))
    .toEqual({ stdout: "[]\n", stderr: "", exit: 0 });
});

test("session list excludes dropped Errata unless --all is passed", async () => {
  const { somaHome, e1, e2 } = await sessionFixture();
  expect((await cli(["errata", "drop", "E2", "--soma-home", somaHome])).exit).toBe(0);
  const args = ["errata", "list", "--session", "S", "--json", "--soma-home", somaHome];
  const active = await cli(args);
  expect(active.exit).toBe(0);
  expect(JSON.parse(active.stdout)).toEqual([e1]);
  const all = await cli([...args, "--all"]);
  expect(all.exit).toBe(0);
  expect(JSON.parse(all.stdout)).toEqual([e1, { ...e2, status: "dropped" }]);
});

test("registered list/drop CLI implements veto and --all, unknown drop fails without append", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-errata-cli-")); homes.push(somaHome);
  const input = { sessionId: "session", rejectedTurnUuid: "U2", rejectedAt: "2026-10-14T04:00:30Z", complaintAt: "2026-10-14T04:00:40Z", complaint: "private complaint", artifacts: ["src/a.ts"], passedBy: null };
  await appendErrata(somaHome, input);
  await appendErrata(somaHome, input);
  expect((await cli(["errata", "list", "--soma-home", somaHome])).stdout).toContain("E2\tactive");
  const drop = await cli(["errata", "drop", "E2", "--soma-home", somaHome]);
  expect(drop.exit).toBe(0);
  expect(drop.stdout).toContain("Dropped E2");
  const list = await cli(["errata", "list", "--json", "--soma-home", somaHome]);
  expect(list.exit).toBe(0);
  expect(JSON.parse(list.stdout).map((record: { id: string }) => record.id)).toEqual(["E1"]);
  const all = await cli(["errata", "list", "--all", "--json", "--soma-home", somaHome]);
  expect(JSON.parse(all.stdout).map((record: { status: string }) => record.status)).toEqual(["active", "dropped"]);
  const before = await readFile(errataLedgerPath(somaHome), "utf8");
  const unknown = await cli(["errata", "drop", "E99", "--soma-home", somaHome]);
  expect(unknown.exit).not.toBe(0);
  expect(unknown.stderr).toContain("Unknown Errata id");
  expect(await readFile(errataLedgerPath(somaHome), "utf8")).toBe(before);
});

test("Errata reads and vetoes from a standalone installed runtime without node_modules", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-errata-runtime-")); homes.push(somaHome);
  const artifact = await stageRuntimeArtifact({ somaHome, target: "cli", sourceRoot: resolve(import.meta.dir, "..") });
  const entry = join(artifact.path, "src", "cli.ts");
  expect((await cli(["errata", "list", "--soma-home", somaHome], entry)).stdout).toContain("No Errata");
  await appendErrata(somaHome, { sessionId: "session", rejectedTurnUuid: "U2", rejectedAt: "2026-10-14T04:00:30Z", complaintAt: "2026-10-14T04:00:40Z", complaint: "private complaint", artifacts: ["src/a.ts"], passedBy: null });
  expect((await cli(["errata", "drop", "E1", "--soma-home", somaHome], entry)).exit).toBe(0);
  const all = await cli(["errata", "list", "--all", "--json", "--soma-home", somaHome], entry);
  expect(all.exit).toBe(0);
  expect(JSON.parse(all.stdout)[0].status).toBe("dropped");
});

test("Errata help and argument validation", async () => {
  expect((await cli(["errata", "--help"])).stdout).toContain("list|drop");
  expect((await cli(["errata", "list", "--help"])).stdout).toContain("--session <id>");
  expect(parseErrataArgs(["errata", "list", "--session", "S", "--json"]).options).toEqual({ session: "S", json: true });
  expect(() => parseErrataArgs(["errata", "list", "--session"])).toThrow("--session requires a value");
  expect(() => parseErrataArgs(["errata", "list", "--session", "--json"])).toThrow("--session requires a value");
  expect(() => parseErrataArgs(["errata", "drop", "E1", "--session", "S"])).toThrow();
  expect(() => parseErrataArgs(["errata", "triage", "--session", "S"])).toThrow();
  expect((await cli(["errata", "triage", "--help"])).stdout).toContain("soma errata triage");
  expect(parseErrataArgs(["errata", "triage", "--home-dir", "/tmp/test-home"]).action).toBe("triage");
  expect(() => parseErrataArgs(["errata", "triage", "--all"])).toThrow();
  expect(() => parseErrataArgs(["errata", "triage", "E1"])).toThrow();
  expect((await cli(["errata", "drop", "--help"])).stdout).toContain("E<n>");
  expect(() => parseErrataArgs(["errata", "drop", "../E2"])).toThrow();
  expect(() => parseErrataArgs(["errata", "drop", "E2", "--all"])).toThrow();
  expect(() => parseErrataArgs(["errata", "list", "--soma-home"])).toThrow();
});

async function landedFixture() {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-errata-landed-cli-")); homes.push(somaHome);
  const ref = "errata-artifact-src-a-g1";
  const events: ErrataEvent[] = [];
  for (let index = 1; index <= 9; index++) {
    const at = index <= 6 ? "2026-10-14T12:00:00.000Z" : "2026-10-16T12:00:00.000Z";
    const record = await appendErrata(somaHome, {
      sessionId: "S", rejectedTurnUuid: `U${index}`, rejectedAt: at, complaintAt: at,
      complaint: "private complaint", artifacts: ["src/a.ts"], passedBy: null,
    });
    events.push({ kind: "clustered", id: record.id, clusterId: "EC1", key: { kind: "artifact", path: "src/a.ts" }, at });
  }
  events.push(
    { kind: "proposed", clusterId: "EC1", ref, generation: 1, landing: "example/repo", proposalKind: "deterministic-check", at: "2026-10-14T12:00:00.000Z" },
    { kind: "resolved", clusterId: "EC1", ref, nodeRef: "example/repo#1", at: "2026-10-14T13:00:00.000Z" },
    { kind: "node-closed", clusterId: "EC1", ref, nodeRef: "example/repo#1", at: "2026-10-15T12:00:00.000Z" },
    { kind: "proposed", clusterId: "EC1", ref: "errata-artifact-src-a-g2", generation: 2, landing: "example/repo", proposalKind: "deterministic-check", at: "2026-10-17T12:00:00.000Z" },
  );
  await appendFile(errataLedgerPath(somaHome), events.map((event) => JSON.stringify(event) + "\n").join(""));
  const feedback = Array.from({ length: 24 }, (_, index) => ({
    id: `F${index}`, timestamp: index < 12 ? "2026-10-14T12:00:00.000Z" : "2026-10-16T12:00:00.000Z",
    substrate: "codex", kind: "feedback.candidate", summary: "feedback", metadata: { actor: "interactive" },
  }));
  const feedbackPath = somaMemoryEventsPath(somaHome);
  await writeFile(feedbackPath, feedback.map((event) => JSON.stringify(event) + "\n").join(""));
  return { somaHome, ref, feedbackPath };
}

test("landed CLI reports rates, counts and dates in text and JSON without changing private state", async () => {
  const { somaHome, ref, feedbackPath } = await landedFixture();
  const before = await readFile(errataLedgerPath(somaHome), "utf8");
  const beforeFeedback = await readFile(feedbackPath, "utf8");
  const files = await readdir(somaHome, { recursive: true });
  const result = await cli(["errata", "landed", ref, "--json", "--soma-home", somaHome]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  const row = JSON.parse(result.stdout);
  expect(row).toEqual({
    ref, clusterId: "EC1", key: { kind: "artifact", path: "src/a.ts" }, landedAt: "2026-10-15T12:00:00.000Z", windowDays: 14,
    verdict: "lower", reason: null,
    before: { start: "2026-10-01T12:00:00.000Z", end: "2026-10-15T12:00:00.000Z", errata: 6, candidates: 12, rate: 0.5 },
    after: { start: "2026-10-15T12:00:00.000Z", end: "2026-10-29T12:00:00.000Z", errata: 3, candidates: 12, rate: 0.25 },
  });
  const text = await cli(["errata", "landed", ref, "--soma-home", somaHome]);
  expect(text.exit).toBe(0);
  expect(text.stdout.trim().split("\t")).toEqual([
    ref, "lower", 'clusterId=EC1 key={"kind":"artifact","path":"src/a.ts"}',
    "landedAt=2026-10-15T12:00:00.000Z", "windowDays=14",
    "before=[2026-10-01T12:00:00.000Z, 2026-10-15T12:00:00.000Z) errata=6 candidates=12 rate=0.5",
    "after=[2026-10-15T12:00:00.000Z, 2026-10-29T12:00:00.000Z) errata=3 candidates=12 rate=0.25", "reason=none",
  ]);
  const all = await cli(["errata", "landed", "--all", "--json", "--soma-home", somaHome]);
  expect(all.exit).toBe(0);
  expect(JSON.parse(all.stdout)).toEqual([
    row,
    { ref: "errata-artifact-src-a-g2", clusterId: "EC1", key: row.key, windowDays: 14,
      verdict: "insufficient-data", reason: "missing-node-closed", landedAt: null, before: null, after: null },
  ]);
  const allText = await cli(["errata", "landed", "--all", "--soma-home", somaHome]);
  expect(allText.exit).toBe(0);
  expect(allText.stdout.trim().split("\n")).toHaveLength(2);
  expect(allText.stdout).toContain("reason=missing-node-closed");
  expect(await readFile(errataLedgerPath(somaHome), "utf8")).toBe(before);
  expect(await readFile(feedbackPath, "utf8")).toBe(beforeFeedback);
  expect(await readdir(somaHome, { recursive: true })).toEqual(files);
  expect((await cli(["errata", "list", "--json", "--soma-home", somaHome])).exit).toBe(0);
});

test("landed fails nonzero naming missing node-closed, unknown proposals and malformed ledgers", async () => {
  const { somaHome, ref, feedbackPath } = await landedFixture();
  const missing = await cli(["errata", "landed", "errata-artifact-src-a-g2", "--soma-home", somaHome]);
  expect(missing.exit).not.toBe(0);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toContain("node-closed");
  const unknown = await cli(["errata", "landed", "unknown", "--soma-home", somaHome]);
  expect(unknown.exit).not.toBe(0);
  expect(unknown.stderr).toContain("Unknown Errata proposal");
  await appendFile(feedbackPath, "{malformed}\n");
  const badFeedback = await cli(["errata", "landed", ref, "--soma-home", somaHome]);
  expect(badFeedback.exit).not.toBe(0);
  expect(badFeedback.stderr).toContain("Invalid feedback event ledger");
  await appendFile(errataLedgerPath(somaHome), '{"kind":"node-closed"}');
  const torn = await cli(["errata", "landed", ref, "--soma-home", somaHome]);
  expect(torn.exit).not.toBe(0);
  expect(torn.stderr).toContain("Incomplete Errata ledger");
});

test("landed includes rotated feedback segments and returns insufficient-data for zero denominators", async () => {
  const { somaHome, ref, feedbackPath } = await landedFixture();
  const feedback = await readFile(feedbackPath);
  const other = Buffer.from(JSON.stringify({ id: "other", kind: "lifecycle.session_end", substrate: "codex", timestamp: "2026-10-16T12:00:00.000Z", summary: "end" }) + "\n");
  await writeFile(feedbackPath, "");
  await appendEventBatch(feedbackPath, feedback, feedback.byteLength);
  await appendEventBatch(feedbackPath, other, feedback.byteLength);
  const rotated = await cli(["errata", "landed", ref, "--json", "--soma-home", somaHome]);
  expect(rotated).toMatchObject({ exit: 0, stderr: "" });
  expect(JSON.parse(rotated.stdout).verdict).toBe("lower");
  const unobserved = await landedFixture();
  await writeFile(unobserved.feedbackPath, "");
  const empty = await cli(["errata", "landed", ref, "--json", "--soma-home", unobserved.somaHome]);
  expect(empty.exit).toBe(0);
  expect(JSON.parse(empty.stdout)).toMatchObject({ verdict: "insufficient-data", reason: "zero-denominator", before: { candidates: 0, rate: null }, after: { candidates: 0, rate: null } });
});

test("landed empty ledger and help work through the CLI; invalid selections are rejected", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-errata-landed-empty-")); homes.push(somaHome);
  expect(await cli(["errata", "landed", "--all", "--soma-home", somaHome]))
    .toEqual({ exit: 0, stdout: "No Errata proposals.\n", stderr: "" });
  expect(await cli(["errata", "landed", "--all", "--json", "--soma-home", somaHome]))
    .toEqual({ exit: 0, stdout: "[]\n", stderr: "" });
  expect((await cli(["errata", "landed", "--help"])).stdout).toContain("<proposal-ref>|--all");
  expect(parseErrataArgs(["errata", "landed", "errata-key-g1", "--json"]).id).toBe("errata-key-g1");
  for (const args of [[], ["--json"], ["--all", "errata-key-g1"], ["../bad"], ["--all", "--session", "S"], ["a", "b"]]) {
    expect(() => parseErrataArgs(["errata", "landed", ...args])).toThrow();
  }
});
