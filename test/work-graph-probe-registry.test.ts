import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicyArgs, runPolicyCli } from "../src/cli/policy";
import { authorizeProbe, loadProbeRegistry, parseProbeRegistry, probeRegistryPath, PROBE_REGISTRY_RELATIVE_PATH, type DeclaredCommand, type ProbeRegistry } from "../src/graph/index";

const REPO = "github.com/the-metafactory/soma";
const GITLAB_REPO = "gitlab-int.switch.ch/the-metafactory/soma";
const POLICY_REPO = `github:${REPO}`;
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
  version: 2,
  repos: {
    [REPO]: {
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
    version: 2,
    repos: {
      [REPO]: { commands: [{ run: "bun test", cwd: "/repo" }], urlHosts: ["a.example.test"] },
      "github.com/someone/else": { commands: [{ run: "rm -rf /", cwd: "/elsewhere" }], urlHosts: ["b.example.test"] },
    },
  });

  const mine = loaded(parse(raw));
  expect(mine.commands).toEqual([{ run: "bun test", cwd: "/repo" }]);
  expect(mine.urlHosts).toEqual(["a.example.test"]);

  const theirs = loaded(parse(raw, "github.com/someone/else"));
  expect(theirs.commands).toEqual([{ run: "rm -rf /", cwd: "/elsewhere" }]);
});

test("repository keys match case-insensitively, and a duplicate key is refused rather than resolved", () => {
  const mixedCase = loaded(parse(JSON.stringify({ version: 2, repos: { "GitHub.Com/The-MetaFactory/Soma": { commands: [{ run: "bun test", cwd: "/repo" }] } } })));
  expect(mixedCase.commands).toHaveLength(1);

  const duplicate = parse(
    JSON.stringify({
      version: 2,
      repos: { [REPO]: { commands: [] }, "GitHub.Com/The-Metafactory/Soma": { commands: [{ run: "x", cwd: "/repo" }] } },
    }),
  );
  expect(invalidReason(duplicate)).toContain("more than once");
});

test("a repo with no entry loads empty rather than erroring — same refusal, different message", () => {
  const registry = loaded(parse(GOOD, "github.com/someone/unknown"));
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
      version: 2,
      repos: {
        [REPO]: { commands: [{ run: "bun test", cwd: "/repo" }] },
        "github.com/someone/else": { comands: [] },
      },
    }),
  );
  expect(invalidReason(registry)).toContain("comands");
});

test("malformed documents refuse with a reason that names the fix", () => {
  expect(invalidReason(parse("{"))).toContain("not valid JSON");
  expect(invalidReason(parse("[]"))).toContain("must be a JSON object");
  expect(invalidReason(parse(JSON.stringify({ version: 3, repos: {} })))).toContain(`must declare "version": 2`);
  expect(invalidReason(parse(JSON.stringify({ repos: {} })))).toContain(`must declare "version": 2`);
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: [] })))).toContain(`"repos" must be an object`);
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: {}, allow: true })))).toContain("unknown top-level key");
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: { "github.com/a/b": { commands: {} } } })))).toContain("must be an array");
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: { "github.com/a/b": { commands: [{ run: "x" }] } } })))).toContain("cwd must be a non-empty string");
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: { "github.com/a/b": { commands: [{ cwd: "/x" }] } } })))).toContain("run must be a non-empty string");
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: { "github.com/a/b": { commands: [{ run: "x", cwd: "/x", timeout: 5 }] } } })))).toContain("unknown key");
});

test("v1 and malformed v2 keys refuse with explicit migration guidance", () => {
  expect(invalidReason(parse(JSON.stringify({ version: 1, repos: { "the-metafactory/soma": {} } })))).toContain('prefix every key with "github.com/"');
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: { "the-metafactory": {} } })))).toContain("host-qualified");
});

test("the requested repository must be host-qualified after the document parses", () => {
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: {} }), "the-metafactory/soma")))
    .toContain('requested repository "the-metafactory/soma" is not a host-qualified key');
  expect(invalidReason(parse("{", "the-metafactory/soma"))).toContain("not valid JSON");
});

test("registry keys use the ref grammar and require a dotted host to disambiguate legacy keys", () => {
  for (const key of ["github.com:8443/owner/repo", "you@github.com/owner/repo"]) {
    expect(invalidReason(parse(JSON.stringify({ version: 2, repos: { [key]: {} } })))).toContain("host-qualified");
  }
  expect(invalidReason(parse(JSON.stringify({ version: 2, repos: { "gitlab/csoc/reporter": {} } })))).toContain("host-qualified");
});

test("same-path GitHub and GitLab entries remain distinct", () => {
  const raw = JSON.stringify({
    version: 2,
    repos: {
      [REPO]: { commands: [{ run: "bun test", cwd: "/github" }] },
      [GITLAB_REPO]: { commands: [{ run: "bun test", cwd: "/gitlab" }] },
    },
  });

  expect(loaded(parse(raw, REPO)).commands).toEqual([{ run: "bun test", cwd: "/github" }]);
  expect(loaded(parse(raw, GITLAB_REPO)).commands).toEqual([{ run: "bun test", cwd: "/gitlab" }]);
});

test("a relative declared cwd is refused — it would authorise a different directory per invocation", () => {
  const registry = parse(JSON.stringify({ version: 2, repos: { "github.com/a/b": { commands: [{ run: "bun test", cwd: "./repo" }] } } }));
  expect(invalidReason(registry)).toContain("must be an absolute path");
});

test("a declared cwd may use ~, and normalises to an absolute path", () => {
  const registry = loaded(
    parse(JSON.stringify({ version: 2, repos: { [REPO]: { commands: [{ run: "bun test", cwd: "~/work/soma/" }] } } }), REPO, "/home/jc"),
  );
  expect(registry.commands).toEqual([{ run: "bun test", cwd: "/home/jc/work/soma" }]);
});

