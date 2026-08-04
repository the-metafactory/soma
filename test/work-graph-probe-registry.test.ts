import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicyArgs, runPolicyCli } from "../src/cli/policy";
import {
  authorizeProbe,
  loadProbeRegistry,
  parseProbeRegistry,
  probeRegistryPath,
  PROBE_REGISTRY_RELATIVE_PATH,
  type ProbeRegistry,
} from "../src/index";

const REPO = "the-metafactory/soma";
const PATH = "/home/.soma/policy/probe-registry.json";

function parse(raw: string, repo = REPO, homeDir?: string): ProbeRegistry {
  return parseProbeRegistry({ repo, path: PATH, raw, ...(homeDir === undefined ? {} : { homeDir }) });
}

function invalidReason(registry: ProbeRegistry): string {
  if (registry.status !== "invalid") throw new Error(`expected an invalid registry, got ${registry.status}`);
  return registry.reason;
}

function loaded(registry: ProbeRegistry): Extract<ProbeRegistry, { status: "loaded" }> {
  if (registry.status !== "loaded") throw new Error(`expected a loaded registry, got ${registry.status}`);
  return registry;
}

const GOOD = JSON.stringify({
  version: 1,
  repos: {
    "the-metafactory/soma": {
      commands: [{ run: "bun test", cwd: "/repo" }],
      urlHosts: ["status.example.test"],
    },
  },
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("a well-formed document yields the declarations for the requested repo only", () => {
  const raw = JSON.stringify({
    version: 1,
    repos: {
      "the-metafactory/soma": { commands: [{ run: "bun test", cwd: "/repo" }], urlHosts: ["a.example.test"] },
      "someone/else": { commands: [{ run: "rm -rf /", cwd: "/elsewhere" }], urlHosts: ["b.example.test"] },
    },
  });

  const mine = loaded(parse(raw));
  expect(mine.commands).toEqual([{ run: "bun test", cwd: "/repo" }]);
  expect(mine.urlHosts).toEqual(["a.example.test"]);

  const theirs = loaded(parse(raw, "someone/else"));
  expect(theirs.commands).toEqual([{ run: "rm -rf /", cwd: "/elsewhere" }]);
});

test("repository keys match case-insensitively, and a duplicate key is refused rather than resolved", () => {
  const mixedCase = loaded(parse(JSON.stringify({ version: 1, repos: { "The-MetaFactory/Soma": { commands: [{ run: "bun test", cwd: "/repo" }] } } })));
  expect(mixedCase.commands).toHaveLength(1);

  const duplicate = parse(
    JSON.stringify({
      version: 1,
      repos: { "the-metafactory/soma": { commands: [] }, "The-Metafactory/Soma": { commands: [{ run: "x", cwd: "/repo" }] } },
    }),
  );
  expect(invalidReason(duplicate)).toContain("more than once");
});

test("a repo with no entry loads empty rather than erroring — same refusal, different message", () => {
  const registry = loaded(parse(GOOD, "someone/unknown"));
  expect(registry.commands).toEqual([]);
  expect(registry.urlHosts).toEqual([]);

  const refusal = authorizeProbe({ type: "command", run: "bun test", timeoutSec: 60, expectExit: 0 }, "/repo", registry);
  expect(refusal.allowed).toBe(false);
  if (!refusal.allowed) expect(refusal.reason).toContain("0 command(s) declared");
});

test("the whole document is validated, not just the entry being asked for", () => {
  // A typo under someone else's key must not pass unnoticed: in an
  // authorisation list a silently-ignored key is what makes an adopter believe
  // something is declared when it is not.
  const registry = parse(
    JSON.stringify({
      version: 1,
      repos: {
        "the-metafactory/soma": { commands: [{ run: "bun test", cwd: "/repo" }] },
        "someone/else": { comands: [] },
      },
    }),
  );
  expect(invalidReason(registry)).toContain("comands");
});

test("malformed documents refuse with a reason that names the fix", () => {
  expect(invalidReason(parse("{"))).toContain("not valid JSON");
  expect(invalidReason(parse("[]"))).toContain("must be a JSON object");
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: {} })))).toContain(`must declare "version": 1`);
  expect(invalidReason(parse(JSON.stringify({ repos: {} })))).toContain(`must declare "version": 1`);
  expect(invalidReason(parse(JSON.stringify({ version: 1, repos: [] })))).toContain(`"repos" must be an object`);
  expect(invalidReason(parse(JSON.stringify({ version: 1, repos: {}, allow: true })))).toContain("unknown top-level key");
  expect(invalidReason(parse(JSON.stringify({ version: 1, repos: { "a/b": { commands: {} } } })))).toContain("must be an array");
  expect(invalidReason(parse(JSON.stringify({ version: 1, repos: { "a/b": { commands: [{ run: "x" }] } } })))).toContain("cwd must be a non-empty string");
  expect(invalidReason(parse(JSON.stringify({ version: 1, repos: { "a/b": { commands: [{ cwd: "/x" }] } } })))).toContain("run must be a non-empty string");
  expect(invalidReason(parse(JSON.stringify({ version: 1, repos: { "a/b": { commands: [{ run: "x", cwd: "/x", timeout: 5 }] } } })))).toContain("unknown key");
});

