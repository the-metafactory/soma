/**
 * The mode-classifier worker parses `algorithm classify` with
 * parseAlgorithmClassifyArgs so it need not load the whole algorithm CLI. For
 * every argument shape the Claude Code hook sends, that parse must give the
 * same options, the same error, and so the same output as the full CLI.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseAlgorithmClassifyArgs, runAlgorithmClassify } from "../src/cli/algorithm-classify";
import { parseAlgorithmArgs, runAlgorithmCli } from "../src/cli/algorithm";

/** The argv the hook builds (mode-classifier-hook.mjs classifyArgs), plus the CLI's own `--prompt` shapes. */
function hookArgs(prompt: string, somaHome?: string, session?: string): string[] {
  const args = ["algorithm", "classify", "--prompt", prompt, "--json", "--record", "--substrate", "claude-code"];
  if (somaHome !== undefined) args.push("--soma-home", somaHome);
  if (session !== undefined) args.push("--session", session);
  return args;
}

const PROMPTS = [
  "use the algorithm to refactor the adapter",
  "Implement a multi-file migration for the adapter",
  "thanks!",
  "the export broke after the last release, fix this bug",
  "--json",
  "--help",
  "-v",
  "--",
  "a prompt\nwith a newline",
];

function settle<T>(fn: () => T): { value: T } | { error: string } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function classifyOptionsOf(args: string[]) {
  return settle(() => {
    const { homeDir, somaHome, prompt, substrate, json, record, session } = parseAlgorithmArgs(args).options;
    return Object.fromEntries(Object.entries({ homeDir, somaHome, prompt, substrate, json, record, session }).filter(([, v]) => v !== undefined));
  });
}

test("parseAlgorithmClassifyArgs matches parseAlgorithmArgs on every argv the hook sends", () => {
  const cases: string[][] = [];
  for (const prompt of PROMPTS) {
    cases.push(hookArgs(prompt), hookArgs(prompt, "/tmp/soma-home"), hookArgs(prompt, "/tmp/soma-home", "sess-1"), hookArgs(prompt, undefined, "--weird"));
  }
  cases.push(hookArgs("hi", "--soma-home"), ["algorithm", "classify", "--prompt"], ["algorithm", "classify", "--substrate", "nope", "--prompt", "x"]);
  for (const args of cases) {
    expect(settle(() => parseAlgorithmClassifyArgs(args))).toEqual(classifyOptionsOf(args));
  }
});

test("runAlgorithmClassify output matches the full CLI, and both refuse a missing prompt alike", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-classify-parity-"));
  try {
    for (const prompt of PROMPTS.filter((p) => !p.startsWith("-"))) {
      for (const json of [true, false]) {
        const args = ["algorithm", "classify", "--prompt", prompt, ...(json ? ["--json"] : []), "--soma-home", somaHome];
        expect(await runAlgorithmClassify(parseAlgorithmClassifyArgs(args))).toBe(await runAlgorithmCli(parseAlgorithmArgs(args)));
      }
    }
    const noPrompt = ["algorithm", "classify", "--json"];
    await expect(runAlgorithmClassify(parseAlgorithmClassifyArgs(noPrompt))).rejects.toThrow("--prompt is required.");
    await expect(runAlgorithmCli(parseAlgorithmArgs(noPrompt))).rejects.toThrow("--prompt is required.");
  } finally {
    await rm(somaHome, { recursive: true, force: true });
  }
});
