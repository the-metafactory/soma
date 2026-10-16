import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parse } from "yaml";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { proposeGoal, formatGoalProposal, type GoalProposeDeps } from "../src/goal-propose";
import { goalKinds, listGoalKinds } from "../src/goal-kinds/registry";
import type { GoalResource } from "../src/home/index";
import type { InferenceBackend, InferenceRequest } from "../src/tools/inference";

const now = new Date("2026-10-16T12:00:00Z");
const wording = "A private fixture outcome for review";
const hint = "A private fixture revision";
const resources: GoalResource[] = [
  { name: "blog", type: "feed", value: "https://private.example.org/feed?token=secret" },
  { name: "social", type: "channels", value: ["linkedin", "mastodon"] },
  { name: "captures", type: "tana-tag", value: "private-capture-tag" },
  { name: "drafts", type: "directory", value: "/private/fixture-drafts" },
];
const fit = {
  outcome: "fit", supports: ["M0"], drop: "Review whether this remains useful", rationale: "The catalog fits",
  sensor: { kind: "feed", params: { goal: "G0", url: "<resource:blog>" } },
  mechanisms: [{ kind: "announce", params: { goal: "G0", url: "<resource:blog>", channels: "<resource:social>" } }],
  overlaps: ["G5 may overlap"],
};

class FixtureBackend implements InferenceBackend {
  readonly kind = "anthropic-api" as const;
  readonly calls: { prompt: string; request: InferenceRequest }[] = [];
  constructor(readonly replies: unknown[]) {}
  resolveModel() { return "fixture"; }
  async invoke(prompt: string, request: InferenceRequest) {
    this.calls.push({ prompt, request });
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return JSON.stringify(reply);
  }
}

async function withHome(work: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "soma-propose-"));
  try { await work(home); } finally { await rm(home, { recursive: true, force: true }); }
}

function deps(home: string, backend = new FixtureBackend([fit])): GoalProposeDeps {
  return {
    somaHome: home, wording, hint, backend, clock: () => now, registry: goalKinds, resources,
    missions: ["M0 — Create useful things"],
    goals: [{ id: "G5", status: "paused", wording: "Existing private wording", supports: ["M0"], sensor: "g5-feed", body: "g5-announce" }],
  };
}

async function proposalFiles(home: string) {
  const root = join(home, "profile", "goals", "proposals");
  try { return await readdir(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("fit hashes the entire private YAML; prints the design and creates no other artifact", async () => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([fit]);
    const result = await proposeGoal(deps(home, backend));
    expect(result.outcome).toBe("fit");
    if (result.outcome !== "fit") throw new Error("Expected fit");
    const file = join(home, "profile", "goals", "proposals", `${result.hash}.yaml`);
    const content = await readFile(file, "utf8");
    expect(createHash("sha256").update(content).digest("hex")).toBe(result.hash);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(parse(content)).toEqual(result.proposal);
    expect(await readdir(home)).toEqual(["profile"]);
    expect(await readdir(join(home, "profile"))).toEqual(["goals"]);
    expect(await readdir(join(home, "profile", "goals"))).toEqual(["proposals"]);
    expect(result.proposal).toMatchObject({
      review_by: "2027-01-15", sensor: { params: { goal: "G0", min: 1, window_days: 7 }, schedule: goalKinds.feed.schedule },
      mechanisms: [{ schedule: goalKinds.announce.schedule }], resources: [],
    });
    const printed = formatGoalProposal(result);
    for (const text of [wording, "M0", "on-track", "30 6 * * *", "35 6 * * *", fit.drop, "2027-01-15", "G5 may overlap"]) expect(printed).toContain(text);
    expect(printed.split("\n").at(-1)).toBe(result.hash);
    expect(backend.calls).toHaveLength(1);
    const { prompt, request } = backend.calls[0];
    expect(request).toMatchObject({ level: "standard", json: true });
    const context = JSON.parse(prompt.split("\n\n").at(-1)!) as Record<string, unknown>;
    expect(context).toMatchObject({ wording, hint, missions: ["M0 — Create useful things"],
      existing_goals: [{ id: "G5", status: "paused", kinds: ["feed", "announce"], wording: "Existing private wording" }],
      kinds: listGoalKinds(), resources: resources.map(({ name, type }) => ({ name, type })),
    });
    for (const resource of resources) expect(prompt).not.toContain(typeof resource.value === "string" ? resource.value : JSON.stringify(resource.value));
  });
});

