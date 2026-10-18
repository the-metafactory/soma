import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type Fixture,
  type SubstrateRunner,
  type TrialDeps,
  type TrialOptions,
  composePrompt,
  duplicatesCreated,
  main,
  parseDiff,
  parseFixture,
  parseStream,
  probedAfterLastEdit,
  resolveInsideStore,
  runTrial,
  sourcesRead,
  storeRoot,
} from "../scripts/knowledge-eval-trial";

const STREAM_PATH = join(import.meta.dir, "fixtures", "knowledge-eval", "stream.jsonl");
const STREAM = readFileSync(STREAM_PATH, "utf8");
const SCRIPT = join(import.meta.dir, "..", "scripts", "knowledge-eval.ts");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(args, { cwd, env: GIT_ENV });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function makeRepo(root: string): { url: string; rev: string } {
  const url = join(root, "upstream");
  mkdirSync(join(url, "src"), { recursive: true });
  writeFileSync(join(url, "README.md"), "# Intro\n");
  writeFileSync(join(url, "src", "run-ledger.ts"), "export const ledger = 1;\n");
  sh(url, "git", "init", "-q", "-b", "main");
  sh(url, "git", "add", "-A");
  sh(url, "git", "commit", "-q", "-m", "init");
  return { url, rev: sh(url, "git", "rev-parse", "HEAD") };
}

function baseFixture(repo: { url: string; rev: string }, overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: "tiny-discover-reuse",
    domain: "soma",
    capability: "discover-reuse",
    condition: "correct",
    repo: repo.url,
    rev: repo.rev,
    prompt: "Add a queue sensor.",
    seed: [{ op: "add", path: "memory/procedural/note.md", content: "seeded\n" }],
    hints: ["h-one", "h-two", "h-three"],
    acceptance_probe: "test -f docs/dup.md",
    expected_sources: ["src/run-ledger.ts", "README.md#Intro", "soma:memory/procedural/note.md#Why"],
    forbidden_duplicates: ["docs/dup.md", "NATSTransport outside src/run-ledger.ts", "NeverWritten"],
    known_wrong: "second publish path",
    ...overrides,
  };
}

