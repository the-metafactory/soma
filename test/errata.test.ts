import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendErrata, dropErrata, errataLedgerPath, linkErrataCandidate, readErrata,
  type ErrataCloseReceipt, type ErrataLinkDeps,
} from "../src/errata";
import { createAlgorithmRun, verifyAlgorithmCriterion } from "../src/algorithm";
import { writeAlgorithmRun } from "../src/algorithm-store";
import type { AlgorithmLogEntry, ErrataInput } from "../src/types";

const homes: string[] = [];
async function home() { const dir = await mkdtemp(join(tmpdir(), "soma-errata-")); homes.push(dir); return dir; }
afterEach(async () => { await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const at = (second: number) => `2026-10-14T04:00:${String(second).padStart(2, "0")}.000Z`;
const candidate = { sessionId: "session-1", transcriptPath: "/missing/transcript.jsonl", timestamp: at(40), complaint: "That output is wrong.\nPlease use the proper contract." };
const input: ErrataInput = {
  sessionId: candidate.sessionId, rejectedTurnUuid: "U2", rejectedAt: at(30),
  complaintAt: at(40), complaint: candidate.complaint, artifacts: ["src/a.ts"], passedBy: null,
};
const assistant = (uuid: string, timestamp: string, content: unknown[], cwd = "/repo") =>
  ({ type: "assistant", uuid, timestamp, sessionId: "session-1", cwd, message: { content } });
const edit = (path = "/repo/src/a.ts") => ({ type: "tool_use", name: "Edit", input: { file_path: path, old_string: "PRIVATE OUTPUT BYTES", new_string: "PRIVATE OUTPUT BYTES" } });
const jsonl = (entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const transcript = jsonl([
  { type: "user", uuid: "P1", timestamp: at(0), message: { content: "please deliver" } },
  assistant("U1", at(10), [{ type: "text", text: "PRIVATE OUTPUT BYTES" }]),
  assistant("U2", at(30), [edit()]),
  { type: "user", uuid: "complaint", timestamp: at(40), message: { content: candidate.complaint } },
  assistant("U3", at(50), [edit("/repo/src/after.ts")]),
]);
const verify = (second: number, criterionId = "C1", text = "C1: passed. tested src/a.ts"): AlgorithmLogEntry =>
  ({ timestamp: at(second), phase: "verify", text, criterionId, outcome: "passed", sessionId: candidate.sessionId });
const run = (verification: AlgorithmLogEntry[], sessionIds = [candidate.sessionId]) => ({ id: "run-1", sessionIds, verification });
const deps = (overrides: Partial<ErrataLinkDeps> = {}): ErrataLinkDeps => ({
  candidate, readTranscript: async () => transcript, readRuns: async () => [], readCloseReceipts: async () => [], ...overrides,
});
async function linked(overrides: Partial<ErrataLinkDeps> = {}) {
  const result = await linkErrataCandidate(deps(overrides));
  expect(result.status).toBe("linked");
  if (result.status !== "linked") throw new Error(result.reason);
  return result;
}
const receipt = (second: number, overrides: Partial<ErrataCloseReceipt> = {}): ErrataCloseReceipt => ({
  at: at(second), repo: "the-metafactory/soma", nodeId: "#848", receiptCommentId: "123", artifacts: ["src/a.ts"], ...overrides,
});

describe("Errata linker", () => {
  test("anchors the last assistant before complaint and extracts only artifact paths", async () => {
    const result = await linked();
    expect(result.errata).toEqual(input);
    expect(JSON.stringify(result)).not.toContain("PRIVATE OUTPUT BYTES");
  });

  test("links a same-session Algorithm verification naming the artifact", async () => {
    expect((await linked({ readRuns: async () => [run([verify(20)])] })).errata.passedBy)
      .toEqual({ kind: "algorithm-verify", runId: "run-1", criterionId: "C1" });
  });

  test("latest qualifying pass wins; passes at or after the rejected turn are ignored", async () => {
    const records = [verify(35, "AFTER"), verify(22, "LATER"), verify(20, "EARLIER"), verify(30, "SAME")];
    expect((await linked({ readRuns: async () => [run(records)] })).errata.passedBy)
      .toEqual({ kind: "algorithm-verify", runId: "run-1", criterionId: "LATER" });
  });

  test("does not infer passes from unstructured, failed, wrong-session or different-file evidence", async () => {
    const entries = [
      { ...verify(20), outcome: "failed" as const }, { ...verify(21), criterionId: undefined },
      { ...verify(22), sessionId: "other" }, verify(23, "C1", "tested src/a.ts.bak"),
      verify(24, "C1", "tested other/src/a.ts"), { ...verify(25), outcome: undefined },
    ];
    expect((await linked({ readRuns: async () => [run(entries), run([verify(26)], ["other"])] })).errata.passedBy).toBeNull();
  });

  test("historical evidence, not the criterion's latest evidence, defines artifact scope", async () => {
    const somaHome = await home();
    let stored = createAlgorithmRun({ id: "real-run", prompt: "test", intent: "test", currentState: "test", goal: "test", criteria: [{ id: "C1", text: "test" }] });
    stored = verifyAlgorithmCriterion(stored, "C1", "passed", "bun test src/a.ts", { timestamp: at(20), evidenceKind: "tested", env: { SOMA_SESSION_ID: candidate.sessionId } });
    stored = verifyAlgorithmCriterion(stored, "C1", "passed", "bun test src/after.ts", { timestamp: at(35), evidenceKind: "tested", env: { SOMA_SESSION_ID: candidate.sessionId } });
    await writeAlgorithmRun(stored, { somaHome });
    expect((await linked({ somaHome, readRuns: undefined })).errata.passedBy)
      .toEqual({ kind: "algorithm-verify", runId: "real-run", criterionId: "C1" });
  });

  test("links session-scoped graph close receipts and compares times across check kinds", async () => {
    let window: unknown;
    const result = await linked({
      readRuns: async () => [run([verify(20)])],
      readCloseReceipts: async (scope) => { window = scope; return [receipt(22), receipt(35), receipt(25, { artifacts: ["src/b.ts"] })]; },
    });
    expect(window).toEqual({ sessionId: candidate.sessionId, start: at(0), end: at(40) });
    expect(result.errata.passedBy).toEqual({ kind: "close-receipt", repo: "the-metafactory/soma", nodeId: "#848", receiptCommentId: "123" });
    expect((await linked({ readRuns: async () => [run([verify(25)])], readCloseReceipts: async () => [receipt(22)] })).errata.passedBy?.kind).toBe("algorithm-verify");
  });

  test("ignores receipts outside session window and reports unavailable attribution", async () => {
    expect((await linked({ readCloseReceipts: async () => [{ ...receipt(10), at: "2026-10-13T04:00:10.000Z" }] })).errata.passedBy).toBeNull();
    const result = await linked({ readCloseReceipts: async () => null });
    expect(result.errata.passedBy).toBeNull();
    expect(result.warnings).toEqual(["receipt-session-unattributable"]);
  });

  test("missing transcript is unlinkable, writes nothing, and permits the next candidate", async () => {
    const somaHome = await home();
    let reads = 0;
    const result = await linkErrataCandidate(deps({ somaHome, readTranscript: undefined, readRuns: async () => { reads++; return []; } }));
    expect(result).toEqual({ status: "unlinkable", reason: "transcript-missing" });
    expect(reads).toBe(0);
    expect(await Bun.file(errataLedgerPath(somaHome)).exists()).toBe(false);
    expect((await linked({ somaHome })).errata.rejectedTurnUuid).toBe("U2");
    expect(await linkErrataCandidate(deps({ readTranscript: async () => null }))).toEqual(result);
  });

  test("invalid transcripts and absent assistant turn are explicit unlinkable results", async () => {
    expect(await linkErrataCandidate(deps({ readTranscript: async () => "not json" }))).toEqual({ status: "unlinkable", reason: "transcript-invalid" });
    expect(await linkErrataCandidate(deps({ readTranscript: async () => jsonl([{ type: "assistant", timestamp: at(10) }]) })))
      .toEqual({ status: "unlinkable", reason: "transcript-invalid" });
    expect(await linkErrataCandidate(deps({ readTranscript: async () => "" })))
      .toEqual({ status: "unlinkable", reason: "rejected-turn-missing" });
  });

  test("streamed text delivery retains edits but does not include the preceding response", async () => {
    const streamed = jsonl([
      assistant("old", at(1), [edit("/repo/src/old.ts")]),
      { type: "user", timestamp: at(5), message: { content: "new request" } },
      assistant("tool", at(10), [edit()]),
      { type: "user", timestamp: at(15), message: { content: [{ type: "tool_result", content: "PRIVATE OUTPUT BYTES" }] } },
      assistant("U2", at(30), [{ type: "text", text: "PRIVATE OUTPUT BYTES" }]),
    ]);
    const result = await linked({ readTranscript: async () => streamed });
    expect(result.errata.artifacts).toEqual(["src/a.ts"]);
    expect(result.errata.rejectedTurnUuid).toBe("U2");
  });

  test("deduplicates edit tools, ignores reads and other sessions, handles absolute evidence", async () => {
    const tools = jsonl([
      assistant("U1", at(10), [edit(), edit(), { type: "tool_use", name: "Read", input: { file_path: "/repo/src/read.ts" } },
        { type: "tool_use", name: "Write", input: { file_path: "/repo/new.md", content: "PRIVATE OUTPUT BYTES" } },
        { type: "tool_use", name: "MultiEdit", input: { file_path: "src/multi.ts", edits: [] } },
        { type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/repo/book.ipynb" } }]),
      { ...assistant("OTHER", at(32), [edit()]), sessionId: "other" },
    ]);
    const result = await linked({ readTranscript: async () => tools, readRuns: async () => [run([verify(5, "C1", "tested /repo/src/a.ts")])] });
    expect(result.errata.artifacts).toEqual(["src/a.ts", "new.md", "src/multi.ts", "book.ipynb"]);
    expect(result.errata.passedBy?.kind).toBe("algorithm-verify");
    expect(JSON.stringify(result)).not.toContain("PRIVATE OUTPUT BYTES");
  });
});

describe("Errata ledger", () => {
  test("allocates ids in order and appends veto without rewriting history", async () => {
    const somaHome = await home();
    expect((await appendErrata(somaHome, input)).id).toBe("E1");
    expect((await appendErrata(somaHome, input)).id).toBe("E2");
    const before = await readFile(errataLedgerPath(somaHome), "utf8");
    await dropErrata(somaHome, "E2");
    const after = await readFile(errataLedgerPath(somaHome), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(JSON.parse(after.trim().split("\n")[2]).kind).toBe("dropped");
    expect((await readErrata(somaHome)).map((record) => record.id)).toEqual(["E1"]);
    expect((await readErrata(somaHome, { all: true })).map((record) => record.status)).toEqual(["active", "dropped"]);
    await expect(dropErrata(somaHome, "E99")).rejects.toThrow("Unknown Errata id");
    expect(await readFile(errataLedgerPath(somaHome), "utf8")).toBe(after);
    await dropErrata(somaHome, "E2");
    expect(await readFile(errataLedgerPath(somaHome), "utf8")).toBe(after);
    expect((await appendErrata(somaHome, input)).id).toBe("E3");
  });

  test("concurrent independent processes never reuse an id", async () => {
    const somaHome = await home();
    const module = resolve(import.meta.dir, "../src/errata.ts");
    const source = `import { appendErrata } from ${JSON.stringify(module)}; await appendErrata(${JSON.stringify(somaHome)}, ${JSON.stringify(input)});`;
    const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" }));
    const exits = await Promise.all(children.map(async (child) => ({ exit: await child.exited, error: await new Response(child.stderr).text() })));
    expect(exits).toEqual(Array.from({ length: 8 }, () => ({ exit: 0, error: "" })));
    expect((await readErrata(somaHome)).map((record) => record.id)).toEqual(Array.from({ length: 8 }, (_, index) => `E${index + 1}`));
  });

  test("redacts every feedback secret pattern, preserves full multiline complaint, caps at 2000", async () => {
    const somaHome = await home();
    const complaint = "sk-abcdefghijklmnop ghp_abcdefghijklmnop github_pat_abcdefghijklmnop xoxb-abcdefghijklmnop AKIA1234567890ABCDEF Bearer abcDEF123 token=supersecret password:othersecret\n" + "x".repeat(2100);
    await appendErrata(somaHome, { ...input, complaint, output: "PRIVATE OUTPUT BYTES", passedBy: null } as ErrataInput);
    const raw = await readFile(errataLedgerPath(somaHome), "utf8");
    for (const secret of ["abcdefghijklmnop", "AKIA1234567890ABCDEF", "abcDEF123", "supersecret", "othersecret", "PRIVATE OUTPUT BYTES"]) expect(raw).not.toContain(secret);
    const [record] = await readErrata(somaHome);
    expect(record.complaint.length).toBe(2000);
    expect(record.complaint).toContain("\n");
    expect(record.complaint.match(/\[redacted\]/g)?.length).toBe(8);
    if (process.platform !== "win32") expect((await stat(errataLedgerPath(somaHome))).mode & 0o777).toBe(0o600);
  });

  test("refuses corrupt ledger rather than allocating duplicate ids", async () => {
    const somaHome = await home();
    await appendErrata(somaHome, input);
    const path = errataLedgerPath(somaHome);
    const corrupt = (await readFile(path, "utf8")) + "{partial";
    await writeFile(path, corrupt);
    await expect(appendErrata(somaHome, input)).rejects.toThrow("Incomplete Errata");
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });
});
