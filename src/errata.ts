import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, normalize, relative, isAbsolute } from "node:path";
import { listAlgorithmRuns } from "./algorithm-store";
import { redactSomaFeedbackText } from "./feedback";
import type {
  AlgorithmRun, ErrataCluster, ErrataClusterKey, ErrataEvent, ErrataInput, ErrataPassedBy, ErrataRecord, SomaMemoryEvent,
} from "./types";
import { parseTelemetryEventLine, somaMemoryEventsPath, streamEventLines } from "./events/index";
import { hashJudgmentInput, readJudgments, recordJudgment, type JudgmentRecord } from "./core/index";
import {
  classifyErrataThemeWithClaude, classifyErrataWithClaude, validateErrataTheme, validateErrataVerdict,
  type ErrataThemeInput, type ErrataThemeVerdict, type ErrataTriageVerdict,
} from "./errata-classifier";
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

function parsePassedBy(raw: unknown): ErrataPassedBy {
  const pass = object(raw);
  if (pass.kind === "algorithm-verify") return { kind: pass.kind, runId: stringField(pass, "runId"), criterionId: stringField(pass, "criterionId") };
  if (pass.kind === "close-receipt") return { kind: pass.kind, repo: stringField(pass, "repo"), nodeId: stringField(pass, "nodeId"), receiptCommentId: stringField(pass, "receiptCommentId") };
  throw new Error("Invalid Errata passedBy.");
}

function parseClusterKey(raw: unknown): ErrataClusterKey {
  const key = object(raw);
  if (key.kind === "check") return { kind: key.kind, passedBy: parsePassedBy(key.passedBy) };
  if (key.kind === "artifact") return { kind: key.kind, path: stringField(key, "path") };
  if (key.kind === "theme") return { kind: key.kind, label: stringField(key, "label") };
  throw new Error("Invalid Errata cluster key.");
}

function clusterIdField(data: Record<string, unknown>): string {
  const id = stringField(data, "clusterId");
  if (!/^EC[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id.slice(2)))) throw new Error("Invalid Errata cluster id.");
  return id;
}

function parseInput(raw: unknown): ErrataInput {
  const data = object(raw);
  const passedBy = data.passedBy === null ? null : parsePassedBy(data.passedBy);
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
  if (data.kind === "clustered") {
    return { kind: data.kind, id: idField(data), clusterId: clusterIdField(data), key: parseClusterKey(data.key), at: timestampField(data, "at") };
  }
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

interface FoldedCluster { id: string; key: ErrataClusterKey; memberIds: string[]; createdAt: string }
interface FoldedLedger { records: ErrataRecord[]; clusters: FoldedCluster[] }

function foldLedger(events: readonly ErrataEvent[]): FoldedLedger {
  const records = new Map<string, ErrataRecord>();
  const clusters = new Map<string, FoldedCluster>();
  for (const event of events) {
    if (event.kind === "created") {
      if (records.has(event.record.id)) throw new Error(`Duplicate Errata id: ${event.record.id}`);
      records.set(event.record.id, event.record);
      continue;
    }
    const record = records.get(event.id);
    if (!record) throw new Error(`Unknown Errata id in ledger: ${event.id}`);
    if (event.kind === "dropped") { records.set(event.id, { ...record, status: "dropped" }); continue; }
    if (record.clusterId !== undefined) throw new Error(`Errata already clustered: ${event.id}`);
    records.set(event.id, { ...record, clusterId: event.clusterId });
    const cluster = clusters.get(event.clusterId) ?? { id: event.clusterId, key: event.key, memberIds: [], createdAt: event.at };
    cluster.memberIds.push(event.id);
    clusters.set(event.clusterId, cluster);
  }
  return { records: [...records.values()], clusters: [...clusters.values()] };
}

function foldEvents(events: readonly ErrataEvent[]): ErrataRecord[] {
  return foldLedger(events).records;
}

/** Zurich calendar day as a day count, so "within 30 days" is counted in the principal's dates. */
function zurichDay(iso: string): number {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(iso));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return Math.round(Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000);
}

export const ERRATA_CLUSTER_WINDOW_DAYS = 30;