test("declared hosts are bare hostnames — no scheme, port, path, or wildcard", () => {
  const host = (value: unknown): ProbeRegistry =>
    parse(JSON.stringify({ version: 2, repos: { "github.com/a/b": { urlHosts: [value] } } }));

  expect(invalidReason(host("https://example.test"))).toContain("bare hostname");
  expect(invalidReason(host("example.test:8080"))).toContain("bare hostname");
  expect(invalidReason(host("example.test/health"))).toContain("bare hostname");
  expect(invalidReason(host("user@example.test"))).toContain("bare hostname");
  expect(invalidReason(host("*.example.test"))).toContain(`may not contain "*"`);
  expect(invalidReason(host(""))).toContain("non-empty string");

  const ok = loaded(parse(JSON.stringify({ version: 2, repos: { [REPO]: { urlHosts: ["Example.Test", "[::1]"] } } })));
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

test("a declared test-file prefix accepts one repository test path", () => {
  const registry = loaded(parse(JSON.stringify({
    version: 2,
    repos: { [REPO]: { commands: [{ prefix: "bun run test", cwd: "/repo", arg: "test-file" }] } },
  })));
  expect(authorizeProbe({ type: "command", run: "bun run test test/busy-retry-park.test.ts", timeoutSec: 60, expectExit: 0 }, "/repo", registry).allowed).toBe(true);
});

test("test-file prefixes deny unsafe paths, extra arguments and shell syntax", () => {
  const registry = loaded(parse(JSON.stringify({
    version: 2,
    repos: { [REPO]: { commands: [{ prefix: "bun run test", cwd: "/repo", arg: "test-file" }] } },
  })));
  const permits = (run: string, cwd = "/repo", declarations: ProbeRegistry | undefined = registry): boolean =>
    authorizeProbe({ type: "command", run, timeoutSec: 60, expectExit: 0 }, cwd, declarations).allowed;

  for (const path of ["a.test.ts", "test/nested/Test_1-v2.unit.test.ts", "test/--literal.test.ts"]) {
    expect(permits(`bun run test ${path}`)).toBe(true);
  }
  for (const argument of [
    "../outside.test.ts", "test/../outside.test.ts", "./a.test.ts", "test/.hidden/a.test.ts", ".a.test.ts",
    "/test/a.test.ts", "C:\\test\\a.test.ts", "test//a.test.ts", "test/a.ts", "test/a.test.ts/",
    "test/a.test.ts test/b.test.ts", "test/a.test.ts;whoami", "test/a.test.ts && whoami",
    "test/a.test.ts|whoami", "test/$(whoami).test.ts", "$( cat test/a.test.ts )", "test/`whoami`.test.ts",
    "test/$HOME.test.ts", "'test/a.test.ts'", '"test/a.test.ts"', "test/a b.test.ts", "test/*.test.ts",
    "test/a\tb.test.ts", "test/a.test.ts\n", "test\n/a.test.ts", "test/a.test.ts\u0000",
  ]) {
    expect(permits(`bun run test ${argument}`)).toBe(false);
  }
  for (const run of ["bun run test", "bun run test ", "bun run test  test/a.test.ts", "bun  run test test/a.test.ts", "bun run tests test/a.test.ts"]) {
    expect(permits(run)).toBe(false);
  }
  expect(permits("bun run test test/a.test.ts", "/other")).toBe(false);
  expect(permits("bun run test test/a.test.ts", "/repo", parse(GOOD))).toBe(false);
  expect(permits("bun run test test/a.test.ts", "/repo", parse(GOOD, "github.com/other/repo"))).toBe(false);
  expect(authorizeProbe({ type: "command", run: "bun run test test/a.test.ts", timeoutSec: 60, expectExit: 0 }, "/repo", undefined).allowed).toBe(false);
});

test("prefix declarations require test-file, an absolute cwd and no exact-run fields", () => {
  const declaration = (command: unknown): ProbeRegistry => parse(JSON.stringify({
    version: 2, repos: { [REPO]: { commands: [command] } },
  }));
  const prefix = { prefix: "bun run test", cwd: "/repo", arg: "test-file" } satisfies DeclaredCommand;
  for (const command of [
    { ...prefix, arg: "anything" }, { prefix: prefix.prefix, cwd: prefix.cwd },
    { ...prefix, prefix: "" }, { ...prefix, prefix: 5 }, { ...prefix, cwd: "./repo" },
    { ...prefix, run: "bun run test" }, { ...prefix, args: "test-file" },
    { run: "bun run test", cwd: "/repo", arg: "test-file" },
  ]) {
    expect(declaration(command).status).toBe("invalid");
  }
  const registry = loaded(parse(JSON.stringify({
    version: 2, repos: { [REPO]: { commands: [{ ...prefix, cwd: "~/repo/" }, { run: "bun run typecheck", cwd: "/repo" }] } },
  }), REPO, "/home/jc"));
  expect(registry.commands[0]).toEqual({ ...prefix, cwd: "/home/jc/repo" });
  expect(authorizeProbe({ type: "command", run: "bun run typecheck", timeoutSec: 60, expectExit: 0 }, "/repo", registry).allowed).toBe(true);
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
    await runPolicyCli(parsePolicyArgs(["policy", "probes", "--repo", POLICY_REPO, "--home-dir", home]));

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

  await writeFile(document, JSON.stringify({
    version: 2, repos: { [REPO]: { commands: [{ prefix: "bun run test", cwd: "/repo", arg: "test-file" }] } },
  }), "utf8");
  expect(await show()).toContain("`bun run test <test-file>` in /repo");

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
