import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, normalize, relative, isAbsolute } from "node:path";
import { listAlgorithmRuns } from "./algorithm/algorithm-store";
import { redactSomaFeedbackText } from "./feedback";
import type {
  ErrataAnswerKind, ErrataCluster, ErrataClusterEvent, ErrataClusterKey, ErrataEvent, ErrataInput,
  ErrataPassedBy, ErrataRecord, SomaMemoryEvent,
} from "./types";
import type { AlgorithmRun } from "./algorithm/types";
import { parseTelemetryEventLine, somaMemoryEventsPath, streamEventLines } from "./events/index";
import { hashJudgmentInput, isEnoent, readJudgments, recordJudgment, type JudgmentRecord } from "./core/index";
import { loadSomaConfig } from "./home/index";
import {
  GITHUB_DOTCOM, parseProposal, parseRemoteUrl, proposalFrontMatterSchema, runCommand,
  type ProposalKind,
} from "./graph/index";
import {
  classifyErrataProposalWithClaude, classifyErrataThemeWithClaude, classifyErrataWithClaude,
  validateErrataProposal, validateErrataTheme, validateErrataVerdict,
  type ErrataProposalInput, type ErrataProposalVerdict, type ErrataThemeInput, type ErrataThemeVerdict, type ErrataTriageVerdict,
} from "./errata-classifier";
import { publishRunFinished, type RunFinishedInput, type RunFinishedResult, type RunLedgerDeps } from "./run-ledger";
import { localDate } from "./workdays";

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

function isAnswerKind(kind: unknown): kind is ErrataAnswerKind {
  return kind === "expired" || kind === "dismissed" || kind === "resolved";
}

function isAnswerEvent(event: ErrataEvent): event is Extract<ErrataClusterEvent, { kind: ErrataAnswerKind }> {
  return isAnswerKind(event.kind);
}

/** The ref's own alphabet, one path segment: what `soma graph file-proposal` can resolve. */
function proposalRefField(data: Record<string, unknown>): string {
  const ref = stringField(data, "ref");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(ref)) throw new Error("Invalid Errata proposal ref.");
  return ref;
}

/**
 * A cluster event after clustering: the `proposed` and `unroutable` mints triage appends
 * (node #852), and the answers the answer reader appends from Vigil's resolution record.
 * A record this function cannot read fails the ledger read rather than going unnoticed.
 */
function parseClusterEvent(data: Record<string, unknown>): ErrataClusterEvent | undefined {
  const kind = data.kind;
  if (kind !== "proposed" && kind !== "unroutable" && !isAnswerKind(kind)) return undefined;
  const clusterId = clusterIdField(data);
  const at = timestampField(data, "at");
  if (kind === "unroutable") {
    let repo: string | null = null;
    if (data.repo !== null) {
      const parsed = proposalFrontMatterSchema.shape.landing.safeParse(data.repo);
      if (!parsed.success) throw new Error("Invalid Errata unroutable repo.");
      repo = parsed.data;
    }
    return { kind, clusterId, repo, at };
  }
  const ref = proposalRefField(data);
  if (isAnswerKind(kind)) {
    const nodeRef = data.nodeRef;
    if (nodeRef !== undefined && typeof nodeRef !== "string") throw new Error("Invalid Errata answer nodeRef.");
    return { kind, clusterId, ref, ...(typeof nodeRef === "string" ? { nodeRef } : {}), at };
  }
  const generation = data.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid Errata proposal generation.");
  const landing = proposalFrontMatterSchema.shape.landing.parse(data.landing);
  const proposalKind = proposalFrontMatterSchema.shape.proposal_kind.safeParse(data.proposalKind);
  if (!proposalKind.success) {
    throw new Error("Invalid Errata proposal kind.");
  }
  return { kind: "proposed", clusterId, ref, generation, landing, proposalKind: proposalKind.data, at };
}

