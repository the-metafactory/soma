import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { activeItemLimitPublicParams, collectionSchema, type ItemState, type ItemCollection, type ActiveItemLimitOptions } from "./goal-kinds/active-item-limit";
import { publishRunFinished, type RunFinishedPublisher, type RunFinishedResult, type RunLedgerEnv } from "./run-ledger";

export { ITEM_STATES, type ItemState, type ItemCollection } from "./goal-kinds/active-item-limit";
export const COLLECTION_MAX_AGE_MS = 26 * 60 * 60 * 1000;

export interface CollectionItem {
  id: string;
  statusOptionIds: string[];
  sphereOptionIds: string[];
}
export type CollectionRead = {
  ok: true;
  items: CollectionItem[];
  indexAgeMs: number;
  /** Local display only; never passed to classification or publishing. */
  names: ReadonlyMap<string, string>;
} | { ok: false; indexAgeMs?: number };
export type CollectionReader = (source: unknown, now: Date) => Promise<CollectionRead>;
export type CollectionReaders = Readonly<Record<string, CollectionReader>>;

export interface ActiveItemCounts {
  active: number;
  max: number;
  unclassified: number;
  parked: number;
  delegated: number;
}

/** Exclusion wins; missing sphere is unclassified even when a status is done. */
export function classifyCollectionItem(item: CollectionItem, collection: ItemCollection): ItemState | undefined {
  if (item.sphereOptionIds.some((id) => collection.excluded_sphere_option_ids.includes(id))) return undefined;
  if (item.sphereOptionIds.length === 0) return "unclassified";
  const states = item.statusOptionIds.map((id) => Object.hasOwn(collection.status_option_states, id)
    ? collection.status_option_states[id] : "unclassified");
  if (states.includes("done")) return "done";
  const unique = new Set(states);
  return unique.size === 1 ? states[0] : "unclassified";
}

/** One item, one state, regardless of repeated field values. */
export function countActiveItems(items: readonly CollectionItem[], collection: ItemCollection, max: number) {
  const counts: ActiveItemCounts = { active: 0, max, unclassified: 0, parked: 0, delegated: 0 };
  const active: string[] = [];
  const unclassified: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error("Collection contains duplicate items");
    seen.add(item.id);
    const state = classifyCollectionItem(item, collection);
    if (state === undefined || state === "done") continue;
    counts[state]++;
    if (state === "active") active.push(item.id);
    if (state === "unclassified") unclassified.push(item.id);
  }
  return { counts, value: counts.active <= max && counts.unclassified === 0 ? "on-track" as const : "off-track" as const,
    overLimitIds: active.slice(max), unclassifiedIds: unclassified };
}

export function activeItemCountsSummary(c: ActiveItemCounts): string {
  return `active ${c.active}, max ${c.max}, unclassified ${c.unclassified}, parked ${c.parked}, delegated ${c.delegated}`;
}

const tanaId = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/);
const tanaSourceSchema = z.strictObject({
  index_path: z.string().min(1),
  tag_id: tanaId,
  status_field_id: tanaId,
  sphere_field_id: tanaId,
});
const tanaFieldSchema = z.object({ field_def_id: tanaId, value_node_id: z.string().min(1) });
const batchSchema = z.object({
  results: z.array(z.object({ id: z.string(), node: z.object({ id: z.string(), name: z.string() }), error: z.string().optional() })),
  missing: z.literal(0),
});

