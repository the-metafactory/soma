import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  PINNED_PI_MODEL,
  parseArgs,
  parsePiStream,
  piCommand,
  piProviderModels,
  piRunner,
  probedAfterLastEdit,
  sourcesRead,
  storeRoot,
  TrialUsageError,
} from "../scripts/knowledge-eval-trial";

const FIXTURES = join(import.meta.dir, "fixtures", "knowledge-eval");
const PRINT = readFileSync(join(FIXTURES, "pi-print.jsonl"), "utf8");
const SCRIPT = join(import.meta.dir, "..", "scripts", "knowledge-eval.ts");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const PRINCIPAL_MODELS = {
  providers: {
    spark: { baseUrl: "https://spark.example/v1", api: "openai-completions", apiKey: "spark-secret", models: [{ id: "longctx-think" }] },
    other: { baseUrl: "https://other.example/v1", apiKey: "other-secret", models: [{ id: "x" }] },
  },
};

function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(args, { cwd, env: GIT_ENV });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function line(event: unknown): string {
  return JSON.stringify(event);
}

function assistant(usage: Record<string, number> | undefined, stopReason = "stop"): string {
  return line({ type: "message_end", message: { role: "assistant", provider: "spark", model: "longctx-think", stopReason, content: [], ...(usage ? { usage } : {}) } });
}

describe("pi command builder", () => {
  test("print mode, JSON events, no saved session, the pinned provider and model, the prompt after --", () => {
    expect(piCommand("pi", { model: "spark/longctx-think", prompt: "--do it" })).toEqual([
      "pi", "--print", "--mode", "json", "--no-session", "--provider", "spark", "--model", "longctx-think", "--", "--do it",
    ]);
  });

  test("a model without a provider is a usage error", () => {
    expect(() => piCommand("pi", { model: "longctx-think", prompt: "p" })).toThrow(TrialUsageError);
  });

  test("the model defaults to the one ranger dispatches on pi", () => {
    const base = ["trial", "--fixture", "f", "--arm", "a", "--home-source", "/tmp"];
    expect(PINNED_PI_MODEL).toBe("spark/longctx-think");
    expect(parseArgs([...base, "--substrate", "pi"]).options.model).toBe(PINNED_PI_MODEL);
    expect(parseArgs([...base, "--substrate", "pi", "--pi-bin", "/x/pi"]).piBin).toBe("/x/pi");
  });
});

describe("pi usage parser against recorded events", () => {
  test("start of session is the first call's input plus cached input, and the total sums every call", () => {
    const facts = parsePiStream(PRINT);
    expect(facts.model).toBe("spark/longctx-think");
    expect(facts.startTokens).toBe(3007 + 8190);
    expect(facts.totalTokens).toBe(11275 + 11573 + 11707 + 11830);
    expect(facts.resultIsError).toBe(false);
  });

  test("tools map onto the read and edit analysis, and a failed call is matched by its id when calls end out of order", () => {
    const { toolUses } = parsePiStream(PRINT);
    expect(toolUses).toEqual([
      { name: "Read", input: { file_path: "a.txt" } },
      { name: "Edit", input: { file_path: "a.txt" } },
      { name: "Write", input: { file_path: "b.txt" } },
      { name: "Bash", input: { command: "ls missing-dir" }, failed: true },
      { name: "Read", input: { file_path: "a.txt" } },
    ]);
    expect(sourcesRead(["a.txt", "missing-dir"], toolUses)).toEqual(["a.txt"]);
    expect(probedAfterLastEdit(toolUses)).toBe(true);
    expect(probedAfterLastEdit(toolUses.slice(0, 3))).toBe(false);
  });

  test("events without usage, or with all-zero usage, record unmeasured, never 0", () => {
    const bare = PRINT.split("\n").map((entry) => entry.includes('"message_end"') ? entry.replace(/"usage":\{[^}]*"cost":\{[^}]*\}\}/gu, '"usage":null') : entry).join("\n");
    expect(parsePiStream(bare)).toMatchObject({ startTokens: "unmeasured", totalTokens: "unmeasured" });
    const zeros = assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(parsePiStream(zeros)).toMatchObject({ startTokens: "unmeasured", totalTokens: "unmeasured" });
    expect(parsePiStream("not json\n\n")).toMatchObject({ startTokens: "unmeasured", totalTokens: "unmeasured", toolUses: [] });
  });

  test("a final error or aborted stop, or an aborted settle, marks the result as an error", () => {
    expect(parsePiStream(assistant({ input: 1, output: 1 }, "error")).resultIsError).toBe(true);
    expect(parsePiStream([assistant({ input: 1, output: 1 }), line({ type: "agent_settled", aborted: true })].join("\n")).resultIsError).toBe(true);
  });
});

describe("pi provider registration for the trial home", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "ko-pi-agent-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("copies only the model's provider, nothing else of the principal's models.json", () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(PRINCIPAL_MODELS));
    expect(JSON.parse(piProviderModels("spark/longctx-think", agentDir))).toEqual({ providers: { spark: PRINCIPAL_MODELS.providers.spark } });
  });

  test("an unregistered provider, or no models.json at all, is a usage error", () => {
    expect(() => piProviderModels("spark/longctx-think", agentDir)).toThrow(TrialUsageError);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { other: {} } }));
    expect(() => piProviderModels("spark/longctx-think", agentDir)).toThrow(TrialUsageError);
  });

  test("a missing pi binary refuses with a usage error", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(PRINCIPAL_MODELS));
    await expect(piRunner("/nonexistent/pi", () => agentDir).preflight?.(PINNED_PI_MODEL)).rejects.toBeInstanceOf(TrialUsageError);
  });
});

