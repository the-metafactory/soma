import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { WorkGraphError } from "../src/work-graph";
import {
  classifyHost,
  createGraphStore,
  originRemoteRequest,
  probeRegistryKey,
  readNodeForBridge,
  resolveGraphRepo,
  resolveNodeTarget,
  type FetchLike,
  type RepoResolutionDeps,
} from "../src/work-graph-bridge";
import type { Forge, RepoRef } from "../src/work-graph-ref";

const SOMA: RepoRef = { forge: "github", host: "github.com", path: "the-metafactory/soma" };

// --- host classification (#535 D6) -----------------------------------------------

function fakeFetch(answer: { status: number; headers?: Record<string, string>; body?: string } | Error): {
  fetch: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    if (answer instanceof Error) throw answer;
    const headers = new Map(Object.entries(answer.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    return {
      status: answer.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => answer.body ?? "",
    };
  };
  return { fetch, urls };
}

test("github.com is GitHub without a network call", async () => {
  const { fetch, urls } = fakeFetch(new Error("must not be called"));
  expect(await classifyHost("github.com", fetch)).toBe("github");
  expect(urls).toEqual([]);
});

test("an anonymous 401 carrying X-Gitlab-Meta is GitLab — how gitlab-int answers", async () => {
  const { fetch, urls } = fakeFetch({ status: 401, headers: { "X-Gitlab-Meta": '{"version":"1"}' } });
  expect(await classifyHost("gitlab-int.switch.ch", fetch)).toBe("gitlab");
  expect(urls).toEqual(["https://gitlab-int.switch.ch/api/v4/version"]);
});

test("an authenticated 200 with a version is GitLab", async () => {
  const { fetch } = fakeFetch({ status: 200, body: '{"version":"19.2.0-ee","revision":"abc"}' });
  expect(await classifyHost("gitlab.example.com", fetch)).toBe("gitlab");
});

test("anything that is not GitLab speaking is unclassified, never GitHub Enterprise", async () => {
  for (const answer of [
    { status: 404 },
    { status: 401 },
    { status: 200, body: "<html>welcome</html>" },
    { status: 200, body: '{"current_user_url":"https://ghe.example.com/api/v3/user"}' },
    new Error("ECONNREFUSED"),
  ]) {
    expect(await classifyHost("ghe.example.com", fakeFetch(answer).fetch)).toBeUndefined();
  }
});

// --- repo resolution (#535 D4, #536 D4) -----------------------------------------

function resolution(
  overrides: Partial<{ env: Record<string, string>; remote: string | undefined; forges: Record<string, Forge> }> = {},
): { deps: RepoResolutionDeps; probed: string[] } {
  const probed: string[] = [];
  const forges = overrides.forges ?? { "github.com": "github", "gitlab-int.switch.ch": "gitlab" };
  return {
    probed,
    deps: {
      env: overrides.env ?? {},
      originRemote: async () => ("remote" in overrides ? overrides.remote : "git@github.com:the-metafactory/soma.git"),
      classifyHost: async (host) => {
        probed.push(host);
        return forges[host];
      },
    },
  };
}

test("a qualified --repo is taken as written, with no remote read and no host probe", async () => {
  const { deps, probed } = resolution({ remote: undefined });
  expect(await resolveGraphRepo("gitlab:gitlab-int.switch.ch/csoc/soc-reporter", deps)).toEqual({
    forge: "gitlab",
    host: "gitlab-int.switch.ch",
    path: "csoc/soc-reporter",
  });
  expect(probed).toEqual([]);
});

test("--repo beats SOMA_GRAPH_REPO, which beats the origin remote", async () => {
  const { deps } = resolution({ env: { SOMA_GRAPH_REPO: "github:github.com/the-metafactory/arc" } });
  expect((await resolveGraphRepo("github:github.com/the-metafactory/pilot", deps)).path).toBe("the-metafactory/pilot");
  expect((await resolveGraphRepo(undefined, deps)).path).toBe("the-metafactory/arc");
  expect(await resolveGraphRepo(undefined, resolution().deps)).toEqual(SOMA);
});

test("a bare owner/name is qualified through the origin remote's host, never looked up host-less", async () => {
  const github = resolution();
  expect(await resolveGraphRepo("the-metafactory/arc", github.deps)).toEqual({ ...SOMA, path: "the-metafactory/arc" });

  const gitlab = resolution({ remote: "git@gitlab-int.switch.ch:csoc/soc-reporter.git" });
  expect(await resolveGraphRepo("csoc/other", gitlab.deps)).toEqual({
    forge: "gitlab",
    host: "gitlab-int.switch.ch",
    path: "csoc/other",
  });
  expect(gitlab.probed).toEqual(["gitlab-int.switch.ch"]);
});

test("a bare repo with no origin remote refuses and names the qualified form", async () => {
  const { deps } = resolution({ remote: undefined });
  const error = await resolveGraphRepo("the-metafactory/soma", deps).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WorkGraphError);
  expect(String(error)).toContain("names no forge or host");
  expect(String(error)).toContain("github:github.com/owner/name");
});

