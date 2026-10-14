import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExecutionRunFinished, type ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { runGoalOutline, zurichIsoWeek, type GoalOutlineDeps } from "../src/goal-outline";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { buildRunFinishedEnvelope } from "../src/run-ledger";

const NOW = new Date("2026-10-14T06:30:00Z");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "soma-goal-outline-"));
  roots.push(root);
  const somaHome = join(root, "soma");
  const draftsDir = join(root, "drafts");
  await mkdir(draftsDir);
  const events: ExecutionRunFinishedEvent[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const requests: { prompt: string; level: string }[] = [];
  const queries: unknown[] = [];
  const deps: GoalOutlineDeps = {
    goal: "G5", tanaTag: "capture", draftsDir, somaHome, now: () => NOW,
    env: { SOMA_PRINCIPAL: "jc", MF_SERVES_GOAL: "G999" },
    readCaptures: async (query) => {
      queries.push(query);
      return [{ id: "capture-a", name: "Private capture A", created: "2026-10-12" },
        { id: "capture-b", name: "Private capture B", created: "2026-10-13" }];
    },
    inference: async (prompt, options) => { requests.push({ prompt, level: options.level }); return "1. A recommended article."; },
    publish: async (event) => { events.push(event); },
    stderr: (line) => stderr.push(line), stdout: (line) => stdout.push(line),
  };
  const output = join(somaHome, "outputs", "G5-2026-W42.md");
  return { root, deps, events, stderr, stdout, requests, queries, output };
}