function parseEvent(raw: unknown): ErrataEvent {
  const data = object(raw);
  if (data.kind === "dropped") return { kind: data.kind, id: idField(data), at: timestampField(data, "at") };
  if (data.kind === "clustered") {
    return { kind: data.kind, id: idField(data), clusterId: clusterIdField(data), key: parseClusterKey(data.key), at: timestampField(data, "at") };
  }
  const cluster = parseClusterEvent(data);
  if (cluster !== undefined) return cluster;
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
    // A mint or an answer speaks about its cluster and turns no Errata record.
    if (event.kind === "proposed" || event.kind === "unroutable" || isAnswerEvent(event)) continue;
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
  return Date.parse(`${localDate("Europe/Zurich", new Date(iso))}T00:00:00Z`) / 86_400_000;
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

// ---------------------------------------------------------------------------
// Proposals: a ripe cluster becomes a file the principal can answer (node #852)
// ---------------------------------------------------------------------------

/** How long a cluster key's slug may run before it keeps its head and gains a hash. */
export const ERRATA_CLUSTER_SLUG_MAX = 80;
const ERRATA_CLUSTER_SLUG_HASH = 8;
/** Transcript reads per cluster: a ripe cluster is small, and the draft needs only its shape. */
const ERRATA_PROPOSAL_TURN_MAX = 8;
/** Characters of one turn the draft may read. The delivered bytes themselves stay in the transcript. */
const ERRATA_PROPOSAL_EXCERPT_MAX = 1_200;
const ERRATA_PROPOSAL_PROMPT_MAX = 400;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The one spelling of a cluster key: compact, in the check's words or Ivy's, never the
 * complaint's. It keys the slug and enters the draft prompt as `cluster`.
 */
function clusterKeySpelling(key: ErrataClusterKey): string {
  if (key.kind === "artifact") return `artifact-${key.path}`;
  if (key.kind === "theme") return `theme-${key.label}`;
  const passedBy = key.passedBy;
  return passedBy.kind === "algorithm-verify"
    ? `check-${passedBy.kind}-${passedBy.runId}-${passedBy.criterionId}`
    : `check-${passedBy.kind}-${passedBy.repo}-${passedBy.nodeId}-${passedBy.receiptCommentId}`;
}

function passedBySpelling(passedBy: ErrataPassedBy | null): string | null {
  if (passedBy === null) return null;
  return passedBy.kind === "algorithm-verify"
    ? `algorithm-verify ${passedBy.runId} ${passedBy.criterionId}`
    : `close-receipt ${passedBy.repo} ${passedBy.nodeId}`;
}

/**
 * `errata-<cluster-key>`: the checkpoint id, and the middle of the proposal ref. Both
 * `soma graph file-proposal` grammars allow only `[A-Za-z0-9._-]`, so accented letters are
 * folded to their base and anything else becomes one `-`, with runs of separators collapsed
 * and the ends trimmed. A spelling past the budget keeps its head plus a hash of the whole
 * spelling, so two long keys never mint the same ref, and the head never ends on a separator.
 * The fold is a legible key, not a digest: keys differing only in punctuation share a slug.
 */
export function errataClusterSlug(key: ErrataClusterKey): string {
  const spelling = clusterKeySpelling(key);
  const folded = spelling.normalize("NFKD").replace(/\p{Mn}/gu, "");
  const slug = folded.replace(/[^\w.-]+/gu, "-").replace(/[-.]{2,}/gu, "-").replace(/^[-.]+|[-.]+$/gu, "");
  const hash = sha256Hex(spelling).slice(0, ERRATA_CLUSTER_SLUG_HASH);
  if (slug.length <= ERRATA_CLUSTER_SLUG_MAX) return slug.length > 0 ? slug : hash;
  const head = slug.slice(0, ERRATA_CLUSTER_SLUG_MAX - ERRATA_CLUSTER_SLUG_HASH - 1).replace(/[-.]+$/gu, "");
  return head.length > 0 ? `${head}-${hash}` : hash;
}

/** The envelope's form of a ref: myelin wants a `soma:` path relative to soma-home (soma#903 D2). */
export function proposalEnvelopeRef(ref: string): string {
  return `soma:proposals/${ref}.md`;
}

/** What triage still owes a cluster, read off the ledger rather than from stored state. */
interface ClusterProposalHistory {
  /** Proposals the cluster has already minted: the next one is generation `generations + 1`. */
  generations: number;
  /** The last mint — a proposal or an unroutable report — with its place in the ledger. */
  mint?: { kind: "proposed"; at: string; index: number } | { kind: "unroutable"; at: string; index: number; repo: string | null };
  /** An answer that came after that mint. */
  answered?: { kind: ErrataAnswerKind; at: string };
  /** When the cluster's newest member joined it. */
  joinedAt?: string;
}

function foldClusterHistory(events: readonly ErrataEvent[], cluster: ErrataCluster): ClusterProposalHistory {
  const members = new Set(cluster.errataIds);
  const history: ClusterProposalHistory = { generations: 0 };
  events.forEach((event, index) => {
    if (event.kind === "created" || event.kind === "dropped") return;
    if (event.clusterId !== cluster.id) return;
    if (event.kind === "clustered") {
      if (members.has(event.id)) history.joinedAt = event.at;
      return;
    }
    if (event.kind === "proposed") {
      history.generations++;
      history.mint = { kind: event.kind, at: event.at, index };
      history.answered = undefined;
      return;
    }
    if (event.kind === "unroutable") {
      history.mint = { kind: event.kind, at: event.at, index, repo: event.repo };
      history.answered = undefined;
      return;
    }
    if (history.mint !== undefined && index > history.mint.index) history.answered = { kind: event.kind, at: event.at };
  });
  return history;
}

/**
 * What a ripe cluster is owed (soma#785 Q20, soma#903 D3). An unanswered proposal is still
 * open in Vigil, so nothing new is written for it even when more Errata join. A proposal an
 * answer closed stands until a newer Errata joins the cluster. An unroutable report also
 * stands until new evidence joins, unless its missing landing map has been registered.
 */
function proposalDecision(history: ClusterProposalHistory, registry: Readonly<Record<string, number>>): { action: "mint"; generation: number } | { action: "wait" } {
  const mint = history.mint;
  if (mint === undefined) return { action: "mint", generation: 1 };
  if (mint.kind === "proposed" && history.answered === undefined) return { action: "wait" };
  if (mint.kind === "unroutable" && mint.repo !== null && Object.hasOwn(registry, mint.repo)) {
    return { action: "mint", generation: history.generations + 1 };
  }
  const since = Date.parse(history.answered?.at ?? mint.at);
  if (history.joinedAt === undefined || Date.parse(history.joinedAt) <= since) return { action: "wait" };
  return { action: "mint", generation: history.generations + 1 };
}

/** Redacted transcript evidence for the turn one Errata rejected. */
export interface ErrataTurnEvidence {
  sessionId: string;
  /** The working directory of the rejected turn, when the transcript names one. */
  cwd?: string;
  excerpt: string;
}

export interface ErrataProposalDeps {
  somaHome: string;
  cluster: ErrataCluster;
  /** Active members, in id order. Defaults to the ledger's records assigned to this cluster. */
  members?: readonly ErrataRecord[];
  /** Registered landing maps; defaults to `errata.landing` in soma's config (soma#903 D11). */
  landing?: Readonly<Record<string, number>>;
  now?: () => Date;
  readLedger?: () => Promise<readonly ErrataEvent[]>;
  appendEvent?: (event: ErrataEvent) => Promise<void>;
  /** Reads the rejected turn of one Errata. Defaults to the session's transcript. */
  readTurn?: (sessionId: string, rejectedTurnUuid: string) => Promise<ErrataTurnEvidence | null>;
  /** The `owner/repo` a working directory's `origin` remote points at. */
  resolveRepo?: (cwd: string) => Promise<string | undefined>;
  classify?: (input: ErrataProposalInput) => Promise<ErrataProposalVerdict>;
}

/** What proposing one cluster decided, before anything is written. */
export type ErrataProposalPlan =
  | { status: "propose"; ref: string; envelopeRef: string; path: string; content: string; generation: number; proposalKind: ProposalKind; event: ErrataEvent }
  | { status: "unroutable"; repo: string | null; event: ErrataEvent }
  | { status: "waiting" };

export type ErrataProposalResult =
  | { status: "proposed"; ref: string; envelopeRef: string; path: string; generation: number; proposalKind: ProposalKind }
  | { status: "unroutable"; repo: string | null }
  | { status: "waiting" };

/** `errata.landing` as soma's config declares it, checked against the proposal front-matter grammar. */
export async function readErrataLandingRegistry(somaHome: string): Promise<Record<string, number>> {
  const registry = (await loadSomaConfig({ somaHome })).errata?.landing ?? {};
  for (const [repo, mapRoot] of Object.entries(registry)) {
    const row = proposalFrontMatterSchema.pick({ landing: true, map_root: true }).safeParse({ landing: repo, map_root: mapRoot });
    // A registry row is configuration: name the row, never its contents.
    if (!row.success) throw new Error(`Invalid errata.landing entry: ${repo}`);
  }
  return registry;
}

/** A turn's own words and tool calls, collapsed to one line and redacted like feedback. */
function turnExcerpt(entry: Record<string, unknown>, budget: number): string {
  const content = object(entry.message).content;
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const raw of content) {
      const block = object(raw);
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "tool_use") {
        const input = object(block.input);
        const path = input.file_path ?? input.notebook_path ?? input.path;
        parts.push(typeof path === "string" ? `${String(block.name)} ${path}` : String(block.name));
      }
    }
  }
  return redactSomaFeedbackText(parts.join(" ")).replace(/\s+/gu, " ").trim().slice(0, budget);
}