test("no --repo, no env and no remote refuses", async () => {
  expect(resolveGraphRepo(undefined, resolution({ remote: undefined }).deps)).rejects.toThrow(
    /Cannot tell which repository/,
  );
  expect(resolveGraphRepo(undefined, resolution({ remote: "/srv/git/soma.git" }).deps)).rejects.toThrow(
    /Cannot tell which repository/,
  );
});

test("a host that is neither github.com nor GitLab refuses and names the GitLab spelling (#536 D4)", async () => {
  const { deps } = resolution({ remote: "git@ghe.example.com:acme/widgets.git" });
  const error = String(await resolveGraphRepo(undefined, deps).catch((caught: unknown) => caught));
  expect(error).toContain("never assumes GitHub Enterprise");
  expect(error).toContain("--repo gitlab:ghe.example.com/acme/widgets");
  expect(error).not.toContain("--repo github:");
});

test("a GitLab remote's nested path survives resolution", async () => {
  const { deps } = resolution({ remote: "https://gitlab-int.switch.ch/csoc/team/soc-reporter.git" });
  expect((await resolveGraphRepo(undefined, deps)).path).toBe("csoc/team/soc-reporter");
});

// --- store selection (#535 D1) ------------------------------------------------------

test("the ref's forge picks the store; a GitLab ref refuses until the backend exists", () => {
  expect(createGraphStore(SOMA).attestation).toBe("verifiable");
  expect(() => createGraphStore({ forge: "gitlab", host: "gitlab-int.switch.ch", path: "csoc/soc-reporter" })).toThrow(
    /no GitLab work-graph backend/,
  );
});

test("the v2 probe registry key keeps same-path repos on different hosts separate", () => {
  expect(probeRegistryKey(SOMA)).toBe("github.com/the-metafactory/soma");
  expect(probeRegistryKey({ forge: "gitlab", host: "gitlab-int.switch.ch", path: "the-metafactory/soma" })).toBe(
    "gitlab-int.switch.ch/the-metafactory/soma",
  );
  expect(() => probeRegistryKey({ ...SOMA, host: "ghe.example.com" })).toThrow(/github.com only/);
  expect(() => probeRegistryKey({ forge: "gitlab", host: "github.com", path: "the-metafactory/soma" })).toThrow(/not a GitLab/);
  expect(() => probeRegistryKey({ forge: "gitlab", host: "gitlab", path: "csoc/reporter" })).toThrow(/dotted forge hostname/);
});

test("the X-Gitlab-Meta header counts only on GitLab's own two answers, never on a redirect or an error", async () => {
  for (const status of [302, 404, 500, 503]) {
    expect(await classifyHost("proxy.example.com", fakeFetch({ status, headers: { "X-Gitlab-Meta": "{}" } }).fetch)).toBeUndefined();
  }
});

// --- the invocation tree picks the remote (#535 D4) -------------------------

test("the origin remote is read in the invocation tree, not the process's", () => {
  const request = originRemoteRequest({ ARC_INVOCATION_CWD: tmpdir() });
  expect(request.argv).toEqual(["git", "remote", "get-url", "origin"]);
  expect(request.cwd).toBe(resolve(tmpdir()));
  expect(request.cwd).not.toBe(resolve(process.cwd()));
});

// --- one resolution for verbs and the bridge ----------------------------------

const noRemote = async (): Promise<RepoRef> => {
  throw new Error("a qualified target must not fall back to repo resolution");
};

test("a qualified target opens its own store and yields the store's id", async () => {
  expect(await resolveNodeTarget("github:github.com/the-metafactory/arc#498", undefined, noRemote)).toEqual({
    repo: { ...SOMA, path: "the-metafactory/arc" },
    id: "498",
    canonical: "github:github.com/the-metafactory/arc#498",
  });
  expect(await resolveNodeTarget("gitlab:gitlab-int.switch.ch/csoc/soc-reporter#12", undefined, noRemote)).toEqual({
    repo: { forge: "gitlab", host: "gitlab-int.switch.ch", path: "csoc/soc-reporter" },
    id: "csoc/soc-reporter#12",
    canonical: "gitlab:gitlab-int.switch.ch/csoc/soc-reporter#12",
  });
});