test.each([
  { sensor: { kind: "invented", params: {} } },
  { sensor: { kind: "announce", params: fit.mechanisms[0].params } },
  { sensor: { kind: "feed", params: { ...fit.sensor.params, min: 0 } } },
  { sensor: { kind: "feed", params: { ...fit.sensor.params, private_field: wording } } },
  { sensor: { ...fit.sensor, schedule: "every second" } },
  { mechanisms: [{ kind: "feed", params: fit.sensor.params }] },
  { mechanisms: [fit.mechanisms[0], fit.mechanisms[0]] },
  { sensor: { kind: "feed", params: { goal: "G0", url: "https://literal.example.org/feed" } } },
  { review_by: "not a date" },
  { supports: ["M42"] },
  { drop: undefined },
])("invalid-then-valid retries once with controlled validation feedback: %j", async (invalid) => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([{ ...fit, ...invalid }, fit]);
    const result = await proposeGoal(deps(home, backend));
    expect(result.outcome).toBe("fit");
    expect(backend.calls).toHaveLength(2);
    const feedback = backend.calls[1].prompt.slice(backend.calls[0].prompt.length);
    expect(feedback).toContain("Validation error:");
    for (const text of [wording, hint, ...resources.map((resource) => JSON.stringify(resource.value))]) expect(feedback).not.toContain(text);
    expect(await proposalFiles(home)).toHaveLength(1);
  });
});

test("executable CLI loads local context and uses a private one-shot inference subprocess", async () => {
  await withHome(async (home) => {
    const profile = join(home, "profile");
    const bin = join(home, "bin");
    await mkdir(profile, { recursive: true });
    await mkdir(bin);
    await writeFile(join(profile, "assistant.md"), "Name: Fixture\n");
    await writeFile(join(profile, "principal.md"), "Name: Fixture\n");
    await writeFile(join(profile, "purpose.md"), "## Missions\n- M0 — Create useful things\n");
    await writeFile(join(profile, "resources.yaml"), `- name: blog\n  type: feed\n  value: ${resources[0].value as string}\n- name: social\n  type: channels\n  value: [linkedin, mastodon]\n`);
    await writeFile(join(bin, "claude"), `#!${process.execPath}
const args = process.argv.slice(2);
const required = ["--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--system-prompt"];
if (required.some(flag => !args.includes(flag))) process.exit(2);
for (const flag of ["--tools", "--setting-sources"]) if (args[args.indexOf(flag) + 1] !== "") process.exit(3);
if (args[args.indexOf("--settings") + 1] !== '{"disableAllHooks":true}') process.exit(4);
if (args[args.indexOf("--debug-file") + 1] !== ${JSON.stringify(devNull)} || args.includes("--hookTimeout")) process.exit(7);
if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== "1" || process.env.DISABLE_TELEMETRY !== "1" || process.env.DISABLE_ERROR_REPORTING !== "1") process.exit(5);
const prompt = await Bun.stdin.text();
if (!prompt.includes("M0") || prompt.includes(${JSON.stringify(resources[0].value)})) process.exit(6);
process.stdout.write(${JSON.stringify(JSON.stringify(fit))});
`, { mode: 0o755 });
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "goal", "propose", "--wording", wording, "--soma-home", home, "--json"], {
      // Exclude Bun's source compilation cache from the artifact assertion.
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: home, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ outcome: "fit", proposal: { wording } });
    expect(await proposalFiles(home)).toEqual([`${result.hash}.yaml`]);
    expect((await readdir(home)).sort()).toEqual(["bin", "profile"]);
    expect((await readdir(profile)).sort()).toEqual(["assistant.md", "goals", "principal.md", "purpose.md", "resources.yaml"]);
  });
});