/** The transcript a session's candidates named: capture keeps the path, the Errata keeps only the session. */
async function findTranscriptPath(somaHome: string, sessionId: string): Promise<string | undefined> {
  let found: { path: string; at: number } | undefined;
  for await (const line of streamEventLines(somaMemoryEventsPath(somaHome))) {
    const event = parseTelemetryEventLine(line);
    if (event?.kind !== "feedback.candidate") continue;
    const metadata = event.metadata ?? {};
    if (metadata.sessionId !== sessionId || typeof metadata.transcriptPath !== "string" || !metadata.transcriptPath.trim()) continue;
    const at = Date.parse(event.timestamp);
    if (found === undefined || at > found.at) found = { path: metadata.transcriptPath, at };
  }
  return found?.path;
}

function transcriptEntries(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [object(JSON.parse(line))]; }
    catch (error) {
      // A transcript is a live file: a torn line is skipped, any other failure is real.
      if (error instanceof SyntaxError) return [];
      throw error;
    }
  });
}

function defaultReadTurn(somaHome: string): (sessionId: string, rejectedTurnUuid: string) => Promise<ErrataTurnEvidence | null> {
  const paths = new Map<string, string | null>();
  return async (sessionId, rejectedTurnUuid) => {
    if (!paths.has(sessionId)) paths.set(sessionId, (await findTranscriptPath(somaHome, sessionId)) ?? null);
    const path = paths.get(sessionId);
    if (path === null || path === undefined) return null;
    let text: string;
    try { text = await readFile(path, "utf8"); }
    catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
    const entries = transcriptEntries(text).filter((entry) => entry.sessionId === undefined || entry.sessionId === sessionId);
    const index = entries.findIndex((entry) => entry.uuid === rejectedTurnUuid);
    if (index < 0) return null;
    const promptIndex = lastIndex(entries.slice(0, index), isPrompt);
    const excerpt = [
      ...(promptIndex >= 0 ? [`Principal asked: ${turnExcerpt(entries[promptIndex], ERRATA_PROPOSAL_PROMPT_MAX)}`] : []),
      `Delivered: ${turnExcerpt(entries[index], ERRATA_PROPOSAL_EXCERPT_MAX)}`,
    ].join("\n");
    const cwd = entries[index].cwd;
    return { sessionId, ...(typeof cwd === "string" && cwd.trim() ? { cwd } : {}), excerpt };
  };
}

