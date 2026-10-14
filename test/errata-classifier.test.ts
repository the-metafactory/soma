import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendSomaMemoryEvent } from "../src/memory";
import { readErrata } from "../src/errata";
import { readJudgments } from "../src/judge";
import { ERRATA_TRIAGE_MODEL } from "../src/errata-classifier";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup(redactedExcerpt = "The output is wrong. token=secret-value") {
  const home = await mkdtemp(join(tmpdir(), "soma-claude-triage-")); homes.push(home);
  const trace = join(home, "trace.jsonl");
  const transcriptPath = join(home, "transcript.jsonl");
  await writeFile(transcriptPath, JSON.stringify({ type: "assistant", uuid: "U1", timestamp: "2026-10-14T04:01:00Z", sessionId: "S1", message: { content: "Delivered output" } }) + "\n");
  await appendSomaMemoryEvent(home, { id: "feedback-1", timestamp: "2026-10-14T04:02:00Z", kind: "feedback.candidate", substrate: "claude-code", summary: "Feedback", metadata: {
    actor: "interactive", sessionId: "S1", transcriptPath, redactedExcerpt,
  } });
  const executable = join(home, "claude");
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const version = args.includes("--version");
const text = version ? "" : await Bun.stdin.text();
appendFileSync(process.env.FAKE_TRACE, JSON.stringify({ args, text, cwd: process.cwd(), entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT }) + "\\n");
const mode = process.env.FAKE_MODE;
if (mode === "nonzero" || (mode === "version-failure" && version)) {
  console.error("PRIVATE SUBPROCESS TEXT"); process.exit(7);
}
if (version) { console.log("2.1.296 (Claude Code)"); process.exit(0); }
if (mode === "bad-json") { console.log("PRIVATE BAD JSON"); process.exit(0); }
const verdict = mode === "bad-verdict" ? "unknown" : mode === "drop" ? "drop" : "promote";
const reason = mode === "long-reason" ? "x".repeat(241) : "Rejects the delivered output.";
console.log(JSON.stringify({ type: "result", subtype: mode === "error-result" ? "error_max_turns" : "success", is_error: mode === "error-result", structured_output: { verdict, reason } }));
`, { mode: 0o700 });
  async function cli(mode: string, missing = false) {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "errata", "triage", "--soma-home", home], {
      env: { ...process.env, PATH: missing ? join(home, "absent") : home, SOMA_PRINCIPAL: "", FAKE_TRACE: trace, FAKE_MODE: mode },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  return { home, trace, cli };
}

test("explicit marker promotes through the CLI even with Claude absent from PATH", async () => {
  const { home, trace, cli } = await setup("errata: The output is wrong.");
  const result = await cli("missing", true);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("1 promoted");
  expect(await Bun.file(trace).exists()).toBe(false);
  expect(await readErrata(home)).toHaveLength(1);
  expect((await readJudgments(home)).records).toMatchObject([{
    caller: "errata-triage", backend: "explicit-marker", decision: { eventId: "feedback-1", verdict: "promote" },
  }]);
});

test("Claude process receives fixed model, schema and redacted stdin in isolation; repeat CLI does not invoke it", async () => {
  const { home, trace, cli } = await setup();
  const result = await cli("promote");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("1 promoted");
  const invocations = (await readFile(trace, "utf8")).trim().split("\n").map((line) =>
    JSON.parse(line) as { args: string[]; text: string; cwd: string; entrypoint: string });
  expect(invocations).toHaveLength(2);
  const classification = invocations[1];
  expect(classification.text).toBe("The output is wrong. [redacted]");
  expect(classification.args).toContain("-p");
  expect(classification.args[classification.args.indexOf("--model") + 1]).toBe(ERRATA_TRIAGE_MODEL);
  expect(JSON.parse(classification.args[classification.args.indexOf("--json-schema") + 1]).properties.verdict.enum).toEqual(["promote", "drop"]);
  expect(classification.args).toContain("--safe-mode");
  expect(classification.args[classification.args.indexOf("--tools") + 1]).toBe("");
  expect(classification.args[classification.args.indexOf("--setting-sources") + 1]).toBe("");
  expect(classification.args).toContain("--strict-mcp-config");
  expect(classification.args).toContain("--no-session-persistence");
  expect(classification.entrypoint).toBe("sdk-cli");
  expect(classification.cwd).not.toBe(home);
  expect(await Bun.file(classification.cwd).exists()).toBe(false);
  expect((await readJudgments(home)).records[0]).toMatchObject({ backend: "claude-p", backendVersion: "2.1.296 (Claude Code)" });
  expect(await readErrata(home)).toHaveLength(1);
  expect((await cli("promote")).code).toBe(0);
  expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(2);
});

for (const mode of ["missing", "nonzero", "version-failure", "bad-json", "bad-verdict", "long-reason", "error-result"]) {
  test(`Claude ${mode} leaves feedback unjudged and retryable, and CLI logs no complaint`, async () => {
    const { home, cli } = await setup();
    const result = await cli(mode, mode === "missing");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Errata triage failed");
    expect(result.stdout + result.stderr).not.toContain("PRIVATE");
    expect(result.stdout + result.stderr).not.toContain("secret-value");
    expect(await readErrata(home)).toHaveLength(0);
    expect((await readJudgments(home)).records).toHaveLength(0);
    const retry = await cli("drop");
    expect(retry.code).toBe(0);
    expect(retry.stdout).toContain("1 dropped");
    expect((await readJudgments(home)).records).toHaveLength(1);
  });
}