test("invalid JSON replies retry once with controlled feedback", async () => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([fit]);
    let calls = 0;
    backend.invoke = async (prompt, request) => {
      backend.calls.push({ prompt, request });
      return ++calls === 1 ? "not JSON" : JSON.stringify(fit);
    };
    expect((await proposeGoal(deps(home, backend))).outcome).toBe("fit");
    expect(backend.calls[1].prompt).toContain("Validation error: reply: expected a JSON object");
  });
});

test("invalid twice returns no_fit with sanitized error and no proposal", async () => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([{ ...fit, sensor: { kind: wording, params: { [hint]: resources[0].value } } }]);
    const result = await proposeGoal(deps(home, backend));
    expect(result).toMatchObject({ outcome: "no_fit", error: "sensor: kind is not registered for this role" });
    expect(backend.calls).toHaveLength(2);
    const printed = formatGoalProposal(result);
    for (const text of [wording, hint, resources[0].value as string]) expect(printed).not.toContain(text);
    expect(await proposalFiles(home)).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });
});

test("even a no_fit reply cannot name an unregistered kind without validation", async () => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([{ outcome: "no_fit", rationale: "Unsupported", sensor: { kind: "invented", params: {} } }]);
    expect(await proposeGoal(deps(home, backend))).toMatchObject({ outcome: "no_fit", error: "sensor: kind is not registered for this role" });
    expect(backend.calls).toHaveLength(2);
    expect(await readdir(home)).toEqual([]);
  });
});

test("injected registry owns validation, listing, schedule and state rule", async () => {
  await withHome(async (home) => {
    const kind = { ...goalKinds.feed, id: "fixture", schedule: { schedule: "0 12 * * *", timezone: "UTC" }, stateRule: () => "Fixture state rule" };
    const backend = new FixtureBackend([{ ...fit, sensor: { kind: "fixture", params: fit.sensor.params }, mechanisms: [] }]);
    const result = await proposeGoal({ ...deps(home, backend), registry: { fixture: kind } });
    expect(result).toMatchObject({ outcome: "fit", proposal: { sensor: { kind: "fixture", schedule: kind.schedule, state_rule: "Fixture state rule" } } });
    expect(backend.calls[0].prompt).toContain('"id":"fixture"');
    expect(backend.calls[0].prompt).not.toContain('"id":"announce"');
  });
});

test("unused or public --param keys are refused without echoing their spelling", async () => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([fit]);
    await expect(proposeGoal({ ...deps(home, backend), params: { [wording]: hint } })).rejects.toThrow("Goal proposal --param must name a private parameter, resource or resource type");
    expect(backend.calls).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });
});

test("a repeated identical proposal is reusable but a changed hash-named file is refused", async () => {
  await withHome(async (home) => {
    const result = await proposeGoal(deps(home));
    expect(result.outcome).toBe("fit");
    if (result.outcome !== "fit") throw new Error("Expected fit");
    expect(await proposeGoal(deps(home))).toEqual(result);
    await writeFile(join(home, "profile", "goals", "proposals", `${result.hash}.yaml`), "tampered");
    await expect(proposeGoal(deps(home))).rejects.toThrow("Goal proposal failed; check local inputs and inference availability");
  });
});

test("sensor-only fit explicitly warns that nothing moves it", async () => {
  await withHome(async (home) => {
    const result = await proposeGoal(deps(home, new FixtureBackend([{ ...fit, mechanisms: [] }])));
    expect(result.outcome).toBe("fit");
    expect(formatGoalProposal(result)).toContain("Nothing moves this goal. The sweep's pursuit check will flag it.");
  });
});