/** Which repo a working directory belongs to. Only github.com answers in the `owner/repo` form the schema allows. */
async function defaultResolveRepo(cwd: string): Promise<string | undefined> {
  const outcome = await runCommand({ argv: ["git", "remote", "get-url", "origin"], timeoutSec: 30, cwd });
  if (outcome.exitCode !== 0) return undefined;
  const location = parseRemoteUrl(outcome.stdout.trim());
  return location === undefined ? undefined : location.host === GITHUB_DOTCOM ? location.path : undefined;
}

function proposalBody(verdict: ErrataProposalVerdict, cites: readonly string[]): string {
  const evidence = `Cites: ${cites.join(", ")}.`;
  return verdict.proposal_kind === "deterministic-check"
    ? [
      "## Deliverable", "", verdict.deliverable ?? "", "",
      "## Acceptance criteria", "", ...(verdict.criteria ?? []).map((criterion) => `- ${criterion}`), "",
      "## The miss", "", verdict.defect, "",
      "## The check that should have caught it", "", verdict.check ?? "", "",
      evidence,
    ].join("\n")
    : ["## Question", "", verdict.question ?? "", "", "## The miss", "", verdict.defect, "", evidence].join("\n");
}

/**
 * Read one ripe cluster and decide what it is owed, writing nothing (soma#785 Q22). The
 * landing repo comes from evidence before any model runs: a close receipt names its repo,
 * otherwise the rejected turn's working directory does. A repo `errata.landing` does not
 * register is reported rather than proposed, and costs no inference. The draft is validated
 * twice: as a verdict, and again as the file `soma graph file-proposal` will read.
 */