/** This subprocess has only a read verb, closed stdin, and captured diagnostics. */
async function readSupertagNames(indexPath: string, ids: string[]): Promise<Map<string, string>> {
  const binary = Bun.which("supertag", { PATH: process.env.PATH });
  if (!binary) throw new Error("Collection reader unavailable");
  const names = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const proc = Bun.spawn([binary, "batch", "get", ...batch, "--offline", "--db-path", indexPath,
      "--json", "--select", "id,name"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { proc.kill(); }, 10_000);
    try {
      const [stdout, , code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      if (code !== 0) throw new Error("Collection reader failed");
      const data = batchSchema.parse(JSON.parse(stdout));
      for (const result of data.results) {
        if (result.error || result.id !== result.node.id || !batch.includes(result.id) || names.has(result.id)) {
          throw new Error("Collection reader returned invalid items");
        }
        names.set(result.id, result.node.name);
      }
      if (!batch.every((id) => names.has(id))) throw new Error("Collection reader returned incomplete items");
    } finally { clearTimeout(timer); }
  }
  return names;
}

/**
 * Current supertag search is label-based and show collapses multi-value IDs.
 * Read membership and every option ID from its SQLite index, read-only; use
 * offline batch get by ID for display content. No labels participate in state.
 */
export const readTanaCollection: CollectionReader = async (source, now) => {
  try {
    const config = tanaSourceSchema.parse(source);
    const db = new Database(config.index_path, { readonly: true, create: false, strict: true });
    try {
      db.run("BEGIN");
      const sync = db.query<{ last_sync_timestamp: number }, []>(
        "SELECT last_sync_timestamp FROM sync_metadata WHERE id = 1",
      ).get();
      if (!sync || !Number.isSafeInteger(sync.last_sync_timestamp) || sync.last_sync_timestamp <= 0) return { ok: false };
      const indexAgeMs = now.getTime() - sync.last_sync_timestamp;
      if (!Number.isFinite(indexAgeMs) || indexAgeMs < 0) return { ok: false };
      if (indexAgeMs > COLLECTION_MAX_AGE_MS) return { ok: false, indexAgeMs };
      if (!db.query("SELECT n.id FROM nodes n JOIN supertag_metadata t ON t.tag_id = n.id WHERE n.id = ?").get(config.tag_id)) return { ok: false };
      const rows = db.query<{ id: string }, [string]>(
        `SELECT DISTINCT n.id FROM nodes n JOIN tag_applications t ON t.data_node_id = n.id
         WHERE t.tag_id = ? AND (n.node_type IS NULL OR n.node_type != 'trash') ORDER BY n.id`,
      ).all(config.tag_id);
      const fields = db.query<{ field_def_id: string; value_node_id: string }, [string, string, string]>(
        `SELECT field_def_id, value_node_id FROM field_values
         WHERE parent_id = ? AND field_def_id IN (?, ?) ORDER BY value_order`,
      );
      const items = rows.map(({ id }) => {
        tanaId.parse(id);
        const values = z.array(tanaFieldSchema).parse(fields.all(id, config.status_field_id, config.sphere_field_id));
        return { id, statusOptionIds: values.filter((v) => v.field_def_id === config.status_field_id).map((v) => v.value_node_id),
          sphereOptionIds: values.filter((v) => v.field_def_id === config.sphere_field_id).map((v) => v.value_node_id) };
      });
      // Including the tag proves supertag access even when the collection is empty.
      const names = await readSupertagNames(config.index_path, [config.tag_id, ...rows.map((row) => row.id)]);
      names.delete(config.tag_id);
      return { ok: true, items, indexAgeMs, names };
    } finally { db.close(); }
  } catch (error) {
    // Never surface SQLite, schema, process or JSON diagnostics containing resource data.
    if (error instanceof Error) return { ok: false };
    throw error;
  }
};

export const collectionReaders: CollectionReaders = { "tana-collection": readTanaCollection };

/** Shared by baseline and scheduled sensing; has no writes or publications. */
export async function measureActiveItems(resource: unknown, max: number, now: Date, readers: CollectionReaders = collectionReaders) {
  const collection = collectionSchema.parse(resource);
  const reader = Object.hasOwn(readers, collection.type) ? readers[collection.type] : undefined;
  if (!reader) throw new Error("Collection reader unavailable");
  const read = await reader(collection.source, now);
  if (!read.ok || !Number.isFinite(read.indexAgeMs) || read.indexAgeMs < 0 || read.indexAgeMs > COLLECTION_MAX_AGE_MS) {
    throw new Error("Collection read unavailable or stale");
  }
  return { ...countActiveItems(read.items, collection, max), names: read.names, indexAgeMs: read.indexAgeMs };
}

export interface ActiveItemSensorDeps {
  somaHome: string;
  env?: RunLedgerEnv;
  publish?: RunFinishedPublisher;
  now?: () => Date;
  runId?: () => string;
  stdout?: (line: string) => void;
  readers?: CollectionReaders;
}
export interface ActiveItemSensorResult {
  exitCode: 0 | 1 | 2;
  value?: "on-track" | "off-track" | "unknown";
  counts?: ActiveItemCounts;
  ledger?: RunFinishedResult;
  error?: string;
}

/** Private, atomic state replacement; a read failure leaves the last good snapshot untouched. */
async function writeActiveItemState(somaHome: string, goal: string, state: unknown): Promise<void> {
  const dir = join(somaHome, "profile", "goals");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${goal}.state.${randomUUID()}.json`);
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(state, null, 2) + "\n"); }
    finally { await file.close(); }
    await rename(temp, join(dir, `${goal}.state.json`));
  } finally { await rm(temp, { force: true }); }
}

export async function runActiveItemLimitSensor(options: ActiveItemLimitOptions, deps: ActiveItemSensorDeps): Promise<ActiveItemSensorResult> {
  const parsed = activeItemLimitPublicParams.safeParse(options);
  if (!parsed.success) return { exitCode: 2, error: "soma goal sense active-item-limit: invalid parameters; collection not read" };
  const p = parsed.data;
  const now = deps.now ?? (() => new Date());
  const instant = now();
  let measured: Awaited<ReturnType<typeof measureActiveItems>> | undefined;
  try {
    const params: unknown = JSON.parse(await readFile(join(deps.somaHome, "profile", "goals", `${p.goal}.active-item-limit.params.json`), "utf8"));
    const local = z.object({ collection: z.unknown() }).parse(params);
    measured = await measureActiveItems(local.collection, p.max, instant, deps.readers);
    await writeActiveItemState(deps.somaHome, p.goal, {
      measured_at: instant.toISOString(), value: measured.value, ...measured.counts,
      index_age_ms: measured.indexAgeMs,
      over_limit: measured.overLimitIds.map((id) => measured?.names.get(id) ?? "(unnamed)"),
      unclassified_items: measured.unclassifiedIds.map((id) => measured?.names.get(id) ?? "(unnamed)"),
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    measured = undefined;
  }
  const ledger = await publishRunFinished({
    kind: "job", ref: `goal-sense/${p.goal}`, runId: deps.runId?.() ?? randomUUID(),
    outcome: measured ? "succeeded" : "failed", startedAt: instant.toISOString(), endedAt: now().toISOString(),
    serves: { goal: p.goal }, ...(measured ? { state: { subject: p.goal, value: measured.value } } : {}),
  }, { somaHome: deps.somaHome, substrate: "custom", env: deps.env, publish: deps.publish });
  if (!measured) return { exitCode: 1, value: "unknown", ledger,
    error: "soma goal sense active-item-limit: unknown; collection unavailable or stale; no state published" };
  (deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`)))(`${p.goal}: ${measured.value} (${activeItemCountsSummary(measured.counts)})`);
  return { exitCode: 0, value: measured.value, counts: measured.counts, ledger };
}