describe("end to end with a stub pi", () => {
  let root: string;
  let principal: string;
  let somaHome: string;
  let store: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ko-pi-")));
    principal = join(root, "principal");
    somaHome = join(principal, ".soma");
    store = storeRoot(somaHome);
    mkdirSync(join(store, "fixtures"), { recursive: true });
    mkdirSync(join(somaHome, "memory"), { recursive: true });
    writeFileSync(join(somaHome, "memory", "MEMORY.md"), "# principal memory\n");
    mkdirSync(join(principal, ".pi", "agent"), { recursive: true });
    writeFileSync(join(principal, ".pi", "agent", "models.json"), JSON.stringify(PRINCIPAL_MODELS));
    writeFileSync(join(principal, ".pi", "agent", "settings.json"), '{"defaultModel":"principal-model"}\n');
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

  /** A pi that answers --version and auth check like pi 1.4.0, and on a run logs what it saw and replays the recorded events. */
  function stubPi(): { bin: string; log: string } {
    const bin = join(root, "pi-stub");
    const log = join(root, "pi-stub.log");
    writeFileSync(bin, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi',
      'if [ "$1" = "auth" ]; then',
      '  if grep -q \'"spark"\' "$HOME/.pi/agent/models.json" 2>/dev/null; then echo \'{"status":"ready","provider":"spark","authType":"api_key"}\'; exit 0; fi',
      '  echo \'{"status":"invalid","provider":"spark","reason":"invalid_state"}\'; exit 2',
      "fi",
      `printf '%s\\n' "$@" > "${log}"`,
      `echo "HOME=$HOME" >> "${log}"`,
      `if [ -f "$HOME/.pi/agent/soma/context.md" ]; then echo "projected=yes" >> "${log}"; fi`,
      `if grep -q spark-secret "$HOME/.pi/agent/models.json"; then echo "provider=copied" >> "${log}"; fi`,
      `if grep -q other-secret "$HOME/.pi/agent/models.json"; then echo "other=leaked" >> "${log}"; fi`,
      `stat -f %Lp "$HOME/.pi/agent/models.json" 2>/dev/null >> "${log}" || stat -c %a "$HOME/.pi/agent/models.json" >> "${log}"`,
      "echo done > made.txt",
      `cat "${join(FIXTURES, "pi-print.jsonl")}"`,
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

  async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("PI_"));
    const env: Record<string, string | undefined> = { ...Object.fromEntries(inherited), HOME: principal, SOMA_HOME: somaHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-cache") };
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  }

  const trialArgs = (bin: string): string[] => [
    "trial", "--fixture", "tiny", "--arm", "e2e", "--home-source", somaHome, "--substrate", "pi", "--soma-home", somaHome, "--pi-bin", bin,
  ];
  const skipStore = (rel: string): boolean => rel.startsWith(join(".soma", "evals", "knowledge-orientation", "results")) || rel.startsWith(join(".soma", "evals", "knowledge-orientation", "cache"));

  test("projects into the trial HOME with only the pinned provider, records pi and its version, and leaves ~/.pi byte-unchanged", async () => {
    writeFixture(makeRepo());
    const { bin, log } = stubPi();
    const before = hashTree(principal, skipStore);

    const { code, stdout, stderr } = await runCli(trialArgs(bin));
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });

    const record = JSON.parse(readFileSync(stdout.trim().split(": ")[1] ?? "", "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      outcome: "completed",
      substrate: "pi-dev",
      cli: { name: "pi", version: "9.9.9" },
      model: "spark/longctx-think",
      probe_exit: 0,
      start_of_session_tokens: 11197,
      total_tokens: 46385,
    });
    const seen = readFileSync(log, "utf8").split("\n");
    expect(seen.slice(0, 9)).toEqual(["--print", "--mode", "json", "--no-session", "--provider", "spark", "--model", "longctx-think", "--"]);
    const home = seen.find((entry) => entry.startsWith("HOME="))?.slice("HOME=".length) ?? "";
    expect(home.startsWith(principal)).toBe(false);
    expect(home.endsWith("home")).toBe(true);
    expect(seen).toContain("projected=yes");
    expect(seen).toContain("provider=copied");
    expect(seen).not.toContain("other=leaked");
    expect(seen).toContain("600");
    expect(hashTree(principal, skipStore)).toEqual(before);
  }, 120_000);

  test("an unready provider or a missing pi refuses with a non-zero exit before anything is cloned", async () => {
    writeFixture(makeRepo());
    const { bin } = stubPi();
    writeFileSync(join(principal, ".pi", "agent", "models.json"), JSON.stringify({ providers: { other: PRINCIPAL_MODELS.providers.other } }));
    for (const [command, piBin] of [["trial", bin], ["batch", bin], ["trial", "/nonexistent/pi"]] as const) {
      const args = command === "trial" ? trialArgs(piBin) : ["batch", "--arms", "a", "--home-source", somaHome, "--substrate", "pi", "--soma-home", somaHome, "--pi-bin", piBin];
      const { code, stderr } = await runCli(args);
      expect(code).not.toBe(0);
      expect(stderr).toContain("pi");
    }
    expect(existsSync(join(store, "cache"))).toBe(false);
    expect(existsSync(join(store, "batches"))).toBe(false);
  });

  test("a provider the stub's auth check rejects refuses before cloning", async () => {
    writeFixture(makeRepo());
    const bin = join(root, "pi-unready");
    writeFileSync(bin, ['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi', 'echo \'{"status":"invalid","provider":"spark","reason":"invalid_state"}\'; exit 2', ""].join("\n"));
    chmodSync(bin, 0o755);
    const { code, stderr } = await runCli(trialArgs(bin));
    expect(code).toBe(2);
    expect(stderr).toContain("invalid_state");
    expect(existsSync(join(store, "cache"))).toBe(false);
  });
});
