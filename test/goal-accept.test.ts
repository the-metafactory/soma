import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { acceptGoalProposal } from "../src/goal-accept";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { goalKinds } from "../src/goal-kinds/registry";
import { loadGoalRecords } from "../src/goal-records";
import { proposeGoal } from "../src/goal-propose";
import type { GoalResource } from "../src/goal-resources";
import type { InferenceBackend } from "../src/tools/inference";

const roots: string[] = [];
const now = new Date("2026-10-16T12:00:00Z");
const wording = "Private publishing goal";
const drop = "Stop when the private plan no longer serves me.";
const resources: GoalResource[] = [
  { name: "blog", type: "feed", value: "https://private.example.org/feed?secret=yes" },
  { name: "captures", type: "tana-tag", value: "private-capture-tag" },
  { name: "drafts", type: "directory", value: "/private/drafts" },
  { name: "social", type: "channels", value: ["mastodon", "linkedin"] },
];
const deps = { clock: () => now, resources };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function proposal() {
  return {
    version: 1, outcome: "fit", created_at: now.toISOString(), wording,
    supports: ["M0", "M1"], review_by: "2027-01-15", drop,
    sensor: { kind: "feed", params: { goal: "G0", url: "<resource:blog>", min: 2, window_days: 14 }, schedule: goalKinds.feed.schedule },
    mechanisms: [
      { kind: "outline", params: { goal: "G0", tana_tag: "<resource:captures>", drafts_dir: "<resource:drafts>", days: 7 }, schedule: goalKinds.outline.schedule },
      { kind: "announce", params: { goal: "G0", url: "<resource:blog>", channels: "<resource:social>" }, schedule: goalKinds.announce.schedule },
    ],
    rationale: "Private rationale", resources: [], warnings: [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "soma-goal-accept-"));
  roots.push(root);
  const home = join(root, "soma");
  const goalsDir = join(home, "profile", "goals");
  const proposalsDir = join(goalsDir, "proposals");
  await mkdir(proposalsDir, { recursive: true });
  const save = async (value: unknown = proposal()) => {
    const content = typeof value === "string" ? value : stringify(value);
    const hash = createHash("sha256").update(content).digest("hex");
    const path = join(proposalsDir, `${hash}.yaml`);
    await writeFile(path, content, { mode: 0o600 });
    return { hash, path, content };
  };
  return { root, home, goalsDir, proposalsDir, save };
}

test("accept persists the exact draft design and one private staged activation per kind", async () => {
  const f = await fixture();
  await writeFile(join(f.goalsDir, "G5.md"), "allocated");
  await writeFile(join(f.goalsDir, "G7.md"), "allocated");
  const p = proposal();
  p.wording = `  ${wording}  `;
  const saved = await f.save(p);
  expect(await acceptGoalProposal(f.goalsDir, saved.hash, deps)).toEqual({
    goalId: "G8", activationIds: ["g8-feed", "g8-outline", "g8-announce"],
  });
  const record = await readFile(join(f.goalsDir, "G8.md"), "utf8");
  const [fields, body] = record.slice(4).split("\n---\n");
  expect(Bun.YAML.parse(fields)).toEqual({ id: "G8", status: "draft", supports: p.supports, review_by: p.review_by, sensor: "g8-feed" });
  expect(body.split("\n")[0]).toBe(p.wording);
  expect(body).toContain(`Drop: ${drop}\n`);
  for (const mechanism of p.mechanisms) expect(body).toContain(`- g8-${mechanism.kind}: ${JSON.stringify(mechanism.params)}`);
  const stage = Bun.YAML.parse(await readFile(join(f.goalsDir, "G8.activations.yaml"), "utf8"));
  expect(stage).toEqual({
    schema: "metafactory/activation/v1",
    activations: [
      { id: "g8-feed", target: goalKinds.feed.target, serves: { goal: "G8" }, when: p.sensor.schedule, payload: { goal: "G8", url: resources[0].value, min: 2, window_days: 14 } },
      { id: "g8-outline", target: goalKinds.outline.target, serves: { goal: "G8" }, when: p.mechanisms[0].schedule, payload: { goal: "G8", tana_tag: resources[1].value, drafts_dir: resources[2].value, days: 7 } },
      { id: "g8-announce", target: goalKinds.announce.target, serves: { goal: "G8" }, when: p.mechanisms[1].schedule, payload: { goal: "G8", url: resources[0].value, channels: resources[3].value } },
    ],
  });
  for (const name of ["G8.md", "G8.activations.yaml"]) expect((await stat(join(f.goalsDir, name))).mode & 0o777).toBe(0o600);
  expect(await readdir(f.proposalsDir)).toEqual([]);
  expect(await readdir(f.root)).toEqual(["soma"]);
});