describe("weekly goal outline", () => {
  test("two local captures and one open draft produce a standard outline and one private result reference", async () => {
    const f = await fixture();
    await writeFile(join(f.deps.draftsDir, "article.md"), "---\ndraft: true\n---\nPrivate draft body\n");
    const result = await runGoalOutline(f.deps);
    expect(result).toMatchObject({ exitCode: 0, outputPath: f.output, ledger: "published" });
    const text = await readFile(f.output, "utf8");
    for (const section of ["## Captures", "## Open drafts", "## Outline", "Private capture A", "Private capture B", "Private draft body", "1. A recommended article."]) {
      expect(text).toContain(section);
    }
    expect(f.queries).toEqual([{ tag: "capture", createdAfter: "2026-10-07" }]);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].level).toBe("standard");
    expect(f.requests[0].prompt).toContain("Private draft body");
    expect(f.events).toHaveLength(1);
    const envelope = await buildRunFinishedEnvelope(f.events[0]);
    expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
    expect(envelope.payload).toMatchObject({ ran: { kind: "job", ref: "goal-outline/G5" }, serves: { goal: "G5" },
      outcome: "succeeded", result_ref: "soma:outputs/G5-2026-W42.md" });
    expect(envelope.payload).not.toHaveProperty("state");
    expect(envelope.payload).not.toHaveProperty("detail_ref");
    const wire = JSON.stringify(envelope);
    for (const privateText of ["Private capture", "capture-a", "capture-b", "Private draft body", "article.md", f.deps.draftsDir, "recommended article"]) expect(wire).not.toContain(privateText);
    expect((await stat(f.output)).mode & 0o777).toBe(0o600);
    expect(f.stderr).toEqual([]);
    expect(f.stdout).toEqual(["soma:outputs/G5-2026-W42.md"]);
  });

  test("no inputs succeeds without inference, and ignores absent, false, malformed or string draft values", async () => {
    const f = await fixture();
    f.deps.readCaptures = async () => [];
    for (const [name, text] of Object.entries({
      plain: "No frontmatter", absent: "---\ntitle: Title\n---\nBody", false: "---\ndraft: false\n---\nBody",
      quoted: '---\ndraft: "true"\n---\nBody', malformed: "---\ndraft: [\n---\nBody",
    })) await writeFile(join(f.deps.draftsDir, `${name}.md`), text);
    expect((await runGoalOutline(f.deps)).exitCode).toBe(0);
    expect(f.requests).toHaveLength(0);
    const text = await readFile(f.output, "utf8");
    expect(text).toContain("Nothing was captured");
    expect(text).toContain("No open drafts");
    expect(text).not.toContain("Body");
    expect(f.events[0].input.payload.outcome).toBe("succeeded");
  });

  test("nested drafts are read, CRLF YAML is accepted, and symlinks are skipped", async () => {
    const f = await fixture();
    await mkdir(join(f.deps.draftsDir, "nested"));
    await writeFile(join(f.deps.draftsDir, "nested", "draft.txt"), "---\r\ndraft: true\r\n---\r\nNested body");
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "---\ndraft: true\n---\nOutside body");
    await symlink(outside, join(f.deps.draftsDir, "linked.md"));
    await runGoalOutline(f.deps);
    const text = await readFile(f.output, "utf8");
    expect(text).toContain("nested/draft.txt");
    expect(text).toContain("Nested body");
    expect(text).not.toContain("Outside body");
  });

  test("replacement preserves only the Share drafts section byte-for-byte", async () => {
    const f = await fixture();
    await mkdir(join(f.deps.somaHome, "outputs"), { recursive: true });
    const share = "## Share drafts\r\n\r\n- Keep this  \r\n### Child\r\n```md\r\n## fenced heading\r\n```\r\n\r\n";
    await writeFile(f.output, "# Previous\n## Outline\nOld outline\n" + share + "## Old section\nDiscard\n");
    await runGoalOutline(f.deps);
    const text = await readFile(f.output, "utf8");
    expect(text.endsWith(share)).toBe(true);
    expect(text).not.toContain("Old outline");
    expect(text).not.toContain("Discard");
    expect(await readdir(join(f.deps.somaHome, "outputs"))).toEqual(["G5-2026-W42.md"]);
  });

  test("a final Share drafts section without newline is kept as is", async () => {
    const f = await fixture();
    await mkdir(join(f.deps.somaHome, "outputs"), { recursive: true });
    const share = "## Share drafts\nKeep me";
    await writeFile(f.output, `## Outline\nOld\n${share}`);
    await runGoalOutline(f.deps);
    expect((await readFile(f.output, "utf8")).endsWith(share)).toBe(true);
  });

  test("draft headings and fences cannot impersonate the protected output section", async () => {
    const f = await fixture();
    const path = join(f.deps.draftsDir, "draft.md");
    await writeFile(path, "---\ndraft: true\n---\n## Share drafts\nStale source text\n```md\nExample\n```\n");
    await runGoalOutline(f.deps);
    await writeFile(path, "---\ndraft: true\n---\nUpdated source text\n");
    await runGoalOutline(f.deps);
    const text = await readFile(f.output, "utf8");
    expect(text).toContain("Updated source text");
    expect(text).not.toContain("Stale source text");
    expect(text).not.toContain("## Share drafts");
  });

  for (const mode of ["rejects", "times out"] as const) test(`inference ${mode}: retain sources, fail once without result_ref`, async () => {
    const f = await fixture();
    await writeFile(join(f.deps.draftsDir, "draft.md"), "---\ndraft: true\n---\nRetained draft");
    f.deps.inferenceTimeoutMs = 5;
    let calls = 0;
    f.deps.inference = async () => { calls++; if (mode === "rejects") throw new Error("Private provider echo"); return new Promise(() => {}); };
    const result = await runGoalOutline(f.deps);
    expect(result.exitCode).toBe(1);
    expect(calls).toBe(1);
    const text = await readFile(f.output, "utf8");
    expect(text).toContain("Private capture A");
    expect(text).toContain("Retained draft");
    expect(text).toContain("## Outline\n\nOutline generation failed");
    expect(f.events).toHaveLength(1);
    expect(f.events[0].input.payload.outcome).toBe("failed");
    expect(f.events[0].input.payload).not.toHaveProperty("result_ref");
    expect(f.events[0].input.payload).not.toHaveProperty("state");
    expect(f.stderr.join("\n")).not.toContain("Private provider echo");
  });

  test("a capture read failure preserves the old output and publishes a failed run", async () => {
    const f = await fixture();
    await mkdir(join(f.deps.somaHome, "outputs"), { recursive: true });
    await writeFile(f.output, "Existing output");
    f.deps.readCaptures = async () => { throw new Error("Secret capture text"); };
    expect((await runGoalOutline(f.deps)).exitCode).toBe(1);
    expect(await readFile(f.output, "utf8")).toBe("Existing output");
    expect(f.requests).toHaveLength(0);
    expect(f.events).toHaveLength(1);
    expect(f.events[0].input.payload.outcome).toBe("failed");
    expect(f.events[0].input.payload).not.toHaveProperty("result_ref");
    expect(f.stderr.join()).not.toContain("Secret capture text");
  });

  test("unset principal still writes but does not publish", async () => {
    const f = await fixture();
    f.deps.env = {};
    expect((await runGoalOutline(f.deps)).ledger).toBe("disabled");
    expect(await readFile(f.output, "utf8")).toContain("## Outline");
    expect(f.events).toHaveLength(0);
  });

  test("custom window and goal use the Zurich week and calendar date", async () => {
    const f = await fixture();
    f.deps.days = 14;
    f.deps.goal = "G12";
    f.deps.now = () => new Date("2021-01-03T23:30:00Z");
    const output = join(f.deps.somaHome, "outputs", "G12-2021-W01.md");
    expect((await runGoalOutline(f.deps)).outputPath).toBe(output);
    expect(f.queries).toEqual([{ tag: "capture", createdAfter: "2020-12-21" }]);
    expect(await readFile(output, "utf8")).toContain("# G12 — 2021-W01");
    expect(f.events[0].input.payload).toMatchObject({ ran: { kind: "job", ref: "goal-outline/G12" },
      serves: { goal: "G12" }, result_ref: "soma:outputs/G12-2021-W01.md" });
  });

  test("unwritable output fails without advertising an old result", async () => {
    const f = await fixture();
    await mkdir(f.deps.somaHome);
    await writeFile(join(f.deps.somaHome, "outputs"), "not a directory");
    expect((await runGoalOutline(f.deps)).exitCode).toBe(1);
    expect(f.events[0].input.payload.outcome).toBe("failed");
    expect(f.events[0].input.payload).not.toHaveProperty("result_ref");
  });
});