export async function planClusterProposal(deps: ErrataProposalDeps): Promise<ErrataProposalPlan> {
  const now = deps.now ?? (() => new Date());
  const events = [...(await (deps.readLedger ?? (() => readEvents(deps.somaHome)))())];
  const registry = deps.landing ?? await readErrataLandingRegistry(deps.somaHome);
  const decision = proposalDecision(foldClusterHistory(events, deps.cluster), registry);
  if (decision.action === "wait") return { status: "waiting" };

  const members = (deps.members ?? foldLedger(events).records
    .filter((record) => record.clusterId === deps.cluster.id && record.status === "active"))
    .slice().sort((a, b) => errataNumber(a.id) - errataNumber(b.id));
  if (members.length === 0) throw new Error(`Errata cluster ${deps.cluster.id} has no active member.`);

  const readTurn = deps.readTurn ?? defaultReadTurn(deps.somaHome);
  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;
  const turns = new Map<string, ErrataTurnEvidence | null>();
  const workingDirs = new Set<string>();
  let landing = members.flatMap((record) => record.passedBy?.kind === "close-receipt" ? [record.passedBy.repo] : []).at(0);
  for (const record of members.slice(0, ERRATA_PROPOSAL_TURN_MAX)) {
    if (turns.has(record.id)) continue;
    const turn = await readTurn(record.sessionId, record.rejectedTurnUuid);
    turns.set(record.id, turn);
    if (turn?.cwd === undefined) continue;
    workingDirs.add(turn.cwd);
    landing ??= await resolveRepo(turn.cwd);
  }

  const at = now().toISOString();
  const mapRoot = landing === undefined ? undefined : registry[landing];
  if (landing === undefined || mapRoot === undefined) {
    return { status: "unroutable", repo: landing ?? null, event: { kind: "unroutable", clusterId: deps.cluster.id, repo: landing ?? null, at } };
  }

  const input: ErrataProposalInput = {
    cluster: clusterKeySpelling(deps.cluster.key),
    landing,
    members: members.map((record) => ({
      id: record.id,
      complaint: redactSomaFeedbackText(record.complaint),
      artifacts: record.artifacts,
      passedBy: passedBySpelling(record.passedBy),
    })),
    sessions: members.flatMap((record) => {
      const turn = turns.get(record.id);
      return turn ? [{ errataId: record.id, sessionId: record.sessionId, excerpt: turn.excerpt }] : [];
    }),
    // Reject known private roots as well as the local path forms the validator checks.
    privateStrings: [deps.somaHome, ...workingDirs],
  };
  const verdict = await (deps.classify ?? classifyErrataProposalWithClaude)(input);
  // The draft is untrusted content even through an injected classifier.
  validateErrataProposal(verdict, input);

  const slug = errataClusterSlug(deps.cluster.key);
  const ref = `errata-${slug}-g${decision.generation}`;
  const cites = members.map((record) => record.id);
  const frontMatter = proposalFrontMatterSchema.safeParse({
    proposal_kind: verdict.proposal_kind,
    landing,
    map_root: mapRoot,
    title: verdict.title,
    checkpoint: `errata-${slug}`,
    cites,
  });
  if (!frontMatter.success) {
    const fields = frontMatter.error.issues.map((issue) => issue.path.join(".") || "front-matter").join(", ");
    throw new Error(`Errata proposal ${ref} fails the proposal schema: ${fields}`);
  }
  const content = `---\n${Bun.YAML.stringify(frontMatter.data).trimEnd()}\n---\n\n${proposalBody(verdict, cites)}\n`;
  // The parser `soma graph file-proposal` runs on approve: a file it would refuse is never written.
  parseProposal(ref, content);
  return {
    status: "propose", ref, envelopeRef: proposalEnvelopeRef(ref), generation: decision.generation, proposalKind: verdict.proposal_kind,
    path: join(deps.somaHome, "proposals", `${ref}.md`), content,
    event: { kind: "proposed", clusterId: deps.cluster.id, ref, generation: decision.generation, landing, proposalKind: verdict.proposal_kind, at },
  };
}