test.each([undefined, "<resource:absent>"])("missing required private value %j returns needs_input without a file", async (url) => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([{ ...fit, sensor: { kind: "feed", params: { goal: "G0", ...(url ? { url } : {}) } }, mechanisms: [] }]);
    const result = await proposeGoal({ ...deps(home, backend), resources: [] });
    expect(result).toEqual({ outcome: "needs_input", needs_input: ["feed"] });
    expect(backend.calls).toHaveLength(1);
    expect(await readdir(home)).toEqual([]);
  });
});

test("a wrong resource type does not satisfy a private parameter", async () => {
  await withHome(async (home) => {
    const result = await proposeGoal({ ...deps(home), resources: [{ name: "blog", type: "directory", value: "/secret" }] });
    expect(result).toEqual({ outcome: "needs_input", needs_input: ["channels", "feed"] });
    expect(await readdir(home)).toEqual([]);
  });
});

test("model needs_input reports only registered resource types and writes nothing", async () => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([{ outcome: "needs_input", rationale: "Need a resource", needs_input: ["feed"] }]);
    expect(await proposeGoal(deps(home, backend))).toEqual({ outcome: "needs_input", needs_input: ["feed"] });
    expect(await readdir(home)).toEqual([]);
  });
});

test("private overrides beat existing resources, stay out of inference and are stored for staging", async () => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([fit]);
    const override = "https://override.example.org/feed?secret=a=b";
    const result = await proposeGoal({ ...deps(home, backend), params: { url: override, channels: '["custom"]' } });
    expect(result.outcome).toBe("fit");
    if (result.outcome !== "fit") throw new Error("Expected fit");
    expect(result.proposal.sensor.params.url).toBe("<resource:param-feed-url>");
    expect(result.proposal.resources).toContainEqual({ name: "param-feed-url", type: "feed", value: override });
    expect(result.proposal.resources).toContainEqual({ name: "param-announce-channels", type: "channels", value: ["custom"] });
    expect(backend.calls[0].prompt).not.toContain(override);
    expect(backend.calls[0].prompt).not.toContain('["custom"]');
  });
});

test("--param supplies an absent resource and kind-qualified override takes precedence", async () => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([{ ...fit, mechanisms: [] }]);
    const result = await proposeGoal({ ...deps(home, backend), resources: [], params: { url: "bad-url", "feed.url": "https://example.org/feed" } });
    expect(result.outcome).toBe("fit");
  });
});

test.each(["http://private.invalid/secret", "<resource:blog>"])("local resource schema failure is retried without its value: %s", async (value) => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([fit]);
    const result = await proposeGoal({ ...deps(home, backend), resources: [{ name: "blog", type: "feed", value }, resources[1]] });
    expect(result.outcome).toBe("no_fit");
    expect(backend.calls).toHaveLength(2);
    expect(formatGoalProposal(result)).not.toContain(value);
    const feedback = backend.calls[1].prompt.slice(backend.calls[0].prompt.length);
    expect(feedback).not.toContain(value);
    expect(await readdir(home)).toEqual([]);
  });
});

test("outline parameters resolve locally and all kind defaults remain catalog-owned", async () => {
  await withHome(async (home) => {
    const backend = new FixtureBackend([{ ...fit, review_by: "2026-11-01", sensor: { kind: "feed", params: { goal: "G0", min: 3, window_days: 14 } },
      mechanisms: [{ kind: "outline", params: { goal: "G0", tana_tag: "<resource:captures>", drafts_dir: "<resource:drafts>" } }],
    }]);
    const result = await proposeGoal(deps(home, backend));
    expect(result.outcome).toBe("fit");
    if (result.outcome !== "fit") throw new Error("Expected fit");
    expect(result.proposal.review_by).toBe("2026-11-01");
    expect(result.proposal.sensor.state_rule).toContain("3 items in the last 14 days");
    expect(result.proposal.mechanisms[0]).toMatchObject({ params: { days: 7 }, schedule: goalKinds.outline.schedule });
  });
});