/** soma#785 Q16: ripe on one rejected pass, or on two or more Errata within 30 days. Dropped members never count. */
function isRipe(members: readonly ErrataRecord[]): boolean {
  if (members.some((record) => record.passedBy !== null)) return true;
  const days = members.map((record) => zurichDay(record.complaintAt)).sort((a, b) => a - b);
  return days.some((day, index) => index > 0 && day - days[index - 1] <= ERRATA_CLUSTER_WINDOW_DAYS);
}

/** Clusters with at least one active member; a cluster whose members were all dropped is not reported. */
function activeClusters(ledger: FoldedLedger): ErrataCluster[] {
  const records = new Map(ledger.records.map((record) => [record.id, record]));
  return ledger.clusters.flatMap((cluster) => {
    const members = cluster.memberIds.map((id) => records.get(id)).filter((record): record is ErrataRecord => record?.status === "active");
    if (members.length === 0) return [];
    return [{ id: cluster.id, key: cluster.key, errataIds: members.map((record) => record.id), status: isRipe(members) ? "ripe" : "open", createdAt: cluster.createdAt }];
  });
}

export async function readErrataClusters(somaHome: string): Promise<ErrataCluster[]> {
  return withLedgerLock(somaHome, async () => activeClusters(foldLedger(await readEvents(somaHome))));
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

export interface ErrataClusterDeps {
  somaHome: string;
  now?: () => Date;
  /** Ledger seam: read every event, append one. Defaults to the private file ledger under its lock. */
  readLedger?: () => Promise<readonly ErrataEvent[]>;
  appendEvent?: (event: ErrataEvent) => Promise<void>;
  classifyTheme?: (input: ErrataThemeInput) => Promise<ErrataThemeVerdict>;
  recordJudgment?: (record: JudgmentRecord) => Promise<boolean>;
}

export interface ErrataClusterResult {
  /** Errata assigned by this call. */
  clustered: number;
  clusters: ErrataCluster[];
}

function passedByKey(passedBy: ErrataPassedBy): string {
  return passedBy.kind === "algorithm-verify"
    ? `${passedBy.kind}:${passedBy.runId}:${passedBy.criterionId}`
    : `${passedBy.kind}:${passedBy.repo}:${passedBy.nodeId}:${passedBy.receiptCommentId}`;
}

const errataNumber = (id: string) => Number(id.slice(1));
const themeKey = (label: string) => label.trim().toLowerCase();

const clusterNumber = (id: string) => Number(id.slice(2));

interface ErrataAssignment { record: ErrataRecord; clusterId: string; key: ErrataClusterKey }

/**
 * One ledger snapshot with the deterministic keys applied (soma#785 Q15). Every pending
 * linked Errata joins its `passedBy` check cluster. Pending null-link Errata form connected
 * groups over shared artifact paths; a group any of whose paths a null-link member of an
 * existing cluster already holds joins the earliest such cluster, any other group of two or
 * more opens an `artifact` cluster, and a lone Errata nothing shares is left in `themed`.
 * A linked member's paths never key a cluster.
 */
function snapshotClusters(events: readonly ErrataEvent[], now: () => Date) {
  const ledger = foldLedger(events);
  const records = new Map(ledger.records.map((record) => [record.id, record]));
  let nextCluster = ledger.clusters.reduce((max, cluster) => Math.max(max, clusterNumber(cluster.id)), 0) + 1;
  const byCheck = new Map<string, string>();
  const byTheme = new Map<string, string>();
  // Null-link members' artifact paths, earliest cluster first.
  const byArtifact = new Map<string, string>();
  for (const cluster of ledger.clusters) {
    if (cluster.key.kind === "check") byCheck.set(passedByKey(cluster.key.passedBy), cluster.id);
    if (cluster.key.kind === "theme") byTheme.set(themeKey(cluster.key.label), cluster.id);
    for (const id of cluster.memberIds) {
      const member = records.get(id);
      if (member?.status !== "active" || member.passedBy !== null) continue;
      for (const path of member.artifacts) if (!byArtifact.has(path)) byArtifact.set(path, cluster.id);
    }
  }
  const assignments: ErrataAssignment[] = [];
  const newCluster = (key: ErrataClusterKey): string => {
    const id = `EC${nextCluster++}`;
    if (key.kind === "check") byCheck.set(passedByKey(key.passedBy), id);
    if (key.kind === "theme") byTheme.set(themeKey(key.label), id);
    ledger.clusters.push({ id, key, memberIds: [], createdAt: now().toISOString() });
    return id;
  };
  const assign = (record: ErrataRecord, clusterId: string): ErrataAssignment => {
    const cluster = ledger.clusters.find((cluster) => cluster.id === clusterId);
    if (!cluster) throw new Error(`Unknown Errata cluster: ${clusterId}`);
    const assignment = { record, clusterId, key: cluster.key };
    assignments.push(assignment);
    return assignment;
  };
  const pending = ledger.records.filter((record) => record.status === "active" && record.clusterId === undefined)
    .sort((a, b) => errataNumber(a.id) - errataNumber(b.id));
  const unlinked: ErrataRecord[] = [];
  for (const record of pending) {
    if (record.passedBy === null) { unlinked.push(record); continue; }
    const key = passedByKey(record.passedBy);
    assign(record, byCheck.get(key) ?? newCluster({ kind: "check", passedBy: record.passedBy }));
  }
  // Connected groups over shared paths, so E1=[a], E2=[b], E3=[a,b] land in one cluster.
  const parent = new Map(unlinked.map((record) => [record.id, record.id]));
  const find = (id: string): string => {
    const root = parent.get(id) ?? id;
    return root === id ? id : find(root);
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };
  const holders = new Map<string, string>();
  for (const record of unlinked) {
    for (const path of record.artifacts) {
      const holder = holders.get(path);
      if (holder === undefined) holders.set(path, record.id); else union(record.id, holder);
    }
  }
  const groups = new Map<string, ErrataRecord[]>();
  for (const record of unlinked) {
    const root = find(record.id);
    groups.set(root, [...groups.get(root) ?? [], record]);
  }
  const themed: ErrataRecord[] = [];
  for (const group of groups.values()) {
    const existing = group.flatMap((record) => record.artifacts.flatMap((path) => {
      const clusterId = byArtifact.get(path);
      return clusterId === undefined ? [] : [clusterId];
    })).sort((a, b) => clusterNumber(a) - clusterNumber(b)).at(0);
    if (existing !== undefined) { for (const record of group) assign(record, existing); continue; }
    const [first, ...rest] = group;
    if (rest.length === 0) { themed.push(first); continue; }
    // Keyed by the first path of the earliest member that another member shares.
    const path = first.artifacts.find((path) => rest.some((other) => other.artifacts.includes(path)));
    if (path === undefined) throw new Error(`Errata group ${first.id} has no shared artifact path`);
    const id = newCluster({ kind: "artifact", path });
    for (const record of group) assign(record, id);
  }
  return {
    assignments, themed,
    /** Theme labels in use, including those coined on this snapshot. */
    themeLabels: () => ledger.clusters.flatMap((cluster) => cluster.key.kind === "theme" ? [cluster.key.label] : []),
    assignTheme: (record: ErrataRecord, label: string) => assign(record, byTheme.get(themeKey(label)) ?? newCluster({ kind: "theme", label })),
  };
}

/**
 * Assign every active, unclustered Errata to a cluster (soma#785 Q15). Under the ledger
 * lock, the deterministic keys (check, then shared artifact path) are applied and written;
 * the Errata nothing shares are listed. The lock is released while every one of them is
 * judged for a theme, so readers never wait on a Claude call. Then, under the lock again,
 * the ledger is re-read: each verdict whose Errata is still unshared is recorded under
 * `errata-triage` and its `clustered` event appended; a verdict whose Errata was dropped or
 * keyed deterministically meanwhile is discarded. Ripeness is derived from the folded ledger,
 * never stored. Dropped Errata are never clustered.
 */
export async function clusterErrata(deps: ErrataClusterDeps): Promise<ErrataClusterResult> {
  const now = deps.now ?? (() => new Date());
  const read = deps.readLedger ?? (() => readEvents(deps.somaHome));
  const append = deps.appendEvent ?? ((event: ErrataEvent) => writeEvent(deps.somaHome, event));
  const writeJudgment = deps.recordJudgment ?? ((judgment: JudgmentRecord) => recordJudgment(deps.somaHome, judgment));
  const classify = deps.classifyTheme ?? classifyErrataThemeWithClaude;
  const commit = async (events: ErrataEvent[], assignment: ErrataAssignment) => {
    const event: ErrataEvent = { kind: "clustered", id: assignment.record.id, clusterId: assignment.clusterId, key: assignment.key, at: now().toISOString() };
    await append(event);
    events.push(event);
  };
  const first = await withLedgerLock(deps.somaHome, async () => {
    const events = [...await read()];
    const snapshot = snapshotClusters(events, now);
    for (const assignment of snapshot.assignments) await commit(events, assignment);
    return { events, written: snapshot.assignments.length, themed: snapshot.themed, themes: snapshot.themeLabels() };
  });
  if (first.themed.length === 0) return { clustered: first.written, clusters: activeClusters(foldLedger(first.events)) };

  // Every theme is judged before any theme write; a judge failure leaves the whole remainder for the next run.
  const themes = [...first.themes];
  const verdicts: { record: ErrataRecord; verdict: ErrataThemeVerdict; input: ErrataThemeInput; latencyMs: number }[] = [];
  for (const record of first.themed) {
    const input: ErrataThemeInput = { complaint: redactSomaFeedbackText(record.complaint), themes: [...themes] };
    const before = now().getTime();
    const verdict = await classify(input);
    validateErrataTheme(verdict, input);
    const label = verdict.theme.trim();
    if (!themes.some((theme) => themeKey(theme) === themeKey(label))) themes.push(label);
    verdicts.push({ record, verdict, input, latencyMs: Math.max(0, now().getTime() - before) });
  }

  return withLedgerLock(deps.somaHome, async () => {
    const events = [...await read()];
    const snapshot = snapshotClusters(events, now);
    let written = first.written;
    // Errata promoted meanwhile take a deterministic key now; a theme for them waits for the next run.
    for (const assignment of snapshot.assignments) { await commit(events, assignment); written++; }
    const unshared = new Set(snapshot.themed.map((record) => record.id));
    for (const { record, verdict, input, latencyMs } of verdicts) {
      if (!unshared.has(record.id)) continue;
      const assignment = snapshot.assignTheme(record, verdict.theme.trim());
      const recorded = await writeJudgment({
        v: 1, ts: now().toISOString(), caller: "errata-triage", backend: "claude-p", backendVersion: verdict.backendVersion,
        inputSha256: hashJudgmentInput(JSON.stringify(input)),
        decision: { verdict: "theme", theme: verdict.theme.trim(),
          reason: redactSomaFeedbackText(verdict.reason), errataId: record.id, clusterId: assignment.clusterId, status: "clustered" },
        latencyMs,
      });
      if (!recorded) throw new Error("Errata theme judgment could not be recorded.");
      await commit(events, assignment);
      written++;
    }
    return { clustered: written, clusters: activeClusters(foldLedger(events)) };
  });
}

export interface ErrataTriageDeps extends RunLedgerDeps {
  somaHome: string;
  now?: () => Date;
  readEvents?: () => Promise<readonly SomaMemoryEvent[]>;
  classify?: (redactedText: string) => Promise<ErrataTriageVerdict>;
  classifyTheme?: ErrataClusterDeps["classifyTheme"];
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
  /** Errata assigned a cluster by this run, and ripe clusters after it (soma#785 Q15/Q16). */
  clustered: number;
  ripe: number;
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
  const result: ErrataTriageResult = { outcome: "succeeded", promoted: 0, dropped: 0, skipped: 0, unlinkable: 0, clustered: 0, ripe: 0, detailRef };
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
      // Clustering runs after every promotion of this batch so a pair promoted together shares a key without a judge.
      const clustered = await clusterErrata({ somaHome: deps.somaHome, now, classifyTheme: deps.classifyTheme, recordJudgment: deps.recordJudgment });
      result.clustered = clustered.clustered;
      result.ripe = clustered.clusters.filter((cluster) => cluster.status === "ripe").length;
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