test("a bare --repo beside a qualified target takes the target's forge and host, not the origin remote", async () => {
  expect(await resolveNodeTarget("github:github.com/the-metafactory/soma#1", "the-metafactory/soma", noRemote)).toEqual({
    repo: SOMA,
    id: "1",
    canonical: "github:github.com/the-metafactory/soma#1",
  });
  expect(resolveNodeTarget("github:github.com/the-metafactory/soma#1", "the-metafactory/arc", noRemote)).rejects.toThrow(
    /never spans two stores/,
  );
  expect(
    resolveNodeTarget("github:github.com/the-metafactory/soma#1", "gitlab:gitlab-int.switch.ch/the-metafactory/soma", noRemote),
  ).rejects.toThrow(/never spans two stores/);
});

test("a bare target still resolves the repo through the caller's resolver", async () => {
  const seen: (string | undefined)[] = [];
  const result = await resolveNodeTarget("501", "the-metafactory/soma", async (explicit) => {
    seen.push(explicit);
    return SOMA;
  });
  expect(result).toEqual({ repo: SOMA, id: "501", canonical: "github:github.com/the-metafactory/soma#501" });
  expect(seen).toEqual(["the-metafactory/soma"]);
});

test("the bridge reader resolves a qualified step node the way the verbs do", async () => {
  const opened: RepoRef[] = [];
  const read: string[] = [];
  const report = await readNodeForBridge("github:github.com/the-metafactory/arc#498", {
    resolveRepo: noRemote,
    createStore: (repo) => {
      opened.push(repo);
      return {
        readNode: async (ref: { id: string }) => {
          read.push(ref.id);
          throw new WorkGraphError("backend", "stop after the read");
        },
      } as unknown as ReturnType<typeof createGraphStore>;
    },
  }).catch((error: unknown) => error);

  expect(opened).toEqual([{ ...SOMA, path: "the-metafactory/arc" }]);
  expect(read).toEqual(["498"]);
  expect(String(report)).toContain("stop after the read");
});

// --- round 3: untrusted hosts, GitLab id shape ---------------------------------

test("a GitHub ref on any host but github.com refuses before gh runs — the enterprise token never leaves", () => {
  for (const host of ["ghe.example.com", "attacker.example"]) {
    expect(() => createGraphStore({ ...SOMA, host })).toThrow(/github.com only/);
  }
});

test("on a GitLab store a bare id carries the repo's project, matching the qualified form's id", async () => {
  const reporter: RepoRef = { forge: "gitlab", host: "gitlab-int.switch.ch", path: "csoc/soc-reporter" };
  const resolve = async (): Promise<RepoRef> => reporter;
  expect((await resolveNodeTarget("12", undefined, resolve)).id).toBe("csoc/soc-reporter#12");
  expect((await resolveNodeTarget("#12", undefined, resolve)).id).toBe("csoc/soc-reporter#12");
  expect((await resolveNodeTarget("gitlab:gitlab-int.switch.ch/csoc/soc-reporter#12", undefined, noRemote)).id).toBe(
    "csoc/soc-reporter#12",
  );
  // GitHub ids stay bare, exactly as before.
  expect((await resolveNodeTarget("12", undefined, async () => SOMA)).id).toBe("12");
});

test("GitLab ids come back as canonical refs — issue, bare, and epic alike", async () => {
  const reporter: RepoRef = { forge: "gitlab", host: "gitlab-int.switch.ch", path: "csoc/soc-reporter" };
  const resolve = async (): Promise<RepoRef> => reporter;
  expect((await resolveNodeTarget("12", undefined, resolve)).canonical).toBe("gitlab:gitlab-int.switch.ch/csoc/soc-reporter#12");
  expect((await resolveNodeTarget("csoc&5", undefined, resolve)).canonical).toBe("gitlab:gitlab-int.switch.ch/csoc&5");
  // A non-numeric id (a test double's root) has no canonical form and is reported as the store gave it.
  expect((await resolveNodeTarget("root", undefined, async () => SOMA)).canonical).toBeUndefined();
});

test("on GitHub a #-prefixed id is the bare number the store reads", async () => {
  expect((await resolveNodeTarget("#498", undefined, async () => SOMA)).id).toBe("498");
  expect((await resolveNodeTarget("#498", undefined, async () => SOMA)).canonical).toBe("github:github.com/the-metafactory/soma#498");
});