test("a relative declared cwd is refused — it would authorise a different directory per invocation", () => {
  const registry = parse(JSON.stringify({ version: 1, repos: { "a/b": { commands: [{ run: "bun test", cwd: "./repo" }] } } }));
  expect(invalidReason(registry)).toContain("must be an absolute path");
});

test("a declared cwd may use ~, and normalises to an absolute path", () => {
  const registry = loaded(
    parse(JSON.stringify({ version: 1, repos: { [REPO]: { commands: [{ run: "bun test", cwd: "~/work/soma/" }] } } }), REPO, "/home/jc"),
  );
  expect(registry.commands).toEqual([{ run: "bun test", cwd: "/home/jc/work/soma" }]);
});

test("declared hosts are bare hostnames — no scheme, port, path, or wildcard", () => {
  const host = (value: unknown): ProbeRegistry =>
    parse(JSON.stringify({ version: 1, repos: { "a/b": { urlHosts: [value] } } }));

  expect(invalidReason(host("https://example.test"))).toContain("bare hostname");
  expect(invalidReason(host("example.test:8080"))).toContain("bare hostname");
  expect(invalidReason(host("example.test/health"))).toContain("bare hostname");
  expect(invalidReason(host("user@example.test"))).toContain("bare hostname");
  expect(invalidReason(host("*.example.test"))).toContain(`may not contain "*"`);
  expect(invalidReason(host(""))).toContain("non-empty string");

  const ok = loaded(parse(JSON.stringify({ version: 1, repos: { [REPO]: { urlHosts: ["Example.Test", "[::1]"] } } })));
  expect(ok.urlHosts).toEqual(["example.test", "[::1]"]);
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

test("the three argv probe types stay ungated, with or without a registry", () => {
  const absent: ProbeRegistry = { status: "absent", repo: REPO, path: PATH };
  expect(authorizeProbe({ type: "git-ref-exists", ref: "main" }, "/repo", absent).allowed).toBe(true);
  expect(authorizeProbe({ type: "git-merged-into", ref: "x", into: "main" }, "/repo", undefined).allowed).toBe(true);
  expect(authorizeProbe({ type: "artifact-exists", path: "README.md" }, "/repo", undefined).allowed).toBe(true);
});

test("the command match is exact on run — an edited probe breaks it (DD-7 exact bytes)", () => {
  const registry = loaded(parse(GOOD));
  expect(authorizeProbe({ type: "command", run: "bun test", timeoutSec: 60, expectExit: 0 }, "/repo", registry).allowed).toBe(true);
  expect(authorizeProbe({ type: "command", run: "bun test ", timeoutSec: 60, expectExit: 0 }, "/repo", registry).allowed).toBe(false);
  expect(authorizeProbe({ type: "command", run: "bun  test", timeoutSec: 60, expectExit: 0 }, "/repo", registry).allowed).toBe(false);
  expect(authorizeProbe({ type: "command", run: "bun test; whoami", timeoutSec: 60, expectExit: 0 }, "/repo", registry).allowed).toBe(false);
});

test("an unparsable url target is refused before anything is fetched", () => {
  const registry = loaded(parse(GOOD));
  const result = authorizeProbe({ type: "url", target: "not a url", expectStatus: 200 }, "/repo", registry);
  expect(result.allowed).toBe(false);
  if (!result.allowed) expect(result.reason).toContain("not a parsable URL");
});

test("a refusal message bounds what a node author can echo into the receipt", () => {
  const registry = loaded(parse(GOOD));
  const result = authorizeProbe(
    { type: "command", run: "x".repeat(50_000), timeoutSec: 60, expectExit: 0 },
    "/repo",
    registry,
  );
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.reason.length).toBeLessThan(2_000);
    expect(result.reason).toContain("truncated");
  }
});

