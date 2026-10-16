import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateGoalRecord } from "../src/goal-records";

const roots: string[] = [];
const record = "---\nid: G8\nstatus: draft\nsupports: []\nsensor: g8-feed\nreview_by: 2026-12-31\n---\nPrivate goal wording\n";
const staged = "# Retain the accepted bytes\nschema: metafactory/activation/v1\nactivations:\n  - id: g8-feed\n    payload: {url: 'https://private.example/feed'}\n  - id: g8-outline\n";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "soma-activate-"));
  roots.push(root);
  const goalsDir = join(root, "soma-home", "profile", "goals");
  const activationsDir = join(root, "activations");
  await mkdir(goalsDir, { recursive: true });
  await mkdir(activationsDir);
  const goal = join(goalsDir, "G8.md");
  const stage = join(goalsDir, "G8.activations.yaml");
  const target = join(activationsDir, "g8.yaml");
  await writeFile(goal, record);
  await writeFile(stage, staged, { mode: 0o600 });
  return { root, goalsDir, activationsDir, goal, stage, target,
    activate: () => activateGoalRecord(goalsDir, "G8", activationsDir) };
}

test("activation installs the exact staged bytes privately before checking its sensor and marking active", async () => {
  const f = await fixture();
  expect(await f.activate()).toEqual(["g8-feed", "g8-outline"]);
  expect(await readFile(f.target, "utf8")).toBe(staged);
  expect((await stat(f.target)).mode & 0o777).toBe(0o600);
  expect(await readFile(f.stage, "utf8")).toBe(staged);
  expect(await readFile(f.goal, "utf8")).toBe(record.replace("status: draft", "status: active"));
});

test("staging can install into an activations directory that does not yet exist", async () => {
  const f = await fixture();
  await rm(f.activationsDir, { recursive: true });
  await f.activate();
  expect(await readFile(f.target, "utf8")).toBe(staged);
});

test("a different target is named and leaves the goal, stage and existing activations untouched", async () => {
  const f = await fixture();
  const previous = staged.replace("g8-outline", "previous-mechanism");
  await writeFile(f.target, previous, { mode: 0o640 });
  const before = await stat(f.target);
  await expect(f.activate()).rejects.toThrow(`already exists with different content: ${f.target}`);
  expect(await readFile(f.target, "utf8")).toBe(previous);
  expect(await stat(f.target)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, mode: before.mode });
  expect(await readFile(f.stage, "utf8")).toBe(staged);
  expect(await readFile(f.goal, "utf8")).toBe(record);
  expect(await readdir(f.activationsDir)).toEqual(["g8.yaml"]);
});

test("an identical target is reused without rewriting it, including on a repeated activation", async () => {
  const f = await fixture();
  await writeFile(f.target, staged, { mode: 0o600 });
  const before = await stat(f.target);
  expect(await f.activate()).toEqual(["g8-feed", "g8-outline"]);
  expect(await f.activate()).toEqual(["g8-feed", "g8-outline"]);
  expect(await stat(f.target)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, mode: before.mode });
});

test.each(["absent sensor", "invalid staged blueprint", "invalid existing blueprint", "unpatchable status"])(
  "%s rolls back the new install, retains staging and leaves the goal draft", async (failure) => {
    const f = await fixture();
    let goal = record;
    let stage = staged;
    let expected = "sensor is absent";
    if (failure === "absent sensor") stage = staged.replace("g8-feed", "other-feed");
    if (failure === "invalid staged blueprint") {
      stage = "schema: [private-input";
      expected = f.target;
    }
    if (failure === "invalid existing blueprint") {
      await writeFile(join(f.activationsDir, "other.yaml"), "schema: [");
      expected = "other.yaml";
    }
    if (failure === "unpatchable status") {
      goal = record.replace("status: draft", 'status:\n  "draft"');
      expected = "status must be a single-line scalar";
    }
    await writeFile(f.goal, goal);
    await writeFile(f.stage, stage);
    await expect(f.activate()).rejects.toThrow(expected);
    expect(await readFile(f.goal, "utf8")).toBe(goal);
    expect(await readFile(f.stage, "utf8")).toBe(stage);
    expect(await readdir(f.activationsDir)).toEqual(failure === "invalid existing blueprint" ? ["other.yaml"] : []);
  },
);

test("failed validation never removes an identical pre-existing target", async () => {
  const f = await fixture();
  await writeFile(f.target, staged);
  await writeFile(join(f.activationsDir, "bad.yaml"), "schema: [");
  await expect(f.activate()).rejects.toThrow("bad.yaml");
  expect(await readFile(f.target, "utf8")).toBe(staged);
  expect(await readFile(f.goal, "utf8")).toBe(record);
});

test("a hand-written goal with no staged file checks existing blueprints and installs nothing", async () => {
  const f = await fixture();
  await rm(f.stage);
  await writeFile(join(f.activationsDir, "sensor.yaml"), staged);
  expect(await f.activate()).toEqual([]);
  expect(await readdir(f.activationsDir)).toEqual(["sensor.yaml"]);
  expect(await readFile(f.goal, "utf8")).toContain("status: active");
});

test("an unreadable staged path fails closed without installing or changing status", async () => {
  const f = await fixture();
  await rm(f.stage);
  await mkdir(f.stage);
  await expect(f.activate()).rejects.toThrow(`Cannot read staged Reflex blueprint: ${f.stage}`);
  expect(await readdir(f.activationsDir)).toEqual([]);
  expect(await readFile(f.goal, "utf8")).toBe(record);
});
