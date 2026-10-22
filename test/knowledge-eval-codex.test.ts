import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  PINNED_CODEX_MODEL,
  codexCommand,
  codexRunner,
  parseArgs,
  parseCodexStream,
  probedAfterLastEdit,
  sourcesRead,
  storeRoot,
  TrialUsageError,
} from "../scripts/knowledge-eval-trial";

const FIXTURES = join(import.meta.dir, "fixtures", "knowledge-eval");
const EXEC = readFileSync(join(FIXTURES, "codex-exec.jsonl"), "utf8");
const ROLLOUT = readFileSync(join(FIXTURES, "codex-rollout.jsonl"), "utf8");
const SCRIPT = join(import.meta.dir, "..", "scripts", "knowledge-eval.ts");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(args, { cwd, env: GIT_ENV });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function line(event: unknown): string {
  return JSON.stringify(event);
}

function completed(item: Record<string, unknown>): string {
  return line({ type: "item.completed", item });
}

describe("codex command builder", () => {
  test("pins model, effort and sandbox, reads the prompt from stdin and names the worktree", () => {
    expect(codexCommand("codex", { cwd: "/work/tree", model: "gpt-6.1-sol", gitDir: "/cache.git" })).toEqual([
      "codex", "exec", "--json", "-C", "/work/tree", "-m", "gpt-6.1-sol",
      "-c", 'model_reasoning_effort="high"', "--sandbox", "workspace-write", "--add-dir", "/cache.git", "-",
    ]);
  });

  test("the model defaults to the one ranger dispatches on codex, and claude keeps its own", () => {
    const base = ["trial", "--fixture", "f", "--arm", "a", "--home-source", "/tmp"];
    expect(parseArgs([...base, "--substrate", "codex"]).options.model).toBe(PINNED_CODEX_MODEL);
    expect(parseArgs([...base, "--substrate", "claude"]).options.model).toBe("claude-sonnet-5-5");
    expect(parseArgs([...base, "--substrate", "codex", "--model", "other"]).options.model).toBe("other");
    expect(parseArgs([...base, "--substrate", "codex", "--codex-bin", "/x/codex"]).codexBin).toBe("/x/codex");
  });
});

describe("codex usage parser against recorded events", () => {
  test("start of session is the first model call's input and the total is input plus output", () => {
    const facts = parseCodexStream(EXEC, ROLLOUT);
    expect(facts.startTokens).toBe(14383);
    expect(facts.totalTokens).toBe(28866);
    expect(facts.resultIsError).toBe(false);
    expect(facts.toolUses).toEqual([{ name: "Bash", input: { command: "cat a.txt" } }]);
  });

  test("without a rollout the total is measured and the start is not guessed", () => {
    const facts = parseCodexStream(EXEC);
    expect(facts.totalTokens).toBe(28866);
    expect(facts.startTokens).toBe("unmeasured");
  });

  test("events without usage record unmeasured, never 0", () => {
    const bare = EXEC.split("\n").filter((entry) => !entry.includes("turn.completed")).join("\n");
    const facts = parseCodexStream(bare);
    expect(facts.startTokens).toBe("unmeasured");
    expect(facts.totalTokens).toBe("unmeasured");
    expect(parseCodexStream("not json\n\n")).toMatchObject({ startTokens: "unmeasured", totalTokens: "unmeasured", toolUses: [] });
  });

  test("a turn.failed event marks the result as an error", () => {
    expect(parseCodexStream(line({ type: "turn.failed", error: { message: "boom" } })).resultIsError).toBe(true);
  });

  test("command, file_change and failed items map onto the tool-use analysis", () => {
    const stream = [
      completed({ id: "1", type: "command_execution", command: "/bin/zsh -lc 'cat src/run-ledger.ts'", aggregated_output: "x", exit_code: 0, status: "completed" }),
      completed({ id: "2", type: "command_execution", command: "/bin/bash -lc \"cat docs/missing.md\"", aggregated_output: "", exit_code: 1, status: "failed" }),
      completed({ id: "3", type: "file_change", changes: [{ path: "/w/src/new.ts", kind: "add" }], status: "completed" }),
      completed({ id: "4", type: "command_execution", command: "bun test", aggregated_output: "", exit_code: 0, status: "completed" }),
      completed({ id: "5", type: "agent_message", text: "done" }),
    ].join("\n");
    const { toolUses } = parseCodexStream(stream);
    expect(toolUses.map((use) => use.name)).toEqual(["Bash", "Bash", "Edit", "Bash"]);
    expect(sourcesRead(["src/run-ledger.ts", "docs/missing.md"], toolUses)).toEqual(["src/run-ledger.ts"]);
    expect(probedAfterLastEdit(toolUses)).toBe(true);
    expect(probedAfterLastEdit(toolUses.slice(0, 3))).toBe(false);
  });
});

