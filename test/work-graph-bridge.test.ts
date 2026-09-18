import { expect, test } from "bun:test";
import { WorkGraphError } from "../src/work-graph";
import {
  classifyHost,
  createGraphStore,
  probeRegistryKey,
  resolveGraphRepo,
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

test("a host that is neither github.com nor GitLab refuses with both qualified spellings (#536 D4)", async () => {
  const { deps } = resolution({ remote: "git@ghe.example.com:acme/widgets.git" });
  const error = String(await resolveGraphRepo(undefined, deps).catch((caught: unknown) => caught));
  expect(error).toContain("never assumes GitHub Enterprise");
  expect(error).toContain("--repo gitlab:ghe.example.com/acme/widgets");
  expect(error).toContain("--repo github:ghe.example.com/acme/widgets");
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

test("the v1 probe registry authorises github.com repos only — no host-less lookup for any other host", () => {
  expect(probeRegistryKey(SOMA)).toBe("the-metafactory/soma");
  expect(() => probeRegistryKey({ ...SOMA, host: "ghe.example.com" })).toThrow(/only authorise github.com/);
  expect(() => probeRegistryKey({ forge: "gitlab", host: "gitlab-int.switch.ch", path: "the-metafactory/soma" })).toThrow(
    /only authorise github.com/,
  );
});