function hashTree(root: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (skip(rel)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return out;
}

let root: string;
let principal: string;
let somaHome: string;
let store: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ko-test-")));
  principal = join(root, "principal");
  somaHome = join(principal, ".soma");
  store = storeRoot(somaHome);
  mkdirSync(join(store, "fixtures"), { recursive: true });
  mkdirSync(join(store, "results"), { recursive: true });
  writeFileSync(join(store, "results", "sentinel.json"), "{}");
  mkdirSync(join(somaHome, "memory"), { recursive: true });
  writeFileSync(join(somaHome, "memory", "MEMORY.md"), "# principal memory\n");
  mkdirSync(join(principal, ".claude"), { recursive: true });
  writeFileSync(join(principal, ".claude", "settings.json"), "{}\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFixture(fixture: unknown, name = "tiny-discover-reuse"): string {
  const path = join(store, "fixtures", `${name}.json`);
  writeFileSync(path, JSON.stringify(fixture, null, 2));
  return path;
}

function options(overrides: Partial<TrialOptions> = {}): TrialOptions {
  return {
    fixture: "tiny-discover-reuse",
    arm: "baseline",
    homeSource: somaHome,
    substrate: "claude",
    hint: 0,
    model: "claude-sonnet-5-5",
    somaHome,
    timeoutMs: 20_000,
    probeTimeoutMs: 20_000,
    keep: false,
    ...overrides,
  };
}

function stubDeps(run: SubstrateRunner["run"], seen: { homes: string[] } = { homes: [] }): TrialDeps {
  return {
    runner: { name: "claude", version: () => Promise.resolve("9.9.9"), run },
    installProjection: ({ somaHome: trialSoma, homeDir }) => {
      seen.homes.push(trialSoma, homeDir);
      expect(existsSync(join(trialSoma, "memory", "procedural", "note.md"))).toBe(true);
      expect(existsSync(join(trialSoma, "evals"))).toBe(false);
      return Promise.resolve();
    },
  };
}

function writingRun(streamText: string, exitCode: number | null = 0, timedOut = false): SubstrateRunner["run"] {
  return (input) => {
    mkdirSync(join(input.cwd, "docs"), { recursive: true });
    writeFileSync(join(input.cwd, "docs", "dup.md"), "dup\n");
    writeFileSync(join(input.cwd, "other.ts"), "const t = new NATSTransport();\n");
    return Promise.resolve({ exitCode, stdout: streamText, stderr: exitCode === 0 ? "" : "boom", timedOut });
  };
}

describe("fixture schema", () => {
  const repo = { url: "/x", rev: "a".repeat(40) };

  test("an unknown key is refused and named", () => {
    expect(() => parseFixture({ ...baseFixture(repo), surprise: 1 }, "f.json")).toThrow(/unknown key "surprise"/);
  });

  test("a missing required key is refused and named", () => {
    const { known_wrong: _omitted, ...without } = baseFixture(repo);
    expect(() => parseFixture(without, "f.json")).toThrow(/known_wrong/);
  });

  test("hints must be exactly three", () => {
    expect(() => parseFixture({ ...baseFixture(repo), hints: ["a", "b"] }, "f.json")).toThrow(/hints/);
  });

  test("seed add needs content and remove forbids it", () => {
    expect(() => parseFixture({ ...baseFixture(repo), seed: [{ op: "add", path: "a" }] }, "f.json")).toThrow(/content/);
    expect(() => parseFixture({ ...baseFixture(repo), seed: [{ op: "remove", path: "a", content: "x" }] }, "f.json")).toThrow(/content/);
  });
});

describe("transcript analysis", () => {
  test("reads start tokens, total tokens, tool uses and model from stream-json", () => {
    const facts = parseStream(STREAM);
    expect(facts.model).toBe("claude-sonnet-5-5");
    expect(facts.startTokens).toBe(120 + 4000);
    expect(facts.totalTokens).toBe(160 + 4200 + 8200 + 360);
    expect(facts.toolUses.map((use) => use.name)).toEqual(["Read", "Write", "Bash"]);
  });

  test("stream-json without usage records unmeasured, never 0", () => {
    const bare = STREAM.split("\n")
      .filter(Boolean)
      .map((line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        delete event.usage;
        const message = event.message as Record<string, unknown> | undefined;
        if (message !== undefined) delete message.usage;
        return JSON.stringify(event);
      })
      .join("\n");
    const facts = parseStream(bare);
    expect(facts.startTokens).toBe("unmeasured");
    expect(facts.totalTokens).toBe("unmeasured");
  });

  test("a synthetic zero-usage message is not a measurement", () => {
    const synthetic = '{"type":"assistant","message":{"id":"s","model":"<synthetic>","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}';
    expect(parseStream(synthetic).startTokens).toBe("unmeasured");
  });

  test("falls back to per-message usage when the result event has none", () => {
    const withoutResult = STREAM.split("\n").filter((line) => line !== "" && !line.includes('"type":"result"')).join("\n");
    expect(parseStream(withoutResult).totalTokens).toBe(4160 + 4530 + 4230);
  });

  test("sources_read matches files and routes against Read, Grep and Bash calls", () => {
    const { toolUses } = parseStream(STREAM);
    expect(sourcesRead(["src/run-ledger.ts", "README.md#Intro", "soma:docs/x.md#H"], toolUses)).toEqual(["src/run-ledger.ts"]);
    const bash = [{ name: "Bash", input: { command: "cat docs/x.md" } }];
    expect(sourcesRead(["soma:docs/x.md#H"], bash)).toEqual(["soma:docs/x.md#H"]);
  });

  test("probed_after_last_edit needs a Bash call after the last edit", () => {
    const edit = { name: "Edit", input: {} };
    const bash = { name: "Bash", input: {} };
    expect(probedAfterLastEdit([edit, bash])).toBe(true);
    expect(probedAfterLastEdit([bash, edit])).toBe(false);
    expect(probedAfterLastEdit([bash])).toBe(false);
  });

  test("duplicates: new path, symbol, and symbol outside an owner", () => {
    const files = parseDiff(
      [
        "diff --git a/docs/dup.md b/docs/dup.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/docs/dup.md",
        "+dup",
        "diff --git a/src/run-ledger.ts b/src/run-ledger.ts",
        "--- a/src/run-ledger.ts",
        "+++ b/src/run-ledger.ts",
        "+new NATSTransport()",
        "diff --git a/other.ts b/other.ts",
        "--- a/other.ts",
        "+++ b/other.ts",
        "+createOutbox()",
      ].join("\n"),
    );
    expect(duplicatesCreated(["docs/dup.md", "createOutbox", "NATSTransport outside src/run-ledger.ts", "createOutbox outside other.ts", "Absent"], files)).toEqual([
      "docs/dup.md",
      "createOutbox",
    ]);
  });

  test("the prompt carries the recovery packet and hints H1..Hk", () => {
    const fixture = baseFixture({ url: "/x", rev: "a".repeat(40) }, { recovery_packet: "last time we stopped at X" });
    expect(composePrompt(fixture, 0)).toBe("<prior_context>\nlast time we stopped at X\n</prior_context>\n\nAdd a queue sensor.");
    expect(composePrompt(fixture, 2)).toEndWith("Hint 1: h-one\nHint 2: h-two");
  });
});

describe("store boundary", () => {
  test("paths outside the store are refused, symlinks included", () => {
    expect(() => resolveInsideStore(join(root, "elsewhere", "f.json"), store, "fixture path")).toThrow(/outside/);
    symlinkSync(root, join(store, "fixtures", "escape"));
    expect(() => resolveInsideStore(join(store, "fixtures", "escape", "f.json"), store, "fixture path")).toThrow(/outside/);
    expect(resolveInsideStore(join(store, "results"), store, "output path")).toBe(join(store, "results"));
  });

  test("a store inside the soma checkout is refused", () => {
    const inRepo = join(import.meta.dir, "..", "evals", "knowledge-orientation");
    expect(() => resolveInsideStore(inRepo, inRepo, "output path")).toThrow(/soma checkout/);
  });

  test("a fixture path outside the store fails before any clone", async () => {
    const repo = makeRepo(root);
    const stray = join(root, "stray.json");
    writeFileSync(stray, JSON.stringify(baseFixture(repo)));
    await expect(runTrial(options({ fixture: stray }), stubDeps(writingRun(STREAM)))).rejects.toThrow(/outside/);
    expect(existsSync(join(store, "cache"))).toBe(false);
  });

  test("an output path outside the store writes nothing", async () => {
    const repo = makeRepo(root);
    writeFixture(baseFixture(repo));
    const out = join(root, "repo-path", "results");
    await expect(runTrial(options({ out }), stubDeps(writingRun(STREAM)))).rejects.toThrow(/outside/);
    expect(existsSync(join(root, "repo-path"))).toBe(false);
    expect(existsSync(join(store, "cache"))).toBe(false);
  });

  test("an invalid fixture fails before cloning and names the key", async () => {
    const repo = makeRepo(root);
    writeFixture({ ...baseFixture(repo), surprise: true });
    await expect(runTrial(options(), stubDeps(writingRun(STREAM)))).rejects.toThrow(/surprise/);
    expect(existsSync(join(store, "cache"))).toBe(false);
  });
});

describe("trial function with the substrate stubbed", () => {
  test("writes one record with every field", async () => {
    const repo = makeRepo(root);
    writeFixture(baseFixture(repo));
    const seen = { homes: [] as string[] };
    const { record, recordPath } = await runTrial(options({ hint: 2 }), stubDeps(writingRun(STREAM), seen));

    expect(recordPath.startsWith(join(store, "results"))).toBe(true);
    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(record);
    expect(Object.keys(record).sort()).toEqual(
      [
        "arm", "cli", "duplicates_created", "error", "fixture_id", "fixture_sha", "hint_level", "model", "outcome",
        "probe_exit", "probed_after_last_edit", "soma_sha", "sources_read", "start_of_session_tokens", "started_at",
        "substrate", "substrate_exit", "timed_out", "total_tokens", "transcript_path", "wall_time_ms",
      ].sort(),
    );
    expect(record).toMatchObject({
      fixture_id: "tiny-discover-reuse",
      arm: "baseline",
      substrate: "claude",
      cli: { name: "claude", version: "9.9.9" },
      model: "claude-sonnet-5-5",
      hint_level: 2,
      outcome: "completed",
      probe_exit: 0,
      start_of_session_tokens: 4120,
      total_tokens: 12920,
      sources_read: ["src/run-ledger.ts"],
      duplicates_created: ["docs/dup.md", "NATSTransport outside src/run-ledger.ts"],
      probed_after_last_edit: true,
    });
    expect(record.soma_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(record.fixture_sha).toBe(createHash("sha256").update(readFileSync(join(store, "fixtures", "tiny-discover-reuse.json"))).digest("hex"));
    expect(readFileSync(record.transcript_path, "utf8")).toBe(STREAM);
    for (const dir of seen.homes) expect(existsSync(dir)).toBe(false);
  });

  test("a non-zero substrate exit still writes an errored record and runs the probe", async () => {
    const repo = makeRepo(root);
    writeFixture(baseFixture(repo));
    const { record } = await runTrial(options(), stubDeps(writingRun("", 1)));
    expect(record).toMatchObject({ outcome: "errored", substrate_exit: 1, probe_exit: 0, start_of_session_tokens: "unmeasured", total_tokens: "unmeasured" });
    expect(record.error).toBe("boom");
  });

  test("a timeout still writes an errored record and runs the probe", async () => {
    const repo = makeRepo(root);
    writeFixture(baseFixture(repo, { acceptance_probe: "exit 3" }));
    const { record } = await runTrial(options(), stubDeps(writingRun(STREAM, null, true)));
    expect(record).toMatchObject({ outcome: "errored", timed_out: true, substrate_exit: null, probe_exit: 3 });
  });

  test("a result event flagged is_error is an errored trial", async () => {
    const repo = makeRepo(root);
    writeFixture(baseFixture(repo));
    const failed = STREAM.replace('"is_error":false', '"is_error":true');
    const { record } = await runTrial(options(), stubDeps(writingRun(failed)));
    expect(record.outcome).toBe("errored");
  });

  test("the substrate gets the hinted prompt, the worktree at rev, and the isolated environment", async () => {
    const repo = makeRepo(root);
    writeFixture(baseFixture(repo));
    let captured: Parameters<SubstrateRunner["run"]>[0] | undefined;
    let readme = "";
    await runTrial(options({ hint: 1 }), stubDeps((input) => {
      captured = input;
      readme = readFileSync(join(input.cwd, "README.md"), "utf8");
      return Promise.resolve({ exitCode: 0, stdout: STREAM, stderr: "", timedOut: false });
    }));
    expect(captured?.prompt).toBe("Add a queue sensor.\n\nHint 1: h-one");
    expect(readme).toBe("# Intro\n");
    expect(captured?.env.HOME?.startsWith(somaHome)).toBe(false);
    expect(captured?.env.SOMA_HOME?.startsWith(principal)).toBe(false);
    expect(captured?.env.CLAUDE_CONFIG_DIR?.startsWith(principal)).toBe(false);
  });
});

describe("end to end against a local git repo", () => {
  function stubClaude(): string {
    const bin = join(root, "claude-stub");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi',
        "cat >/dev/null",
        "mkdir -p docs && echo dup > docs/dup.md",
        "echo 'const t = new NATSTransport();' > other.ts",
        `cat "${STREAM_PATH}"`,
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  test("runs through the CLI with the real projection and leaves the principal's homes byte-unchanged", async () => {
    const repo = makeRepo(root);
    writeFixture(baseFixture(repo));
    const skipResults = (rel: string): boolean => rel.startsWith(join(".soma", "evals", "knowledge-orientation", "results")) || rel.startsWith(join(".soma", "evals", "knowledge-orientation", "cache"));
    const before = hashTree(principal, skipResults);

    const proc = Bun.spawn(
      [
        process.execPath, SCRIPT, "trial", "--fixture", "tiny-discover-reuse", "--arm", "e2e", "--home-source", somaHome,
        "--substrate", "claude", "--hint", "1", "--soma-home", somaHome, "--claude-bin", stubClaude(),
      ],
      { env: { ...process.env, HOME: principal, SOMA_HOME: somaHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-cache") }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });

    const recordPath = stdout.trim().split(": ")[1] ?? "";
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      outcome: "completed",
      cli: { name: "claude", version: "9.9.9" },
      hint_level: 1,
      probe_exit: 0,
      sources_read: ["src/run-ledger.ts"],
      duplicates_created: ["docs/dup.md", "NATSTransport outside src/run-ledger.ts"],
      total_tokens: 12920,
    });
    expect(hashTree(principal, skipResults)).toEqual(before);
    expect(readdirSync(join(store, "results")).filter((name) => name.endsWith(".json")).length).toBe(2);
  }, 120_000);

  test("a fixture with an unknown key exits non-zero before cloning and names the key", async () => {
    const repo = makeRepo(root);
    writeFixture({ ...baseFixture(repo), surprise: true });
    const proc = Bun.spawn(
      [process.execPath, SCRIPT, "trial", "--fixture", "tiny-discover-reuse", "--arm", "e2e", "--home-source", somaHome, "--substrate", "claude", "--soma-home", somaHome],
      { env: { ...process.env, HOME: principal }, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("surprise");
    expect(existsSync(join(store, "cache"))).toBe(false);
  });

  test("main refuses an output path outside the store with a non-zero exit", async () => {
    const repo = makeRepo(root);
    writeFixture(baseFixture(repo));
    const out = join(root, "repo-path");
    const code = await main(["trial", "--fixture", "tiny-discover-reuse", "--arm", "e2e", "--home-source", somaHome, "--substrate", "claude", "--soma-home", somaHome, "--out", out]);
    expect(code).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});