test("ISO weeks use Zurich midnight, including year rollover and DST", () => {
  expect(zurichIsoWeek(new Date("2021-01-03T23:30:00Z"))).toBe("2021-W01");
  expect(zurichIsoWeek(new Date("2021-01-03T22:30:00Z"))).toBe("2020-W53");
  expect(zurichIsoWeek(new Date("2026-07-05T22:30:00Z"))).toBe("2026-W28");
  expect(zurichIsoWeek(new Date("2026-10-25T23:30:00Z"))).toBe("2026-W44");
});

test("outline CLI parses required options and rejects invalid inputs without echoing private arguments", async () => {
  const f = await fixture();
  const args = ["goal", "outline", "--goal", "G5", "--tana-tag", "capture", "--drafts-dir", f.deps.draftsDir, "--soma-home", f.deps.somaHome];
  const parsed = parseGoalArgs(args);
  expect(parsed.options.outline).toEqual({ goal: "G5", tanaTag: "capture", draftsDir: f.deps.draftsDir, days: 7 });
  expect(await runGoalCli(parsed, { outline: f.deps })).toBe("soma:outputs/G5-2026-W42.md");
  for (const invalid of [["--days", "0"], ["--days", "1.5"], ["--goal", "../../secret"], ["private-unknown-argument"]]) {
    expect(() => parseGoalArgs([...args, ...invalid])).toThrow();
  }
  expect(() => parseGoalArgs(["goal", "outline", "--goal", "G5"])).toThrow("--tana-tag is required");
  f.deps.inference = async () => { throw new Error("unavailable"); };
  await expect(runGoalCli(parsed, { outline: f.deps })).rejects.toMatchObject({ exitCode: 1 });
});