// ---------------------------------------------------------------------------
// Loading from soma-home
// ---------------------------------------------------------------------------

test("the registry is read from soma-home, never the repo it guards", async () => {
  const home = await mkdtemp(join(tmpdir(), "soma-probe-registry-"));
  const somaHome = join(home, ".soma");
  await mkdir(join(somaHome, "policy"), { recursive: true });

  expect(probeRegistryPath({ homeDir: home })).toBe(join(somaHome, PROBE_REGISTRY_RELATIVE_PATH));

  const absent = await loadProbeRegistry({ repo: REPO, homeDir: home });
  expect(absent.status).toBe("absent");

  await writeFile(join(somaHome, PROBE_REGISTRY_RELATIVE_PATH), GOOD, "utf8");
  const present = await loadProbeRegistry({ repo: REPO, homeDir: home });
  expect(loaded(present).commands).toEqual([{ run: "bun test", cwd: "/repo" }]);

  await writeFile(join(somaHome, PROBE_REGISTRY_RELATIVE_PATH), "{ broken", "utf8");
  expect(invalidReason(await loadProbeRegistry({ repo: REPO, homeDir: home }))).toContain("not valid JSON");
});

test("`soma policy probes` shows the adopter what is declared and where to edit it", async () => {
  const home = await mkdtemp(join(tmpdir(), "soma-probe-registry-cli-"));
  const document = join(home, ".soma", PROBE_REGISTRY_RELATIVE_PATH);
  await mkdir(join(home, ".soma", "policy"), { recursive: true });

  const show = async (): Promise<string> =>
    await runPolicyCli(parsePolicyArgs(["policy", "probes", "--repo", REPO, "--home-dir", home]));

  const absent = await show();
  expect(absent).toContain("status: absent");
  expect(absent).toContain(document);
  expect(absent).toContain("ungated");

  await writeFile(document, GOOD, "utf8");
  const listed = await show();
  expect(listed).toContain("status: loaded");
  expect(listed).toContain("`bun test` in /repo");
  expect(listed).toContain("status.example.test");
  // No verb widens the list: adding an entry is a loosening mutation (§4).
  expect(listed).toContain("edit the document yourself");

  await writeFile(document, "{ broken", "utf8");
  expect(await show()).toContain("status: invalid");
});

test("a read that throws becomes an invalid registry, never an exception", async () => {
  const registry = await loadProbeRegistry({
    repo: REPO,
    homeDir: "/home/jc",
    readFile: async () => {
      throw new Error("EACCES");
    },
  });
  expect(invalidReason(registry)).toContain("EACCES");
});