/** The file first, then the event: a write that dies midway leaves the cluster unproposed, so the next run retries. */
export async function commitClusterProposal(
  plan: Exclude<ErrataProposalPlan, { status: "waiting" }>,
  deps: Pick<ErrataProposalDeps, "somaHome" | "appendEvent">,
): Promise<void> {
  const append = deps.appendEvent ?? ((event: ErrataEvent) => writeEvent(deps.somaHome, event));
  if (plan.status === "propose") {
    await mkdir(dirname(plan.path), { recursive: true, mode: 0o700 });
    const temporary = `${plan.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, plan.content, { flag: "wx", mode: 0o600 });
      await rename(temporary, plan.path);
    } finally { await rm(temporary, { force: true }); }
  }
  await append(plan.event);
}

/**
 * Propose one ripe cluster: draft it, write the file under `<soma-home>/proposals/`, and
 * append the mint to the ledger. Triage calls the plan and commit halves apart, so every
 * draft of a batch is judged before any of them is written, as themes are.
 */
export async function proposeFromCluster(deps: ErrataProposalDeps): Promise<ErrataProposalResult> {
  const plan = await planClusterProposal(deps);
  if (plan.status === "waiting") return plan;
  await commitClusterProposal(plan, deps);
  return plan.status === "unroutable"
    ? { status: "unroutable", repo: plan.repo }
    : { status: "proposed", ref: plan.ref, envelopeRef: plan.envelopeRef, path: plan.path, generation: plan.generation, proposalKind: plan.proposalKind };
}

/**
 * The waiting result for clusters whose landing repo is not registered (soma#903 D11, #842):
 * one private file naming each of them, carried as the run's `result_ref`.
 */
export function unroutableReportText(date: string, rows: { cluster: string; repo: string | null }[]): string {
  return [
    `# Errata proposals without a landing map — ${date}`,
    "",
    "These ripe Errata clusters have no landing map registered under `errata.landing` in",
    "`<soma-home>/config.yaml`, so nothing was proposed for them and the check that should",
    "have caught the rejection stays unbuilt. Register the repo and its map root, or settle",
    "the check another way.",
    "",
    ...rows.map((row) => `- \`${row.cluster}\` — ${row.repo === null ? "the cluster's sessions name no repo." : `repo \`${row.repo}\` is not registered.`}`),
    "",
  ].join("\n");
}

export interface ErrataProposalRun {
  /** Envelope refs of the proposals this run minted, in cluster order. */
  refs: string[];
  proposed: number;
  unroutable: number;
  resultRef?: string;
}

/** Three Claude subprocesses at most, including transcript and ledger reads for their plans. */
const ERRATA_PROPOSAL_CONCURRENCY = 3;

async function planClusterProposals(deps: Omit<ErrataProposalDeps, "cluster">, clusters: readonly ErrataCluster[]): Promise<ErrataProposalPlan[]> {
  const plans = new Array<ErrataProposalPlan>(clusters.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(ERRATA_PROPOSAL_CONCURRENCY, clusters.length) }, async () => {
    while (failure === undefined && next < clusters.length) {
      const index = next++;
      try { plans[index] = await planClusterProposal({ ...deps, cluster: clusters[index] }); }
      catch (error) { failure ??= { error }; }
    }
  }));
  // Settle every in-flight plan before releasing the triage lock on a refused draft.
  if (failure !== undefined) throw failure.error;
  return plans;
}

function proposalDeliveryDirectory(somaHome: string): string {
  return join(somaHome, "memory", "STATE", "errata", "proposal-deliveries");
}

/** A committed mint is pending until delivery is acknowledged, independently of drafting. */
async function pendingProposalRefs(somaHome: string): Promise<string[]> {
  const events = await readEvents(somaHome);
  let delivered: string[];
  try { delivered = await readdir(proposalDeliveryDirectory(somaHome)); }
  catch (error) {
    if (!isEnoent(error)) throw error;
    delivered = [];
  }
  const acknowledged = new Set(delivered.filter((name) => name.endsWith(".delivered")).map((name) => name.slice(0, -".delivered".length)));
  for (const event of events) {
    if (isAnswerEvent(event)) acknowledged.add(event.ref);
  }
  return events.flatMap((event) => event.kind === "proposed" && !acknowledged.has(event.ref) ? [event.ref] : []);
}

async function acknowledgeProposalDelivery(somaHome: string, refs: readonly string[]): Promise<void> {
  if (refs.length === 0) return;
  const directory = proposalDeliveryDirectory(somaHome);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const ref of refs) {
    await writeFile(join(directory, `${ref}.delivered`), "", { mode: 0o600 });
  }
}

/**
 * Propose every ripe cluster of a triage run. Every cluster is planned before any file is
 * written, so one refused draft leaves the whole batch for the next run instead of half of
 * it on disk. A run that reported an unroutable cluster writes that day's summary naming
 * every cluster still waiting for a landing map, and carries it as its `result_ref`.
 */
async function proposeRipeClusters(
  deps: Omit<ErrataProposalDeps, "cluster">,
  clusters: readonly ErrataCluster[],
  now: () => Date,
): Promise<ErrataProposalRun> {
  const run: ErrataProposalRun = { refs: [], proposed: 0, unroutable: 0 };
  if (clusters.length === 0) return run;
  const plans = await planClusterProposals(deps, clusters);
  let reported = 0;
  for (const plan of plans) {
    if (plan.status === "waiting") continue;
    await commitClusterProposal(plan, deps);
    if (plan.status === "unroutable") {
      run.unroutable++;
      reported++;
      continue;
    }
    run.proposed++;
    run.refs.push(plan.envelopeRef);
  }
  if (reported === 0) return run;
  // One file for the day naming every cluster still unrouted, so it is reported only once.
  const events = [...await (deps.readLedger ?? (() => readEvents(deps.somaHome)))()];
  const day = localDate("Europe/Zurich", now());
  const rows = clusters.flatMap((cluster) => {
    const mint = foldClusterHistory(events, cluster).mint;
    return mint?.kind === "unroutable" ? [{ cluster: `errata-${errataClusterSlug(cluster.key)}`, repo: mint.repo }] : [];
  });
  const filename = `errata-unroutable-${day}.md`;
  const path = join(deps.somaHome, "outputs", filename);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, unroutableReportText(day, rows), { mode: 0o600 });
  run.resultRef = `soma:outputs/${filename}`;
  return run;
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
  /** An injected publisher returning void acknowledges delivery; otherwise the funnel's status applies. */
  publishRun?: (input: RunFinishedInput) => Promise<RunFinishedResult> | Promise<void>;
  /** Registered landing maps for the proposals of this run; defaults to soma's config. */
  landing?: Readonly<Record<string, number>>;
  /** Transcript reader, repo resolver and draft judge for a ripe cluster; see `ErrataProposalDeps`.
   * They are the proposal seams, so a triage run can be driven without Claude or git. */
  readTurn?: (sessionId: string, rejectedTurnUuid: string) => Promise<ErrataTurnEvidence | null>;
  resolveRepo?: (cwd: string) => Promise<string | undefined>;
  classifyProposal?: (input: ErrataProposalInput) => Promise<ErrataProposalVerdict>;
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
  /** Proposal files this run minted, and ripe clusters it reported without a landing map (node #852). */
  proposed: number;
  unroutable: number;
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
  const result: ErrataTriageResult = { outcome: "succeeded", promoted: 0, dropped: 0, skipped: 0, unlinkable: 0, clustered: 0, ripe: 0, proposed: 0, unroutable: 0, detailRef };
  let resultRef: string | undefined;
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
      const ripe = clustered.clusters.filter((cluster) => cluster.status === "ripe");
      result.ripe = ripe.length;
      if (ripe.length === 0) return;
      // Proposals follow clustering, so a cluster this batch made ripe is drafted in the same run.
      const proposals = await proposeRipeClusters({
        somaHome: deps.somaHome, now, landing: deps.landing ?? await readErrataLandingRegistry(deps.somaHome),
        readTurn: deps.readTurn, resolveRepo: deps.resolveRepo, classify: deps.classifyProposal,
      }, ripe, now);
      result.proposed = proposals.proposed;
      result.unroutable = proposals.unroutable;
      resultRef = proposals.resultRef;
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
  // Serialize pending-ref snapshots and acknowledgments across overlapping jobs. A failed
  // batch/report keeps every committed mint pending for a later successful run.
  return withLedgerLock(deps.somaHome, async () => {
    const pendingRefs = result.outcome === "succeeded" ? await pendingProposalRefs(deps.somaHome) : [];
    const report: RunFinishedInput = {
      kind: "job", ref: "errata-triage", runId, startedAt, endedAt, outcome: result.outcome, detailRef,
      // myelin takes both fields only on a run that succeeded, so a failed run carries neither.
      ...(result.outcome === "succeeded" && resultRef !== undefined ? { resultRef } : {}),
      ...(pendingRefs.length > 0 ? { proposalRefs: pendingRefs.map(proposalEnvelopeRef) } : {}),
    };
    const delivery = await (deps.publishRun ?? ((input) => publishRunFinished(input, {
      somaHome: deps.somaHome, substrate: "custom", env: deps.env, publish: deps.publishRunFinished,
    })))(report);
    if (delivery === undefined || delivery === "published" || delivery === "spooled") {
      await acknowledgeProposalDelivery(deps.somaHome, pendingRefs);
    }
    return result;
  }, ".proposal-delivery-lock");
}
