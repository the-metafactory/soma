import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, normalize, relative, isAbsolute } from "node:path";
import { listAlgorithmRuns } from "./algorithm-store";
import { redactSomaFeedbackText } from "./feedback";
import type { AlgorithmRun, ErrataEvent, ErrataInput, ErrataPassedBy, ErrataRecord, SomaMemoryEvent } from "./types";
import { parseTelemetryEventLine, streamEventLines } from "./event-log";
import { somaMemoryEventsPath } from "./event-journal";
import { hashJudgmentInput, readJudgments, recordJudgment, type JudgmentRecord } from "./core/index";
import { classifyErrataWithClaude, validateErrataVerdict, type ErrataTriageVerdict } from "./errata-classifier";
import { publishRunFinished, type RunFinishedInput, type RunLedgerDeps } from "./run-ledger";

function stringField(data: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = data[key];
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) throw new Error(`Invalid Errata ${key}.`);
  return value;
}

function timestampField(data: Record<string, unknown>, key: string): string {
  const value = stringField(data, key);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid Errata ${key}.`);
  return value;
}

function idField(data: Record<string, unknown>): string {
  const id = stringField(data, "id");
  if (!/^E[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id.slice(1)))) throw new Error("Invalid Errata id.");
  return id;
}

function parseInput(raw: unknown): ErrataInput {
  const data = object(raw);
  let passedBy: ErrataPassedBy | null = null;
  if (data.passedBy !== null) {
    const pass = object(data.passedBy);
    if (pass.kind === "algorithm-verify") passedBy = { kind: pass.kind, runId: stringField(pass, "runId"), criterionId: stringField(pass, "criterionId") };
    else if (pass.kind === "close-receipt") passedBy = { kind: pass.kind, repo: stringField(pass, "repo"), nodeId: stringField(pass, "nodeId"), receiptCommentId: stringField(pass, "receiptCommentId") };
    else throw new Error("Invalid Errata passedBy.");
  }
  if (!Array.isArray(data.artifacts)) throw new Error("Invalid Errata artifacts.");
  const artifacts = (data.artifacts as unknown[]).map((path) => {
    if (typeof path !== "string" || !path.trim()) throw new Error("Invalid Errata artifact path.");
    return path;
  });
  return {
    sessionId: stringField(data, "sessionId"), rejectedTurnUuid: stringField(data, "rejectedTurnUuid"),
    rejectedAt: timestampField(data, "rejectedAt"), complaintAt: timestampField(data, "complaintAt"),
    complaint: stringField(data, "complaint", true), artifacts, passedBy,
  };
}

function parseEvent(raw: unknown): ErrataEvent {
  const data = object(raw);
  if (data.kind === "dropped") return { kind: data.kind, id: idField(data), at: timestampField(data, "at") };
  if (data.kind !== "created") throw new Error("Invalid Errata event kind.");
  const record = object(data.record);
  if (record.status !== "active") throw new Error("Errata creation must be active.");
  return { kind: data.kind, record: { ...parseInput(record), id: idField(record), status: record.status, createdAt: timestampField(record, "createdAt") } };
}

/** Private append-only state, never a public run-ledger envelope. */
export function errataLedgerPath(somaHome: string): string {
  return join(somaHome, "memory", "STATE", "errata", "ledger.jsonl");
}

async function withLedgerLock<T>(somaHome: string, action: () => Promise<T>, name = ".lock"): Promise<T> {
  const dir = join(somaHome, "memory", "STATE", "errata");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, name);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never steal a lock: even a paused writer must retain its allocation.
      if (Date.now() >= deadline) throw new Error(`Errata ledger is locked: ${lock}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true }); }
}