/** Exercise the real capture subprocess and CLI exit handling without touching private Tana data. */
async function cliFixture(script?: string) {
  const f = await fixture();
  const bin = join(f.root, "bin");
  await mkdir(bin);
  if (script !== undefined) {
    const binary = join(bin, "supertag");
    await writeFile(binary, `#!${process.execPath}\n${script}\n`);
    await chmod(binary, 0o755);
  }
  const invoke = (extra: string[] = [], env: Record<string, string> = {}) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"),
    "goal", "outline", "--goal", "G5", "--tana-tag", "capture", "--drafts-dir", f.deps.draftsDir,
    "--soma-home", f.deps.somaHome, ...extra], { env: { ...process.env, PATH: bin, SOMA_PRINCIPAL: "", ...env } });
  return { ...f, invoke };
}

test("real CLI queries only the local index with all required flags and skips inference for no inputs", async () => {
  const f = await cliFixture(`const args = process.argv.slice(2);
    if (args[0] !== 'search' || args[1] !== '--tag' || args[2] !== 'capture'
      || args[3] !== '--created-after' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(args[4])
      || args[5] !== '--json' || args[6] !== '--offline' || args[7] !== '--limit' || args[8] !== '-1') process.exit(9);
    console.log('[]');`);
  const result = f.invoke();
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toMatch(/^soma:outputs\/G5-\d{4}-W\d{2}\.md\n$/);
  const outputs = await readdir(join(f.deps.somaHome, "outputs"));
  expect(outputs).toHaveLength(1);
  expect(await readFile(join(f.deps.somaHome, "outputs", outputs[0]), "utf8")).toContain("Nothing was captured");
});

for (const [label, script, cause] of [
  ["missing", undefined, "supertag is missing"],
  ["nonzero", "console.error('private capture text'); process.exit(7);", "supertag exited 7"],
  ["invalid JSON", "console.log('bad');", "supertag returned invalid JSON"],
  ["invalid shape", "console.log('{}');", "supertag returned an invalid capture list"],
] as const) test(`real CLI fails on ${label} supertag without writing`, async () => {
  const f = await cliFixture(script);
  const result = f.invoke();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(cause);
  expect(result.stderr.toString()).not.toContain("private capture text");
  expect(result.stdout.toString()).toBe("");
  expect(await readdir(f.deps.somaHome).catch(() => [])).toEqual([]);
});

test("real CLI rejects a missing flag with exit 2", async () => {
  const f = await cliFixture("console.log('[]');");
  expect(f.invoke(["--days"]).exitCode).toBe(2);
});

for (const fails of [false, true]) test(`real CLI consumes soma inference once at standard level (${fails ? "failure" : "success"})`, async () => {
  const f = await cliFixture("console.log(JSON.stringify([{id:'c1',name:'Integration capture'}]));");
  const calls = join(f.root, "inference-calls.jsonl");
  const binary = join(f.root, "bin", "claude");
  await writeFile(binary, `#!${process.execPath}
    import { appendFileSync } from 'node:fs';
    const prompt = await new Response(Bun.stdin.stream()).text();
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2),prompt})+'\\n');
    ${fails ? "console.error('Private provider response'); process.exit(7);" : "console.log('An integration recommendation.');"}
  `);
  await chmod(binary, 0o755);
  const result = f.invoke([], { PATH: `${join(f.root, "bin")}${process.platform === "win32" ? ";" : ":"}/usr/bin:/bin` });
  expect(result.exitCode).toBe(fails ? 1 : 0);
  const log = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(log).toHaveLength(1);
  expect(log[0].args).toEqual(["-p", "--model", "sonnet", "--allowedTools", "", "--hookTimeout", "1"]);
  expect(log[0].prompt).toContain("Integration capture");
  const outputs = await readdir(join(f.deps.somaHome, "outputs"));
  expect(outputs).toHaveLength(1);
  const text = await readFile(join(f.deps.somaHome, "outputs", outputs[0]), "utf8");
  expect(text).toContain("Integration capture");
  expect(text).toContain(fails ? "Outline generation failed" : "An integration recommendation.");
  expect(result.stderr.toString()).not.toContain("Private provider response");
});