test("proposal-local resource overrides win and filesystem resources load by default", async () => {
  const f = await fixture();
  await writeFile(join(f.home, "profile", "resources.yaml"), stringify(resources));
  const override = "https://override.example.org/private";
  const saved = await f.save({ ...proposal(), resources: [{ name: "blog", type: "feed", value: override }] });
  await acceptGoalProposal(f.goalsDir, saved.hash, { clock: () => now });
  const stage = Bun.YAML.parse(await readFile(join(f.goalsDir, "G5.activations.yaml"), "utf8"));
  expect(stage).toMatchObject({ activations: [
    { payload: { url: override } }, { payload: { tana_tag: resources[1].value } }, { payload: { url: override } },
  ] });
});

test.each([true, false])("no_fit stages fitting mechanisms without a sensor (mechanisms: %j)", async (hasMechanisms) => {
  const f = await fixture();
  const p = { ...proposal(), outcome: "no_fit", sensor: null, mechanisms: hasMechanisms ? proposal().mechanisms : [] };
  const saved = await f.save(p);
  const result = await acceptGoalProposal(f.goalsDir, saved.hash, deps);
  expect(result).toEqual({ goalId: "G5", activationIds: hasMechanisms ? ["g5-outline", "g5-announce"] : [] });
  const loaded = await loadGoalRecords(f.goalsDir, ["M0 Mission", "M1 Mission"]);
  expect(loaded.warnings).toEqual([]);
  expect(loaded.goals[0]).toMatchObject({ id: "G5", status: "draft", reviewBy: p.review_by, wording });
  expect(loaded.goals[0].sensor).toBeUndefined();
  const stage = Bun.YAML.parse(await readFile(join(f.goalsDir, "G5.activations.yaml"), "utf8"));
  expect(stage).toMatchObject({ activations: hasMechanisms ? [
    expect.objectContaining({ id: "g5-outline" }), expect.objectContaining({ id: "g5-announce" }),
  ] : [] });
  expect(await readdir(f.proposalsDir)).toEqual([]);
});

test.each([86_400_000, 86_399_999])("accept permits a proposal aged %i ms", async (age) => {
  const f = await fixture();
  const saved = await f.save({ ...proposal(), created_at: new Date(now.getTime() - age).toISOString() });
  expect((await acceptGoalProposal(f.goalsDir, saved.hash, deps)).goalId).toBe("G5");
});

test.each(["missing", "changed", "stale", "old-file", "future", "invalid-hash"])("%s proposal fails without writes", async (mode) => {
  const f = await fixture();
  const p = proposal();
  if (mode === "stale") p.created_at = new Date(now.getTime() - 86_400_001).toISOString();
  if (mode === "future") p.created_at = new Date(now.getTime() + 1).toISOString();
  const saved = await f.save(p);
  if (mode === "old-file") {
    const old = new Date(now.getTime() - 86_400_001);
    await utimes(saved.path, old, old);
  }
  if (mode === "missing") await rm(saved.path);
  if (mode === "changed") await writeFile(saved.path, saved.content + "# changed\n");
  // Touching an old design must not revive it.
  await utimes(f.proposalsDir, now, now);
  const errors = { missing: "does not exist", changed: "hash mismatch", stale: "older than 24 h", "old-file": "older than 24 h", future: "creation time", "invalid-hash": "SHA-256" };
  await expect(acceptGoalProposal(f.goalsDir, mode === "invalid-hash" ? "../secret" : saved.hash, deps)).rejects.toThrow(errors[mode]);
  expect(await readdir(f.goalsDir)).toEqual(["proposals"]);
  expect(await readdir(f.proposalsDir)).toEqual(mode === "missing" ? [] : [`${saved.hash}.yaml`]);
});

test.each([
  { wording: "private\nwording" }, { supports: ["private"] }, { review_by: "2026-02-30" },
  { version: 2 }, { sensor: null }, { outcome: "no_fit" },
  { mechanisms: [...proposal().mechanisms, proposal().mechanisms[0]] },
  { mechanisms: [{ ...proposal().mechanisms[0], kind: "feed" }] },
  { sensor: { ...proposal().sensor, kind: "invented" } },
  { sensor: { ...proposal().sensor, params: { goal: "G0", url: "<resource:blog>", min: 0 } } },
  { sensor: { ...proposal().sensor, params: { goal: "G0", url: resources[0].value } } },
])("invalid design refuses before allocating: %j", async (patch) => {
  const f = await fixture();
  const saved = await f.save({ ...proposal(), ...patch });
  await expect(acceptGoalProposal(f.goalsDir, saved.hash, deps)).rejects.toThrow("Invalid goal proposal");
  expect(await readdir(f.goalsDir)).toEqual(["proposals"]);
  expect(await readFile(saved.path, "utf8")).toBe(saved.content);
});