test.each(["no_fit", "mechanism_gap"])("%s supplies a generic needed kind without filing anything", async (mode) => {
  await withHome(async (home) => {
    const needed = "A reusable sensor that measures completed media exports";
    const reply = mode === "no_fit" ? { outcome: "no_fit", rationale: "No catalog fit", needed_kind: needed }
      : { ...fit, mechanism_gap: needed, needed_kind: needed };
    const result = await proposeGoal(deps(home, new FixtureBackend([reply])));
    expect(formatGoalProposal(result)).toContain(`Needed kind: ${needed}`);
    expect(await proposalFiles(home)).toHaveLength(mode === "no_fit" ? 0 : 1);
    const bad = await proposeGoal(deps(home, new FixtureBackend([{ outcome: "no_fit", rationale: "No catalog fit", needed_kind: wording }])));
    expect(formatGoalProposal(bad)).not.toContain(wording);
  });
});

test("prunes only hashed proposal files older than 24 hours even on no_fit", async () => {
  await withHome(async (home) => {
    const dir = join(home, "profile", "goals", "proposals");
    await mkdir(dir, { recursive: true });
    const stale = `${"a".repeat(64)}.yaml`;
    const recent = `${"b".repeat(64)}.yaml`;
    const boundary = `${"c".repeat(64)}.yaml`;
    for (const file of [stale, recent, boundary, "keep.txt"]) await writeFile(join(dir, file), "fixture");
    const old = new Date(now.getTime() - 86_400_001);
    await utimes(join(dir, stale), old, old);
    await utimes(join(dir, boundary), new Date(now.getTime() - 86_400_000), new Date(now.getTime() - 86_400_000));
    await utimes(join(dir, recent), now, now);
    await proposeGoal(deps(home, new FixtureBackend([{ outcome: "no_fit", rationale: "No fit" }])));
    expect((await readdir(dir)).sort()).toEqual([recent, boundary, "keep.txt"].sort());
  });
});

test("backend and local read exceptions cannot echo private inputs", async () => {
  await withHome(async (home) => {
    const privateError = new Error(`${wording} ${hint} ${resources[0].value as string}`);
    await expect(proposeGoal(deps(home, new FixtureBackend([privateError])))).rejects.toThrow("Goal proposal inference failed; no proposal written");
    await expect(proposeGoal({ ...deps(home), resources: undefined, missions: undefined, goals: undefined })).rejects.toThrow("Goal proposal failed; check local inputs and inference availability");
    expect(await readdir(home)).toEqual([]);
  });
});

test("CLI parses private repeated params, preserves equals, and renders both output formats", async () => {
  await withHome(async (home) => {
    const args = ["goal", "propose", "--wording", wording, "--hint", hint, "--param", "url=https://example.org/?a=b", "--param", 'channels=["mastodon"]', "--soma-home", home];
    const parsed = parseGoalArgs(args);
    expect(parsed.options.propose).toEqual({ wording, hint, params: { url: "https://example.org/?a=b", channels: '["mastodon"]' } });
    const dependency = { propose: deps(home) };
    const text = await runGoalCli(parsed, dependency);
    expect(text).toContain(`Wording: ${wording}`);
    const json = JSON.parse(await runGoalCli(parseGoalArgs([...args, "--json"]), dependency));
    expect(json).toMatchObject({ outcome: "fit", proposal: { wording } });
    expect(text.split("\n").at(-1)).toBe(json.hash);
    expect(await proposalFiles(home)).toHaveLength(1);
  });
});

test.each([
  { args: ["--wording"] }, { args: ["--param", "secret"] }, { args: ["--param", "x="] },
  { args: ["--param", "=secret"] }, { args: ["--unknown", "secret"] },
])("CLI usage failures are value-free: %j", ({ args }) => {
  try {
    parseGoalArgs(["goal", "propose", ...args]);
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).toContain("Usage: soma goal propose");
  }
});