async function readEvents(somaHome: string): Promise<ErrataEvent[]> {
  let text: string;
  try { text = await readFile(errataLedgerPath(somaHome), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // Refuse a corrupt/torn ledger instead of risking reuse of an allocated id.
  if (text !== "" && !text.endsWith("\n")) throw new Error("Incomplete Errata ledger event.");
  return text.split("\n").filter(Boolean).map((line) => parseEvent(JSON.parse(line)));
}

function foldEvents(events: ErrataEvent[]): ErrataRecord[] {
  const records = new Map<string, ErrataRecord>();
  for (const event of events) {
    if (event.kind === "created") {
      if (records.has(event.record.id)) throw new Error(`Duplicate Errata id: ${event.record.id}`);
      records.set(event.record.id, event.record);
    } else {
      const record = records.get(event.id);
      if (!record) throw new Error(`Unknown Errata id in ledger: ${event.id}`);
      records.set(event.id, { ...record, status: "dropped" });
    }
  }
  return [...records.values()];
}

async function writeEvent(somaHome: string, event: ErrataEvent): Promise<void> {
  const file = await open(errataLedgerPath(somaHome), "a", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await file.sync();
  } finally { await file.close(); }
}

export async function appendErrata(somaHome: string, input: ErrataInput): Promise<ErrataRecord> {
  // Parsing strips unknown fields; tool inputs and assistant content cannot leak through a spread.
  const data = parseInput(input);
  return withLedgerLock(somaHome, async () => {
    const records = foldEvents(await readEvents(somaHome));
    const number = records.reduce((max, record) => Math.max(max, Number(record.id.slice(1))), 0) + 1;
    if (!Number.isSafeInteger(number)) throw new Error("Errata id space exhausted.");
    const record: ErrataRecord = {
      ...data, complaint: redactSomaFeedbackText(data.complaint).slice(0, 2_000),
      id: `E${number}`, status: "active", createdAt: new Date().toISOString(),
    };
    await writeEvent(somaHome, { kind: "created", record });
    return record;
  });
}

export async function readErrata(somaHome: string, options: { all?: boolean } = {}): Promise<ErrataRecord[]> {
  return withLedgerLock(somaHome, async () =>
    foldEvents(await readEvents(somaHome)).filter((record) => options.all === true || record.status !== "dropped"));
}

export async function dropErrata(somaHome: string, id: string): Promise<void> {
  await withLedgerLock(somaHome, async () => {
    const record = foldEvents(await readEvents(somaHome)).find((record) => record.id === id);
    if (!record) throw new Error(`Unknown Errata id: ${id}`);
    if (record.status === "dropped") return;
    await writeEvent(somaHome, { kind: "dropped", id, at: new Date().toISOString() });
  });
}

export interface ErrataCandidate {
  sessionId: string;
  transcriptPath: string;
  timestamp: string;
  /** Full complaint supplied locally by the triager, never an assistant output. */
  complaint: string;
}

export interface ErrataSessionWindow { sessionId: string; start: string; end: string }
export interface ErrataCloseReceipt {
  repo: string; nodeId: string; receiptCommentId: string; at: string;
  /** Files touched by the node's PR, resolved by the reader. */
  artifacts: string[];
}

export interface ErrataLinkDeps {
  candidate: ErrataCandidate;
  somaHome?: string;
  readTranscript?: (path: string) => Promise<string | null>;
  readRuns?: () => Promise<readonly Pick<AlgorithmRun, "id" | "sessionIds" | "verification">[]>;
  /**
   * Return only receipts attributable to this session, using its time window.
   * Return null if attribution cannot be established (e.g. overlapping sessions).
   * The caller must escalate that limitation; no new receipt key is invented here.
   */
  readCloseReceipts: (window: ErrataSessionWindow) => Promise<readonly ErrataCloseReceipt[] | null>;
}

export type ErrataLinkResult =
  | { status: "linked"; errata: ErrataInput; warnings: string[] }
  | { status: "unlinkable"; reason: "transcript-missing" | "transcript-invalid" | "rejected-turn-missing" };

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function artifactPath(path: string, cwd?: string): string {
  const normalized = normalize(path);
  return cwd && isAbsolute(normalized) ? relative(cwd, normalized) : normalized.replace(/^\.\//, "");
}

function touchedFiles(entry: Record<string, unknown>): string[] {
  const content = object(entry.message).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw: unknown) => {
    const block = object(raw);
    if (block.type !== "tool_use" || !["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(String(block.name))) return [];
    const input = object(block.input);
    const path = input.file_path ?? input.notebook_path;
    return typeof path === "string" ? [path] : [];
  });
}

function isPrompt(entry: Record<string, unknown>): boolean {
  if (entry.type !== "user") return false;
  const content = object(entry.message).content;
  return !Array.isArray(content) || !content.every((block: unknown) => object(block).type === "tool_result");
}

function lastIndex(entries: Record<string, unknown>[], predicate: (entry: Record<string, unknown>) => boolean): number {
  for (let index = entries.length - 1; index >= 0; index--) if (predicate(entries[index])) return index;
  return -1;
}

function evidenceNames(text: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w./-])${escaped}(?=$|[^\\w./-])`).test(text);
}

/** Read-only linker: the triager separately appends a linked result. Missing transcripts never write. */
export async function linkErrataCandidate(deps: ErrataLinkDeps): Promise<ErrataLinkResult> {
  const { candidate } = deps;
  let transcript: string | null;
  try { transcript = await (deps.readTranscript ?? ((path) => readFile(path, "utf8")))(candidate.transcriptPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "unlinkable", reason: "transcript-missing" };
    throw error;
  }
  if (transcript === null) return { status: "unlinkable", reason: "transcript-missing" };
  let entries: Record<string, unknown>[];
  try { entries = transcript.split("\n").filter((line) => line.trim()).map((line) => object(JSON.parse(line))); }
  catch { return { status: "unlinkable", reason: "transcript-invalid" }; }
  const complaintTime = Date.parse(candidate.timestamp);
  if (!candidate.sessionId || !Number.isFinite(complaintTime)) return { status: "unlinkable", reason: "transcript-invalid" };
  entries = entries.filter((entry) => entry.sessionId === undefined || entry.sessionId === candidate.sessionId);
  if (entries.some((entry) => entry.type === "assistant" &&
    (typeof entry.uuid !== "string" || !Number.isFinite(Date.parse(String(entry.timestamp)))))) {
    return { status: "unlinkable", reason: "transcript-invalid" };
  }
  const before = entries.filter((entry) => Date.parse(String(entry.timestamp)) < complaintTime)
    .sort((a, b) => Date.parse(String(a.timestamp)) - Date.parse(String(b.timestamp)));
  const rejectedIndex = lastIndex(before, (entry) => entry.type === "assistant");
  if (rejectedIndex < 0) return { status: "unlinkable", reason: "rejected-turn-missing" };
  const rejected = before[rejectedIndex];
  const rejectedAt = String(rejected.timestamp);
  const rejectedTime = Date.parse(rejectedAt);
  const cwd = typeof rejected.cwd === "string" ? rejected.cwd : undefined;
  // Claude streams one delivered response over several assistant/tool entries.
  // Include its tool calls since the last principal prompt, excluding tool-result users.
  const promptIndex = lastIndex(before.slice(0, rejectedIndex), isPrompt);
  const artifacts = [...new Set(before.slice(promptIndex + 1, rejectedIndex + 1)
    .flatMap(touchedFiles).map((path) => artifactPath(path, cwd)))];
  const passes: { at: number; passedBy: ErrataPassedBy }[] = [];
  const runs = await (deps.readRuns ?? (async () => (await listAlgorithmRuns({ somaHome: deps.somaHome })).map(({ run }) => run)))();
  for (const run of runs) {
    if (!run.sessionIds?.includes(candidate.sessionId)) continue;
    for (const entry of run.verification) {
      const at = Date.parse(entry.timestamp);
      if (entry.sessionId === candidate.sessionId && entry.outcome === "passed" && entry.criterionId && at < rejectedTime &&
        artifacts.some((path) => evidenceNames(entry.text, path) || (cwd && evidenceNames(entry.text, join(cwd, path))))) {
        passes.push({ at, passedBy: { kind: "algorithm-verify", runId: run.id, criterionId: entry.criterionId } });
      }
    }
  }
  const window = { sessionId: candidate.sessionId, start: String(before[0].timestamp), end: candidate.timestamp };
  const receipts = await deps.readCloseReceipts(window);
  for (const receipt of receipts ?? []) {
    const at = Date.parse(receipt.at);
    if (at >= Date.parse(window.start) && at < rejectedTime &&
      receipt.artifacts.some((path) => artifacts.includes(artifactPath(path, cwd)))) {
      passes.push({ at, passedBy: { kind: "close-receipt", repo: receipt.repo, nodeId: receipt.nodeId, receiptCommentId: receipt.receiptCommentId } });
    }
  }
  passes.sort((a, b) => b.at - a.at);
  return {
    status: "linked", warnings: receipts === null ? ["receipt-session-unattributable"] : [],
    errata: {
      sessionId: candidate.sessionId, rejectedTurnUuid: String(rejected.uuid), rejectedAt,
      complaintAt: candidate.timestamp, complaint: redactSomaFeedbackText(candidate.complaint).slice(0, 2_000),
      artifacts, passedBy: passes[0]?.passedBy ?? null,
    },
  };
}

export interface ErrataTriageDeps extends RunLedgerDeps {
  somaHome: string;
  now?: () => Date;
  readEvents?: () => Promise<readonly SomaMemoryEvent[]>;
  classify?: (redactedText: string) => Promise<ErrataTriageVerdict>;
  link?: (candidate: ErrataCandidate) => Promise<ErrataLinkResult>;
  readCloseReceipts?: ErrataLinkDeps["readCloseReceipts"];
  append?: (input: ErrataInput) => Promise<ErrataRecord>;
  readJudgments?: () => Promise<{ records: JudgmentRecord[]; malformed: number }>;
  recordJudgment?: (record: JudgmentRecord) => Promise<boolean>;
  publishRun?: (input: RunFinishedInput) => Promise<unknown>;
}

export interface ErrataTriageResult {
  outcome: "succeeded" | "failed";
  promoted: number;
  dropped: number;
  skipped: number;
  unlinkable: number;
  detailRef: string;
}

async function readFeedbackCandidates(somaHome: string): Promise<SomaMemoryEvent[]> {
  const events: SomaMemoryEvent[] = [];
  // Include rotated segments; a narrow recent-events limit would silently lose candidates.
  for await (const line of streamEventLines(somaMemoryEventsPath(somaHome))) {
    const event = parseTelemetryEventLine(line);
    if (event?.kind === "feedback.candidate") events.push(event);
  }
  return events;
}

/** One autonomous job. Classifier failure commits no verdicts, including explicit markers. */
export async function runErrataTriage(deps: ErrataTriageDeps): Promise<ErrataTriageResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const runId = randomUUID();
  const detailRef = join(deps.somaHome, "memory", "STATE", "errata", "triage-runs", `${runId}.json`);
  const result: ErrataTriageResult = { outcome: "succeeded", promoted: 0, dropped: 0, skipped: 0, unlinkable: 0, detailRef };
  try {
    await withLedgerLock(deps.somaHome, async () => {
      const ledger = await (deps.readJudgments ?? (() => readJudgments(deps.somaHome, { caller: "errata-triage" })))();
      if (ledger.malformed !== 0) throw new Error("Errata judgment ledger is malformed.");
      const seen = new Set(ledger.records.filter((record) => record.caller === "errata-triage")
        .map((record) => record.decision.eventId));
      const staged: { event: SomaMemoryEvent; text: string; verdict: ErrataTriageVerdict; backend: string; latencyMs: number }[] = [];
      for (const event of await (deps.readEvents ?? (() => readFeedbackCandidates(deps.somaHome)))()) {
        if (event.kind !== "feedback.candidate" || seen.has(event.id)) continue;
        seen.add(event.id);
        const metadata = event.metadata ?? {};
        if (metadata.actor !== "interactive" || typeof metadata.redactedExcerpt !== "string" || !metadata.redactedExcerpt.trim()) {
          result.skipped++;
          continue;
        }
        const text = redactSomaFeedbackText(metadata.redactedExcerpt).trim();
        const explicit = text.startsWith("errata:");
        const before = now().getTime();
        const verdict = explicit
          ? { verdict: "promote" as const, reason: "Explicit Errata marker.", backendVersion: "1" }
          : await (deps.classify ?? classifyErrataWithClaude)(text);
        validateErrataVerdict(verdict);
        staged.push({ event, text, verdict, backend: explicit ? "explicit-marker" : "claude-p", latencyMs: Math.max(0, now().getTime() - before) });
      }
      for (const { event, text, verdict, backend, latencyMs } of staged) {
        let status: "promoted" | "dropped" | "unlinkable" = "dropped";
        let errataId: string | undefined;
        if (verdict.verdict === "promote") {
          const metadata = event.metadata ?? {};
          if (typeof metadata.sessionId !== "string" || !metadata.sessionId.trim()
            || typeof metadata.transcriptPath !== "string" || !metadata.transcriptPath.trim()) {
            status = "unlinkable";
          } else {
            const candidate = { sessionId: metadata.sessionId, transcriptPath: metadata.transcriptPath, timestamp: event.timestamp, complaint: text };
            const linked = await (deps.link ?? ((candidate) => linkErrataCandidate({
              candidate, somaHome: deps.somaHome,
              // A local batch cannot establish graph-receipt session attribution.
              readCloseReceipts: deps.readCloseReceipts ?? (() => Promise.resolve(null)),
            })))(candidate);
            if (linked.status === "unlinkable") status = "unlinkable";
            else {
              // Recover an append whose judgment write failed, without duplicating the rejection.
              const existing = deps.append ? undefined : (await readErrata(deps.somaHome, { all: true })).find((record) =>
                record.sessionId === linked.errata.sessionId && record.rejectedTurnUuid === linked.errata.rejectedTurnUuid
                && record.complaintAt === linked.errata.complaintAt && record.complaint === linked.errata.complaint);
              const record = existing ?? await (deps.append ?? ((input) => appendErrata(deps.somaHome, input)))(linked.errata);
              errataId = record.id;
              status = "promoted";
            }
          }
        }
        result[status === "promoted" ? "promoted" : status === "dropped" ? "dropped" : "unlinkable"]++;
        const recorded = await (deps.recordJudgment ?? ((record) => recordJudgment(deps.somaHome, record)))({
          v: 1, ts: now().toISOString(), caller: "errata-triage", substrate: event.substrate,
          inputSha256: hashJudgmentInput(text), backend, backendVersion: verdict.backendVersion,
          decision: { verdict: verdict.verdict, reason: redactSomaFeedbackText(verdict.reason), eventId: event.id, status,
            ...(errataId ? { errataId } : {}) },
          latencyMs,
        });
        if (!recorded) throw new Error("Errata judgment could not be recorded.");
      }
    }, ".triage-lock");
  } catch {
    // Neither subprocess output nor complaint text belongs in CLI logs or the run report.
    result.outcome = "failed";
  }
  const endedAt = now().toISOString();
  try {
    await mkdir(join(deps.somaHome, "memory", "STATE", "errata", "triage-runs"), { recursive: true, mode: 0o700 });
    await writeFile(detailRef, `${JSON.stringify({ ...result, runId, startedAt, endedAt })}\n`, { mode: 0o600 });
  } catch { result.outcome = "failed"; }
  const report: RunFinishedInput = { kind: "job", ref: "errata-triage", runId, startedAt, endedAt, outcome: result.outcome, detailRef };
  await (deps.publishRun ?? ((input) => publishRunFinished(input, {
    somaHome: deps.somaHome, substrate: "custom", env: deps.env, publish: deps.publishRunFinished,
  })))(report);
  return result;
}