describe("codex preflight", () => {
  test("a missing codex binary refuses with a usage error", async () => {
    await expect(codexRunner("/nonexistent/codex").preflight?.()).rejects.toBeInstanceOf(TrialUsageError);
  });
});

describe("end to end with a stub codex", () => {
  let root: string;
  let principal: string;
  let somaHome: string;
  let store: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ko-codex-")));
    principal = join(root, "principal");
    somaHome = join(principal, ".soma");
    store = storeRoot(somaHome);
    mkdirSync(join(store, "fixtures"), { recursive: true });
    mkdirSync(join(somaHome, "memory"), { recursive: true });
    writeFileSync(join(somaHome, "memory", "MEMORY.md"), "# principal memory\n");
    mkdirSync(join(principal, ".codex"), { recursive: true });
    writeFileSync(join(principal, ".codex", "auth.json"), '{"tokens":{"access_token":"principal-secret"}}\n');
    writeFileSync(join(principal, ".codex", "config.toml"), 'model = "principal-model"\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeRepo(): { url: string; rev: string } {
    const url = join(root, "upstream");
    mkdirSync(url, { recursive: true });
    writeFileSync(join(url, "README.md"), "# Intro\n");
    sh(url, "git", "init", "-q", "-b", "main");
    sh(url, "git", "add", "-A");
    sh(url, "git", "commit", "-q", "-m", "init");
    return { url, rev: sh(url, "git", "rev-parse", "HEAD") };
  }

  function writeFixture(repo: { url: string; rev: string }): void {
    writeFileSync(join(store, "fixtures", "tiny.json"), JSON.stringify({
      id: "tiny", domain: "soma", capability: "discover-reuse", condition: "correct", repo: repo.url, rev: repo.rev,
      prompt: "Read the README.", seed: [], hints: ["h1", "h2", "h3"], acceptance_probe: "test -f made.txt",
      expected_sources: ["README.md"], forbidden_duplicates: [], known_wrong: "none",
    }));
  }

  function stubCodex(): { bin: string; log: string } {
    const bin = join(root, "codex-stub");
    const log = join(root, "codex-stub.log");
    writeFileSync(bin, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi',
      `printf '%s\\n' "$@" > "${log}"`,
      `echo "CODEX_HOME=$CODEX_HOME" >> "${log}"`,
      `echo "HOME=$HOME" >> "${log}"`,
      `if [ -f "$CODEX_HOME/AGENTS.md" ]; then echo "projected=yes" >> "${log}"; fi`,
      `if [ -f "$CODEX_HOME/auth.json" ]; then echo "auth=copied" >> "${log}"; fi`,
      `echo "key=$OPENAI_API_KEY" >> "${log}"`,
      `echo "codexkey=$CODEX_API_KEY" >> "${log}"`,
      "cat >/dev/null",
      "echo done > made.txt",
      'mkdir -p "$CODEX_HOME/sessions/2026/10/22"',
      `cp "${join(FIXTURES, "codex-rollout.jsonl")}" "$CODEX_HOME/sessions/2026/10/22/rollout-stub.jsonl"`,
      `cat "${join(FIXTURES, "codex-exec.jsonl")}"`,
      "",
    ].join("\n"));
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  function hashTree(dir: string, skip: (rel: string) => boolean): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (current: string): void => {
      for (const name of readdirSync(current).sort()) {
        const full = join(current, name);
        const rel = relative(dir, full);
        if (skip(rel)) continue;
        if (statSync(full).isDirectory()) walk(full);
        else out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    };
    walk(dir);
    return out;
  }

  async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const scrubbed = new Set(["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"]);
    const inherited = Object.entries(process.env).filter(([name]) => !scrubbed.has(name));
    const env: Record<string, string | undefined> = { ...Object.fromEntries(inherited), HOME: principal, SOMA_HOME: somaHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-cache"), ...extraEnv };
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  }

  const trialArgs = (bin: string): string[] => [
    "trial", "--fixture", "tiny", "--arm", "e2e", "--home-source", somaHome, "--substrate", "codex", "--soma-home", somaHome, "--codex-bin", bin,
  ];
  const skipStore = (rel: string): boolean => rel.startsWith(join(".soma", "evals", "knowledge-orientation", "results")) || rel.startsWith(join(".soma", "evals", "knowledge-orientation", "cache"));

  test("projects into the trial home, records codex and its version, and leaves ~/.codex byte-unchanged", async () => {
    writeFixture(makeRepo());
    const { bin, log } = stubCodex();
    const before = hashTree(principal, skipStore);

    const { code, stdout, stderr } = await runCli(trialArgs(bin));
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });

    const record = JSON.parse(readFileSync(stdout.trim().split(": ")[1] ?? "", "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      outcome: "completed",
      substrate: "codex",
      cli: { name: "codex", version: "9.9.9" },
      model: "gpt-6.1-sol",
      probe_exit: 0,
      start_of_session_tokens: 14383,
      total_tokens: 28866,
    });
    const seen = readFileSync(log, "utf8").split("\n");
    expect(seen.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(seen).toContain("-m");
    expect(seen).toContain("gpt-6.1-sol");
    const codexHome = seen.find((entry) => entry.startsWith("CODEX_HOME="))?.slice("CODEX_HOME=".length) ?? "";
    expect(codexHome.startsWith(principal)).toBe(false);
    expect(codexHome.endsWith(join("home", ".codex"))).toBe(true);
    expect(seen).toContain("projected=yes");
    expect(seen).toContain("auth=copied");
    expect(hashTree(principal, skipStore)).toEqual(before);
  }, 120_000);

  test("a caller API key is passed through and no auth.json is copied", async () => {
    writeFixture(makeRepo());
    const { bin, log } = stubCodex();
    const { code, stderr } = await runCli(trialArgs(bin), { OPENAI_API_KEY: "sk-caller" });
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const seen = readFileSync(log, "utf8").split("\n");
    expect(seen).toContain("key=sk-caller");
    expect(seen).toContain("codexkey=sk-caller");
    expect(seen).not.toContain("auth=copied");
  }, 120_000);

  test("a missing codex refuses with a non-zero exit before anything is cloned", async () => {
    writeFixture(makeRepo());
    for (const command of ["trial", "batch"]) {
      const args = command === "trial" ? trialArgs("/nonexistent/codex") : ["batch", "--arms", "a", "--home-source", somaHome, "--substrate", "codex", "--soma-home", somaHome, "--codex-bin", "/nonexistent/codex"];
      const { code, stderr } = await runCli(args);
      expect(code).not.toBe(0);
      expect(stderr).toContain("codex");
    }
    expect(existsSync(join(store, "cache"))).toBe(false);
    expect(existsSync(join(store, "batches"))).toBe(false);
  });
});
