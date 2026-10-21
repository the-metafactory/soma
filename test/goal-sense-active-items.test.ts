import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { validateExecutionRunFinished, type ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { classifyCollectionItem, countActiveItems, measureActiveItems, readTanaCollection, runActiveItemLimitSensor, COLLECTION_MAX_AGE_MS, type CollectionItem } from "../src/flows/goal-sense-active-items";
import { type ItemCollection } from "../src/flows/goal-kinds/active-item-limit";
import { activeItemLimitKind, activeItemLimitParams } from "../src/flows/goal-kinds/active-item-limit";
import { listGoalKinds } from "../src/flows/goal-kinds/registry";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { proposeGoal } from "../src/flows/goal-propose";
import { buildRunFinishedEnvelope } from "../src/flows/run-ledger";
import { acceptGoalProposal } from "../src/flows/goal-accept";
import type { InferenceBackend } from "../src/tools/inference";
import tupleSample from "./fixtures/tana-collection/tuple-sample.json";

const now = new Date("2026-10-19T05:00:00Z");
const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const collection: ItemCollection = {
  type: "tana-collection",
  status_option_states: { a: "active", a2: "active", p: "parked", d: "delegated", x: "done", u: "unclassified" },
  excluded_sphere_option_ids: ["employer"], source: {},
};
const item = (id: string, statuses: string[] = ["a"], spheres: string[] = ["own"]): CollectionItem =>
  ({ id, statusOptionIds: statuses, sphereOptionIds: spheres });
const FIXTURE_ITEMS = [item("a"), item("b"), item("c"), item("d"), item("e", []),
  item("f", ["a", "x"]), item("g", ["a"], ["employer"]), item("h", ["p"]), item("j", ["d"])];

test.each([
  { statuses: ["a"], spheres: ["own"], state: "active" },
  { statuses: ["a", "a2", "a"], spheres: ["own"], state: "active" },
  { statuses: ["p"], spheres: ["own"], state: "parked" },
  { statuses: ["d"], spheres: ["own"], state: "delegated" },
  { statuses: ["a", "unknown", "x"], spheres: ["own"], state: "done" },
  { statuses: ["x", "a"], spheres: ["own"], state: "done" },
  { statuses: [], spheres: ["own"], state: "unclassified" },
  { statuses: ["a", "unknown"], spheres: ["own"], state: "unclassified" },
  { statuses: ["a", "p"], spheres: ["own"], state: "unclassified" },
  { statuses: ["__proto__"], spheres: ["own"], state: "unclassified" },
  { statuses: ["x"], spheres: [], state: "unclassified" },
  { statuses: [], spheres: ["employer", "own"], state: undefined },
])("classifies $statuses in $spheres as $state", ({ statuses, spheres, state }) => {
  expect(classifyCollectionItem(item("i", [...statuses], [...spheres]), collection)).toBe(state);
});

test.each([
  { active: 3, unknown: 0, max: 3, state: "on-track" },
  { active: 4, unknown: 0, max: 3, state: "off-track" },
  { active: 3, unknown: 1, max: 3, state: "off-track" },
  { active: 0, unknown: 0, max: 0, state: "on-track" },
])("$active active and $unknown unclassified with max $max is $state", ({ active, unknown, max, state }) => {
  const items = [...Array.from({ length: active }, (_, i) => item(`a${i}`)),
    ...Array.from({ length: unknown }, (_, i) => item(`u${i}`, []))];
  expect(countActiveItems(items, collection, max)).toMatchObject({ value: state,
    counts: { active, max, unclassified: unknown, parked: 0, delegated: 0 } });
});

test("excluded and done items do not count; duplicate item records are a read failure", () => {
  expect(countActiveItems([item("a"), item("b", ["p"]), item("c", ["d"]), item("d", ["x"]), item("e", [], ["employer"])], collection, 1).counts)
    .toEqual({ active: 1, max: 1, unclassified: 0, parked: 1, delegated: 1 });
  expect(() => countActiveItems([item("a"), item("a")], collection, 1)).toThrow("duplicate");
});

function addFieldValues(db: Database, parentId: string, fieldId: string, values: string[], fieldDefId: string) {
  const tupleId = `${parentId}-${fieldId}-tuple`;
  db.query("INSERT INTO nodes (id, node_type, raw_data) VALUES (?, 'tuple', ?)")
    .run(tupleId, JSON.stringify({ children: [fieldId, ...values] }));
  values.forEach((id, order) => db.query("INSERT INTO field_values VALUES (?, ?, ?, ?, ?)")
    .run(parentId, fieldDefId, tupleId, id, order));
}

async function fixture(options: { age?: number; empty?: boolean; script?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "soma-active-items-"));
  roots.push(root);
  const bin = join(root, "bin");
  const somaHome = join(root, ".soma");
  const goals = join(somaHome, "profile", "goals");
  await mkdir(bin);
  await mkdir(goals, { recursive: true });
  const index = join(root, "private-index.sqlite");
  const db = new Database(index);
  db.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, node_type TEXT, raw_data TEXT);
    CREATE TABLE tag_applications (data_node_id TEXT, tag_id TEXT, tag_name TEXT);
    CREATE TABLE supertag_metadata (tag_id TEXT PRIMARY KEY);
    INSERT INTO supertag_metadata VALUES ('private-tag');
    CREATE TABLE field_values (parent_id TEXT, field_def_id TEXT, tuple_id TEXT, value_node_id TEXT, value_order INTEGER);
    CREATE TABLE sync_metadata (id INTEGER PRIMARY KEY, last_sync_timestamp INTEGER);`);
  db.query("INSERT INTO sync_metadata VALUES (1, ?)").run(now.getTime() - (options.age ?? 0));
  db.query("INSERT INTO nodes (id, name) VALUES (?, ?)").run("private-tag", "Private collection");
  const fixtureItems = options.empty ? [] : FIXTURE_ITEMS;
  for (const [index, i] of fixtureItems.entries()) {
    db.query("INSERT INTO nodes (id, name) VALUES (?, ?)").run(i.id, `Private item ${i.id}`);
    db.query("INSERT INTO tag_applications VALUES (?, ?, ?)").run(i.id, "private-tag", "label-is-irrelevant");
    for (const [field, values] of [["private-status", i.statusOptionIds], ["private-sphere", i.sphereOptionIds]] as const) {
      // The index stores tag tuples, source tuples or nothing here, never the attribute definition.
      const fieldDefId = index % 3 === 0 ? `${field}-tag-tuple` : index % 3 === 1 ? `${field}-source-tuple` : "";
      addFieldValues(db, i.id, field, values, fieldDefId);
    }
  }
  // Same label, different tag ID: must never enter the collection.
  db.run("INSERT INTO nodes (id, name) VALUES ('other', 'Private unrelated'); INSERT INTO tag_applications VALUES ('other', 'other-tag', 'label-is-irrelevant');");
  db.close();
  const resource = { ...collection, source: { index_path: index, tag_id: "private-tag", status_field_id: "private-status", sphere_field_id: "private-sphere" } };
  const log = join(root, "calls.jsonl");
  const binary = join(bin, "supertag");
  await writeFile(binary, `#!${process.execPath}\n` + (options.script ?? `
    const args = process.argv.slice(2);
    await Bun.write(${JSON.stringify(log)}, (await Bun.file(${JSON.stringify(log)}).exists() ? await Bun.file(${JSON.stringify(log)}).text() : '') + JSON.stringify(args) + '\\n');
    if (args[0] !== 'batch' || args[1] !== 'get' || !args.includes('--offline') || !args.includes('--db-path')) process.exit(9);
    const ids = args.slice(2, args.indexOf('--offline'));
    console.log(JSON.stringify({ found: ids.length, missing: 0, results: ids.map(id => ({ id, node: { id, name: 'Private item ' + id } })) }));
  `));
  await chmod(binary, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  await writeFile(join(goals, "G8.active-item-limit.params.json"), JSON.stringify({ collection: resource }));
  const events: ExecutionRunFinishedEvent[] = [];
  const stdout: string[] = [];
  const deps = { somaHome, env: { SOMA_PRINCIPAL: "jc" }, now: () => now, stdout: (line: string) => stdout.push(line),
    publish: async (event: ExecutionRunFinishedEvent) => { events.push(event); } };
  return { root, bin, goals, index, resource, deps, events, stdout, log, binary };
}

test("Tana reader preserves all option IDs, tag-ID membership and sync age without writes", async () => {
  const f = await fixture({ age: COLLECTION_MAX_AGE_MS });
  expect(Bun.which("supertag", { PATH: process.env.PATH })).toBe(f.binary);
  const before = await readFile(f.index);
  const read = await readTanaCollection(f.resource.source, now);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("expected read");
  expect(read.indexAgeMs).toBe(COLLECTION_MAX_AGE_MS);
  expect(read.items).toEqual(FIXTURE_ITEMS);
  expect(read.items.some((i) => i.id === "other")).toBe(false);
  expect(read.items.every((i) => !JSON.stringify(i).includes("Private"))).toBe(true);
  expect(await readFile(f.index)).toEqual(before);
  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const call of calls) {
    expect(call.slice(0, 2)).toEqual(["batch", "get"]);
    expect(call).toContain("--offline");
    expect(call).toContain("private-tag");
    expect(call).not.toContain("label-is-irrelevant");
  }
  expect(await measureActiveItems(f.resource, 3, now)).toMatchObject({ value: "off-track", counts: { active: 4, unclassified: 1, parked: 1, delegated: 1 } });
});

test("Tana reader replays anonymized index tuples independently of the fixture builder", async () => {
  const f = await fixture({ empty: true });
  const db = new Database(f.index);
  db.run("INSERT INTO nodes (id) VALUES ('sample-item'); INSERT INTO tag_applications (data_node_id, tag_id) VALUES ('sample-item', 'private-tag');");
  // Captured raw tuple/row pairs, not constructed by addFieldValues; provenance
  // and the upstream extraction contract are in fixtures/tana-collection/README.md.
  for (const node of tupleSample.nodes) {
    db.query("INSERT INTO nodes (id, node_type, raw_data) VALUES (?, ?, ?)")
      .run(node.id, node.node_type, JSON.stringify(node.raw_data));
  }
  for (const value of tupleSample.field_values) {
    db.query("INSERT INTO field_values (parent_id, field_def_id, tuple_id, value_node_id, value_order) VALUES (?, ?, ?, ?, ?)")
      .run(value.parent_id, value.field_def_id, value.tuple_id, value.value_node_id, value.value_order);
  }
  db.close();
  const before = await readFile(f.index);
  const read = await readTanaCollection(f.resource.source, now);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("expected sample read");
  expect(read.items).toEqual([item("sample-item")]);
  expect(await measureActiveItems(f.resource, 1, now)).toMatchObject({
    value: "on-track", counts: { active: 1, unclassified: 0, parked: 0, delegated: 0 },
  });
  expect(await readFile(f.index)).toEqual(before);
});

test("Tana reader ignores values whose tuple names another attribute", async () => {
  const f = await fixture();
  const db = new Database(f.index);
  addFieldValues(db, "a", "legacy-status", ["x"], "private-status-tag-tuple");
  addFieldValues(db, "a", "other-sphere", ["employer"], "private-sphere-source-tuple");
  addFieldValues(db, "a", "other-text", [""], "");
  db.close();
  const read = await readTanaCollection(f.resource.source, now);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("expected read");
  expect(read.items.find((i) => i.id === "a")).toEqual(item("a"));
  expect(await measureActiveItems(f.resource, 3, now)).toMatchObject({
    counts: { active: 4, unclassified: 1, parked: 1, delegated: 1 },
  });
});

test.each(["private-status", "private-sphere", "other-attribute"])("missing %s tuple makes the read unknown without publishing state", async (field) => {
  const f = await fixture();
  const db = new Database(f.index);
  if (field === "other-attribute") addFieldValues(db, "a", field, ["Private-value"], "");
  db.query("DELETE FROM nodes WHERE id = ?").run(`a-${field}-tuple`);
  db.close();
  const before = await readFile(f.index);
  const state = join(f.goals, "G8.state.json");
  await writeFile(state, "last good snapshot");
  expect(await readTanaCollection(f.resource.source, now)).toEqual({ ok: false });
  expect(await activeItemLimitKind.baseline(activeItemLimitParams.parse({ goal: "G8", max: 100, collection: f.resource }),
    { now: () => now })).toEqual({ state: "unknown" });
  const result = await runActiveItemLimitSensor({ goal: "G8", max: 100 }, f.deps);
  expect(result).toMatchObject({ exitCode: 1, value: "unknown" });
  expect(f.events[0].input.payload.outcome).toBe("failed");
  expect(f.events[0].input.payload.state).toBeUndefined();
  expect(f.stdout).toEqual([]);
  for (const text of [JSON.stringify(result), JSON.stringify(f.events)]) {
    expect(text).not.toContain("Private");
    expect(text).not.toContain(field);
    expect(text).not.toContain(f.index);
  }
  expect(await readFile(state, "utf8")).toBe("last good snapshot");
  expect(await readFile(f.index)).toEqual(before);
});

test.each([null, "Private malformed JSON", "{}", '{"children":[]}', '{"children":[null]}'])("invalid tuple data %s fails closed", async (rawData) => {
  const f = await fixture();
  const db = new Database(f.index);
  db.query("UPDATE nodes SET raw_data = ? WHERE id = 'a-private-status-tuple'").run(rawData);
  db.close();
  expect(await readTanaCollection(f.resource.source, now)).toEqual({ ok: false });
});

test("sensor emits a valid ledger state and counts only, storing names in a 0600 local snapshot", async () => {
  const f = await fixture();
  const result = await runActiveItemLimitSensor({ goal: "G8", max: 3 }, f.deps);
  expect(result).toMatchObject({ exitCode: 0, value: "off-track", counts: { active: 4, max: 3, unclassified: 1, parked: 1, delegated: 1 } });
  expect(f.events).toHaveLength(1);
  const envelope = await buildRunFinishedEnvelope(f.events[0]);
  expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
  expect(f.events[0].input.payload.state).toEqual({ subject: "G8", value: "off-track" });
  expect(f.stdout).toEqual(["G8: off-track (active 4, max 3, unclassified 1, parked 1, delegated 1)"]);
  for (const text of [JSON.stringify(result), JSON.stringify(envelope), f.stdout.join("")]) {
    expect(text).not.toContain("Private");
    expect(text).not.toContain("private-tag");
    expect(text).not.toContain(f.index);
  }
  const state = join(f.goals, "G8.state.json");
  expect(JSON.parse(await readFile(state, "utf8"))).toMatchObject({ over_limit: ["Private item d"], unclassified_items: ["Private item e"] });
  expect((await stat(state)).mode & 0o777).toBe(0o600);
});

test("empty collection and max zero is on-track after a real offline read", async () => {
  const f = await fixture({ empty: true });
  expect(await runActiveItemLimitSensor({ goal: "G8", max: 0 }, f.deps)).toMatchObject({ exitCode: 0, value: "on-track", counts: { active: 0 } });
  expect(await readFile(f.log, "utf8")).toContain("private-tag");
});

test.each([
  { label: "older than 26h", age: COLLECTION_MAX_AGE_MS + 1 },
  { label: "future index", age: -1 },
  { label: "nonzero process", script: "console.error('Private resource secret'); process.exit(7);" },
  { label: "bad JSON", script: "console.log('Private resource secret');" },
  { label: "partial batch", script: "console.log(JSON.stringify({ results: [], missing: 0 }));" },
  { label: "missing batch item", script: "console.log(JSON.stringify({ results: [], missing: 1 }));" },
])("$label yields unknown, exit 1 and no published state or private diagnostic", async (options) => {
  const f = await fixture(options);
  const state = join(f.goals, "G8.state.json");
  await writeFile(state, "last good snapshot");
  const result = await runActiveItemLimitSensor({ goal: "G8", max: 3 }, f.deps);
  expect(result).toMatchObject({ exitCode: 1, value: "unknown" });
  expect(f.stdout).toEqual([]);
  expect(f.events[0].input.payload.outcome).toBe("failed");
  expect(f.events[0].input.payload.state).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("Private");
  expect(JSON.stringify(result)).not.toContain(f.index);
  expect(await readFile(state, "utf8")).toBe("last good snapshot");
});

test.each(["missing", "corrupt", "unknown-tag", "ordinary-node-as-tag", "bad-timestamp", "missing-binary"])("%s index/reader fails closed", async (mode) => {
  const f = await fixture();
  if (mode === "missing") await rm(f.index);
  if (mode === "corrupt") await writeFile(f.index, "Private corrupt index");
  if (mode === "unknown-tag") f.resource.source.tag_id = "absent";
  if (mode === "ordinary-node-as-tag") f.resource.source.tag_id = "other";
  if (mode === "bad-timestamp") {
    const db = new Database(f.index);
    db.run("UPDATE sync_metadata SET last_sync_timestamp = NULL");
    db.close();
  }
  if (mode === "missing-binary") process.env.PATH = f.root;
  expect(await readTanaCollection(f.resource.source, now)).toEqual({ ok: false });
});

test("a second resource-type adapter uses the unchanged state model and runner", async () => {
  const f = await fixture();
  const resource = { ...collection, type: "fixture-collection", source: {} };
  await writeFile(join(f.goals, "G8.active-item-limit.params.json"), JSON.stringify({ collection: resource }));
  expect(await runActiveItemLimitSensor({ goal: "G8", max: 1 }, { ...f.deps,
    readers: { "fixture-collection": async () => ({ ok: true, items: [item("a")], names: new Map(), indexAgeMs: 0 }) },
  })).toMatchObject({ exitCode: 0, value: "on-track", counts: { active: 1 } });
});

test("baseline reads the same source with counts only and no state or publication", async () => {
  const f = await fixture();
  const before = await readdir(f.goals);
  const params = activeItemLimitParams.parse({ goal: "G8", max: 3, collection: f.resource });
  expect(await activeItemLimitKind.baseline(params, { now: () => now })).toEqual({ state: "off-track", summary: "active 4, max 3, unclassified 1, parked 1, delegated 1" });
  expect(await readdir(f.goals)).toEqual(before);
  const db = new Database(f.index);
  db.run("UPDATE sync_metadata SET last_sync_timestamp = 0");
  db.close();
  expect(await activeItemLimitKind.baseline(params, { now: () => now })).toEqual({ state: "unknown" });
});

test("catalog exposes only public params and argv does not contain resource values", async () => {
  const f = await fixture();
  const kind = listGoalKinds().find((kind) => kind.id === "active-item-limit")!;
  expect(kind).toMatchObject({ private: { collection: "tana-collection" }, schedule: { schedule: "0 7 * * 1", timezone: "Europe/Zurich" },
    command: ["soma", "goal", "sense", "active-item-limit"], target: "@jc/goal-sense-active-item-limit" });
  expect(kind.params.properties?.collection).toEqual({ resourceType: "tana-collection" });
  const p = activeItemLimitParams.parse({ goal: "G8", max: 3, collection: f.resource });
  expect(p.snapshot_weekday).toBe(1);
  const parsed = parseGoalArgs([...activeItemLimitKind.command.slice(1), ...activeItemLimitKind.argv(p)]);
  expect(parsed.options.activeItems).toEqual({ goal: "G8", max: 3, snapshot_weekday: 1 });
  expect(activeItemLimitKind.scheduleFor({ ...p, snapshot_weekday: 3 }).schedule).toBe("0 7 * * 3");
  expect(await runGoalCli(parsed, { activeItemSensor: f.deps })).toContain("active 4, max 3");
  expect(await runGoalCli(parseGoalArgs(["goal", "kinds"]))).toContain("active-item-limit\tsensor");
  for (const flags of [["--max", "-1"], ["--max", "1.5"], ["--max", "3", "--collection", "Private"], ["--max", "3", "--snapshot-weekday", "7"]]) {
    expect(() => parseGoalArgs(["goal", "sense", "active-item-limit", "--goal", "G8", ...flags])).toThrow();
  }
});

const reply = { outcome: "fit", supports: ["M0"], drop: "Review later", rationale: "Fits",
  sensor: { kind: "active-item-limit", params: { max: 3 } }, mechanisms: [] };
function backend(value: unknown): InferenceBackend {
  return { kind: "anthropic-api", resolveModel: () => "fixture", async invoke() { return JSON.stringify(value); } };
}

test("missing collection follows needs_input at propose time", async () => {
  const f = await fixture();
  const result = await proposeGoal({ wording: "Private goal", somaHome: f.deps.somaHome, backend: backend(reply), resources: [],
    missions: ["M0 Build"], goals: [], clock: () => now });
  expect(result).toMatchObject({ outcome: "needs_input", needs_input: ["tana-collection"] });
});

test("propose baseline calibrates once; acceptance keeps resolved collection out of staged activation", async () => {
  const f = await fixture();
  const resources = [{ name: "projects", type: "tana-collection", value: f.resource }];
  const result = await proposeGoal({ wording: "Private goal", somaHome: f.deps.somaHome, backend: backend(reply), resources,
    missions: ["M0 Build"], goals: [], clock: () => now });
  expect(result.outcome).toBe("fit");
  if (result.outcome !== "fit") throw new Error("expected fit");
  expect(result.proposal.baseline?.state).toBe("off-track");
  expect(result.proposal.sensor?.params.collection).toBe("<resource:projects>");
  const content = stringify(result.proposal);
  const hash = createHash("sha256").update(content).digest("hex");
  const proposalDir = join(f.goals, "proposals");
  await mkdir(proposalDir, { recursive: true });
  await writeFile(join(proposalDir, `${hash}.yaml`), content);
  // A staged-file conflict rolls back the new private sidecar and record.
  await writeFile(join(f.goals, "G5.activations.yaml"), "existing activation");
  await expect(acceptGoalProposal(f.goals, hash, { clock: () => now, resources })).rejects.toThrow();
  expect(await readdir(f.goals)).not.toContain("G5.active-item-limit.params.json");
  expect(await readdir(f.goals)).not.toContain("G5.md");
  await rm(join(f.goals, "G5.activations.yaml"));
  const accepted = await acceptGoalProposal(f.goals, hash, { clock: () => now, resources });
  const stage = await readFile(join(f.goals, `${accepted.goalId}.activations.yaml`), "utf8");
  expect(stage).not.toContain("private-tag");
  expect(stage).not.toContain("projects");
  expect(stage).not.toContain(f.index);
  expect(Bun.YAML.parse(stage)).toMatchObject({ activations: [{ target: activeItemLimitKind.target,
    payload: { goal: accepted.goalId, max: 3, snapshot_weekday: 1 } }] });
  const local = join(f.goals, `${accepted.goalId}.active-item-limit.params.json`);
  expect(JSON.parse(await readFile(local, "utf8"))).toEqual({ collection: f.resource });
  expect((await stat(local)).mode & 0o777).toBe(0o600);
});

test("executable command uses only public flags and returns private-safe stdout/stderr and exit codes", async () => {
  const f = await fixture();
  const db = new Database(f.index);
  db.query("UPDATE sync_metadata SET last_sync_timestamp = ?").run(Date.now());
  db.close();
  for (const failed of [false, true]) {
    if (failed) await writeFile(f.index, "Private corrupt index");
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "goal", "sense", "active-item-limit", "--goal", "G8", "--max", "3", "--soma-home", f.deps.somaHome], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, SOMA_PRINCIPAL: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(failed ? 1 : 0);
    expect(stdout).toBe(failed ? "" : "G8: off-track (active 4, max 3, unclassified 1, parked 1, delegated 1)\n");
    expect(stderr).not.toContain("Private");
    expect(stderr).not.toContain(f.index);
    if (failed) expect(stderr).toContain("unknown");
  }
});

test("missing local config and failed snapshot storage publish no state and leave no temporary files", async () => {
  const f = await fixture();
  await mkdir(join(f.goals, "G8.state.json"));
  expect(await runActiveItemLimitSensor({ goal: "G8", max: 3 }, f.deps)).toMatchObject({ exitCode: 1, value: "unknown" });
  expect((await readdir(f.goals)).some((name) => name.startsWith(".G8.state."))).toBe(false);
  await rm(join(f.goals, "G8.active-item-limit.params.json"));
  expect(await runActiveItemLimitSensor({ goal: "G8", max: 3 }, f.deps)).toMatchObject({ exitCode: 1, value: "unknown" });
  expect(f.events.every((event) => event.input.payload.state === undefined)).toBe(true);
});

test("large collections use complete read-only batches rather than truncating the count", async () => {
  const f = await fixture({ empty: true });
  const db = new Database(f.index);
  for (let i = 0; i < 205; i++) {
    const id = `item${i}`;
    db.query("INSERT INTO nodes (id, name) VALUES (?, ?)").run(id, "Private project");
    db.query("INSERT INTO tag_applications VALUES (?, ?, ?)").run(id, "private-tag", "ignored label");
    addFieldValues(db, id, "private-status", ["a"], "private-status-tag-tuple");
    addFieldValues(db, id, "private-sphere", ["own"], "");
  }
  db.close();
  expect(await measureActiveItems(f.resource, 205, now)).toMatchObject({ value: "on-track", counts: { active: 205 } });
  const calls: string[][] = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(call.slice(0, 2)).toEqual(["batch", "get"]);
    expect(call.slice(2, call.indexOf("--offline")).length).toBeLessThanOrEqual(100);
  }
});

test("an existing ordinary node cannot masquerade as an empty supertag collection", async () => {
  const f = await fixture();
  f.resource.source.tag_id = "other";
  await writeFile(join(f.goals, "G8.active-item-limit.params.json"), JSON.stringify({ collection: f.resource }));
  expect(await runActiveItemLimitSensor({ goal: "G8", max: 3 }, f.deps)).toMatchObject({ exitCode: 1, value: "unknown" });
  expect(f.events[0].input.payload.state).toBeUndefined();
});

test("propose derives a weekly snapshot schedule from the selected weekday", async () => {
  const f = await fixture();
  const selected = { ...reply, sensor: { ...reply.sensor, params: { max: 3, snapshot_weekday: 3 } } };
  const result = await proposeGoal({ wording: "Private goal", somaHome: f.deps.somaHome, backend: backend(selected),
    resources: [{ name: "projects", type: "tana-collection", value: f.resource }], missions: ["M0 Build"], goals: [], clock: () => now });
  expect(result.outcome).toBe("fit");
  if (result.outcome === "fit") expect(result.proposal.sensor?.schedule).toEqual({ schedule: "0 7 * * 3", timezone: "Europe/Zurich" });
});