test.each([
  { localResources: [] },
  { localResources: [{ name: "blog", type: "directory", value: "/private" }] },
  { localResources: [{ name: "blog", type: "feed", value: "<resource:other>" }] },
])("missing wrong-type or unresolved resources write nothing: %j", async ({ localResources }) => {
  const f = await fixture();
  const saved = await f.save();
  await expect(acceptGoalProposal(f.goalsDir, saved.hash, { ...deps, resources: localResources })).rejects.toThrow("resource");
  expect(await readdir(f.goalsDir)).toEqual(["proposals"]);
});

test("malformed YAML fails without echoing private content", async () => {
  const f = await fixture();
  const saved = await f.save(`wording: [${wording}`);
  await expect(acceptGoalProposal(f.goalsDir, saved.hash, deps)).rejects.toThrow("Goal acceptance failed");
  expect(await readdir(f.goalsDir)).toEqual(["proposals"]);
});

test("a staged-file conflict retains the existing file and proposal and rolls back the draft", async () => {
  const f = await fixture();
  const saved = await f.save();
  const stage = join(f.goalsDir, "G5.activations.yaml");
  await writeFile(stage, "existing stage");
  await expect(acceptGoalProposal(f.goalsDir, saved.hash, deps)).rejects.toThrow("Goal acceptance failed");
  expect(await readFile(stage, "utf8")).toBe("existing stage");
  expect(await readFile(saved.path, "utf8")).toBe(saved.content);
  expect((await readdir(f.goalsDir)).sort()).toEqual(["G5.activations.yaml", "proposals"]);
  expect(await readdir(f.proposalsDir)).toEqual([`${saved.hash}.yaml`]);
});

test("concurrent acceptance consumes a proposal once", async () => {
  const f = await fixture();
  const saved = await f.save();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => acceptGoalProposal(f.goalsDir, saved.hash, deps)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await readdir(f.goalsDir)).sort()).toEqual(["G5.activations.yaml", "G5.md", "proposals"]);
  expect(await readdir(f.proposalsDir)).toEqual([]);
});

test("the real CLI accepts a producer's proposal, prints ids only, and never installs", async () => {
  const f = await fixture();
  const p = proposal();
  const backend: InferenceBackend = { kind: "anthropic-api", resolveModel: () => "fixture", invoke: () => Promise.resolve(JSON.stringify({
    outcome: "fit", supports: p.supports, review_by: p.review_by, drop,
    sensor: { kind: p.sensor.kind, params: p.sensor.params },
    mechanisms: p.mechanisms.map(({ kind, params }) => ({ kind, params })), rationale: "A design",
  })) };
  await writeFile(join(f.home, "profile", "resources.yaml"), stringify(resources));
  const proposed = await proposeGoal({ wording, somaHome: f.home, backend, resources, clock: () => new Date(), missions: ["M0 Mission", "M1 Mission"], goals: [] });
  expect(proposed.outcome).toBe("fit");
  if (proposed.outcome !== "fit") throw new Error("Expected fit");
  const reflex = join(f.root, "reflex");
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "goal", "add", "--accept", proposed.hash, "--soma-home", f.home], {
    env: { ...process.env, REFLEX_ACTIVATIONS_DIR: reflex },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toBe("G5\ng5-feed\ng5-outline\ng5-announce\n");
  expect(await readdir(f.root)).toEqual(["soma"]);
  await expect(runGoalCli(parseGoalArgs(["goal", "add", "--accept", proposed.hash, "--soma-home", f.home]))).rejects.toThrow("does not exist");
});

test("accept CLI supports home-dir and dependency injection", async () => {
  const f = await fixture();
  const saved = await f.save();
  expect(await runGoalCli(parseGoalArgs(["goal", "add", "--accept", saved.hash, "--home-dir", f.root, "--soma-home", f.home]), { accept: deps })).toBe("G5\ng5-feed\ng5-outline\ng5-announce");
});

test.each([
  ["--accept"], ["--accept", wording], ["--accept", "a".repeat(64), "--wording", wording],
  ["--sensor", "private", "--accept", "a".repeat(64)],
  ["--accept", "a".repeat(64), "--accept", "b".repeat(64)],
].map((args) => ({ args })))("CLI rejects ambiguous or invalid acceptance without private values: %j", ({ args }) => {
  expect(() => parseGoalArgs(["goal", "add", ...args])).toThrow("Usage: soma goal add");
  try {
    parseGoalArgs(["goal", "add", ...args]);
  } catch (error) {
    expect(String(error)).not.toContain(wording);
  }
});
