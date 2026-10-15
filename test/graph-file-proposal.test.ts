import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseGraphArgs, runGraphCli } from "../src/cli/graph";
import { SomaCliError } from "../src/cli/errors";
import type { CreateNodeSpec, GraphStore, NodeState } from "../src/work-graph";
import { hasProposalMarker, proposalMarker } from "../src/proposal-file";
import { createGitHubGraphStore, type GitHubApiTransport } from "../src/work-graph-github";
import { WorkGraphError } from "../src/work-graph";
import { walkFakeSubtree } from "./fixtures/work-graph-fixtures";

const BRIEF = "## Deliverable\nA check that refuses the bad output.\n\n## Acceptance criteria\n- The check fails on the cited case.\n";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "soma-file-proposal-"));
  await mkdir(join(home, "proposals"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function frontMatter(fields: Record<string, string> = {}): string {
  const merged: Record<string, string> = {
    proposal_kind: "deterministic-check",
    landing: "the-metafactory/soma",
    map_root: "777",
    title: "Check outlines for empty sections",
    checkpoint: "errata-check-algorithm-verify",
    cites: "[E1, E4]",
    ...fields,
  };
  return Object.entries(merged).map(([key, value]) => `${key}: ${value}`).join("\n");
}

async function writeProposal(ref: string, body = BRIEF, fields: Record<string, string> = {}): Promise<void> {
  await writeFile(join(home, "proposals", `${ref}.md`), `---\n${frontMatter(fields)}\n---\n${body}`);
}

function state(id: string, overrides: Partial<NodeState> = {}): NodeState {
  return {
    ref: { id },
    node: { id, title: `Node ${id}`, autonomy: "approve", checkpointId: `cp-${id}` },
    status: "open",
    updatedAt: "2026-10-14T10:00:00Z",
    assignees: [],
    blockedBy: [],
    author: "jcfischer",
    typed: true,
    ...overrides,
  };
}

interface Fixture {
  store: GraphStore;
  created: CreateNodeSpec[];
  repos: string[];
}

function fixture(options: { children?: NodeState[]; createError?: Error; readError?: Error; attachFailures?: number; markerError?: Error } = {}): Fixture {
  const nodes = new Map<string, NodeState>([["777", state("777")]]);
  for (const child of options.children ?? []) nodes.set(child.ref.id, { parent: { id: "777" }, ...child });
  const created: CreateNodeSpec[] = [];
  let attachFailures = options.attachFailures ?? 0;
  const attach = (child: string, parent: NodeState["parent"]): void => {
    if (attachFailures-- > 0) throw new Error("HTTP 403: sub-issue attachment refused");
    lookup(child).parent = parent;
  };
  const lookup = (id: string): NodeState => {
    const node = nodes.get(id);
    if (node === undefined) throw new Error(`No fixture node ${id}`);
    return node;
  };
  const unsupported = async (): Promise<never> => { throw new Error("Unexpected store operation"); };
  const store: GraphStore = {
    attestation: "unverified",
    actingIdentity: async () => "jcfischer",
    checkConfinement: unsupported,
    createNode: async (spec) => {
      if (options.createError !== undefined) throw options.createError;
      created.push(spec);
      const id = String(900 + created.length);
      nodes.set(id, state(id, { node: { ...spec, id } as NodeState["node"], body: spec.body }));
      if (spec.parent !== undefined) attach(id, spec.parent);
      return { id };
    },
    attachToParent: async (child, parent) => { attach(child.id, parent); },
    addBlockingEdge: unsupported,
    readNode: async (ref) => lookup(ref.id),
    findNodesByBodyMarker: async (marker) => {
      if (options.markerError !== undefined) throw options.markerError;
      return [...nodes.values()].filter((node) => node.body?.includes(marker));
    },
    readSubtree: async (root) => {
      if (options.readError !== undefined) throw options.readError;
      return await walkFakeSubtree(
        root,
        (id) => [...nodes.values()].filter((node) => node.parent?.id === id).map((node) => node.ref.id),
        async (ref) => lookup(ref.id),
      );
    },
    claim: unsupported,
    release: unsupported,
    postComment: unsupported,
    readComment: unsupported,
    readCommentReactions: unsupported,
    listComments: unsupported,
    readRawBody: unsupported,
    writeRawBody: unsupported,
    close: unsupported,
  };
  return { store, created, repos: [] };
}

async function run(fx: Fixture, ref: string, json = false): Promise<string> {
  return await runGraphCli(parseGraphArgs(["graph", "file-proposal", ref, ...(json ? ["--json"] : [])]), {
    somaHome: home,
    createStore: (repo) => { fx.repos.push(`${repo.forge}:${repo.host}/${repo.path}`); return fx.store; },
    resolveRepo: async () => { throw new Error("file-proposal must not resolve a repo from cwd"); },
  });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SomaCliError);
    expect((error as SomaCliError).exitCode).toBe(1);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

test("a deterministic-check proposal files a build node under landing#map_root and prints its ref", async () => {
  await writeProposal("errata-check-algorithm-verify-g1");
  const fx = fixture();
  const output = await run(fx, "errata-check-algorithm-verify-g1");

  expect(output).toContain("the-metafactory/soma#901");
  expect(fx.repos).toEqual(["github:github.com/the-metafactory/soma"]);
  expect(fx.created).toHaveLength(1);
  const [spec] = fx.created;
  expect(spec.kind).toBe("build");
  expect(spec.autonomy).toBe("propose");
  expect(spec.title).toBe("Check outlines for empty sections");
  expect(spec.checkpointId).toBe("errata-check-algorithm-verify");
  expect(spec.parent).toEqual({ id: "777" });
  expect(spec.body).toContain("## Deliverable\nA check that refuses the bad output.");
  expect(spec.body).toContain(proposalMarker("errata-check-algorithm-verify-g1"));
});

test("every other kind files a grilling node at approve", async () => {
  for (const kind of ["reviewer-standard", "navigation-pointer", "information-access", "rule-memory"]) {
    await writeProposal(`p-${kind}`, "Should reviewers hold outlines to a standard?\n", { proposal_kind: kind });
    const fx = fixture();
    await run(fx, `p-${kind}`);
    expect(fx.created[0]).toMatchObject({ kind: "grilling", autonomy: "approve" });
  }
});

test("the envelope's soma:proposals/<ref>.md form names the same proposal and marker", async () => {
  await writeProposal("errata-x-g2");
  const fx = fixture();
  expect(JSON.parse(await run(fx, "soma:proposals/errata-x-g2.md", true))).toEqual({ ref: "the-metafactory/soma#901", created: true });
  expect(JSON.parse(await run(fx, "errata-x-g2", true))).toEqual({ ref: "the-metafactory/soma#901", created: false });
  expect(fx.created).toHaveLength(1);
});

test("a second run finds the marker under the map and files nothing, even once the node closed", async () => {
  await writeProposal("errata-x-g1");
  const fx = fixture({
    children: [
      state("850", { body: `Other\n\n${proposalMarker("errata-x-g10")}` }),
      state("851", { status: "closed", body: `Earlier\n\n${proposalMarker("errata-x-g1")}` }),
    ],
  });
  expect(await run(fx, "errata-x-g1")).toContain("already filed as the-metafactory/soma#851");
  expect(JSON.parse(await run(fx, "errata-x-g1", true))).toEqual({ ref: "the-metafactory/soma#851", created: false });
  expect(fx.created).toHaveLength(0);
});

test("a partial creation is recovered across retries without creating another node", async () => {
  await writeProposal("errata-partial-g1");
  const fx = fixture({ attachFailures: 2 });
  expect(await refusal(run(fx, "errata-partial-g1"))).toContain("HTTP 403: sub-issue attachment refused");
  expect(fx.created).toHaveLength(1);
  expect(await refusal(run(fx, "errata-partial-g1"))).toContain("HTTP 403: sub-issue attachment refused");
  expect(fx.created).toHaveLength(1);
  expect(JSON.parse(await run(fx, "soma:proposals/errata-partial-g1.md", true))).toEqual({ ref: "the-metafactory/soma#901", created: false });
  expect((await fx.store.readSubtree({ id: "777" })).map((node) => node.ref.id)).toContain("901");
  expect(await run(fx, "errata-partial-g1")).toContain("already filed as the-metafactory/soma#901");
  expect(fx.created).toHaveLength(1);
});

test("GitHub membership failure is recovered by a fresh store on the next invocation", async () => {
  await writeProposal("errata-restart-g1");
  const issue = (number: number, title: string, body: string) => ({
    number, id: number + 1000, title, body, state: "open",
    updated_at: "2026-10-15T10:00:00Z", user: { login: "ivy-agent" }, assignees: [],
  });
  const root = issue(777, "Map", "");
  let child: ReturnType<typeof issue> | undefined;
  let attached = false;
  let creates = 0;
  let attaches = 0;
  const transport: GitHubApiTransport = async (request) => {
    if (request.method === "GET" && request.path === "user") return { login: "ivy-agent" };
    if (request.method === "POST" && request.path === "repos/the-metafactory/soma/issues") {
      creates++;
      child = issue(901, String(request.body?.title), String(request.body?.body));
      return child;
    }
    if (request.path.endsWith("/777/sub_issues")) {
      expect(request.body?.sub_issue_id).toBe(1901);
      if (++attaches === 1) throw new Error("HTTP 403: attachment refused");
      attached = true;
      return {};
    }
    if (request.path.includes("issues?state=all")) return [root, ...(child ? [child] : [])];
    if (request.path.endsWith("/dependencies/blocked_by")) return [];
    if (request.path.endsWith("/parent")) {
      if (attached && request.path.includes("/901/")) return root;
      throw new WorkGraphError("backend", "HTTP 404: Not Found");
    }
    if (request.path.endsWith("/777")) return root;
    if (request.path.endsWith("/901") && child) return child;
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  };
  const invoke = () => runGraphCli(parseGraphArgs(["graph", "file-proposal", "errata-restart-g1", "--json"]), {
    somaHome: home,
    createStore: () => {
      // Only map traversal is stubbed. Create, marker discovery, parent reads
      // and attachment all use the GitHub adapter, with no retained store cache.
      const store = createGitHubGraphStore({ repo: "the-metafactory/soma", transport });
      store.readSubtree = async () => Promise.all((attached ? ["777", "901"] : ["777"]).map((id) => store.readNode({ id })));
      return store;
    },
  });
  expect(await refusal(invoke())).toContain("HTTP 403: attachment refused");
  expect(creates).toBe(1);
  expect(attached).toBe(false);
  expect(JSON.parse(await invoke())).toEqual({ ref: "the-metafactory/soma#901", created: false });
  expect(attached).toBe(true);
  expect(JSON.parse(await invoke())).toEqual({ ref: "the-metafactory/soma#901", created: false });
  expect(creates).toBe(1);
  expect(attaches).toBe(2);
});

test("foreign and missing authors cannot supply a marker in the map or outside it", async () => {
  await writeProposal("errata-auth-g1");
  for (const parent of [undefined, { id: "777" }]) {
    for (const author of ["outsider", "ivy-agent", ""]) {
      const fx = fixture({ children: [state("850", { parent, author, body: `${proposalMarker("errata-auth-g1")}\nFiled by jcfischer` })] });
      let attaches = 0;
      fx.store.attachToParent = async () => { attaches++; };
      const message = await refusal(run(fx, "errata-auth-g1"));
      expect(message).toContain('not authenticated filer "jcfischer"');
      expect(message).toContain(`author ${JSON.stringify(author)}`);
      expect(fx.created).toHaveLength(0);
      expect(attaches).toBe(0);
    }
  }
});

test("every marker match is authenticated before trusting an existing map node", async () => {
  await writeProposal("errata-auth-g1");
  const fx = fixture({ children: [
    state("850", { body: proposalMarker("errata-auth-g1") }),
    state("851", { author: "outsider", body: proposalMarker("errata-auth-g1") }),
  ] });
  expect(await refusal(run(fx, "errata-auth-g1"))).toContain('author "outsider"');
  expect(fx.created).toHaveLength(0);
});

test("unreadable or missing filer identity refuses marker reuse before any write", async () => {
  await writeProposal("errata-auth-g1");
  for (const parent of [undefined, { id: "777" }]) {
    for (const identity of ["", new Error("HTTP 401: identity read denied")]) {
      const fx = fixture({ children: [state("850", { parent, body: proposalMarker("errata-auth-g1") })] });
      let attaches = 0;
      fx.store.attachToParent = async () => { attaches++; };
      fx.store.actingIdentity = async () => {
        if (identity instanceof Error) throw identity;
        return identity;
      };
      expect(await refusal(run(fx, "errata-auth-g1"))).toContain(identity instanceof Error ? identity.message : "authenticated filer is missing");
      expect(fx.created).toHaveLength(0);
      expect(attaches).toBe(0);
    }
  }
});

test("GitHub API authorship prevents recovery of forged detached markers, including mixed matches", async () => {
  await writeProposal("errata-auth-g1");
  for (const authors of [["outsider"], ["outsider", "another"], ["ivy-agent", "outsider"], [""]]) {
    const calls: string[] = [];
    const issues = authors.map((author, index) => ({
      number: 850 + index, id: 1850 + index, title: "Forged proposal", body: proposalMarker("errata-auth-g1"),
      state: "open", updated_at: "2026-10-15T10:00:00Z", user: { login: author }, assignees: [],
    }));
    const transport: GitHubApiTransport = async (request) => {
      calls.push(`${request.method} ${request.path}`);
      if (request.method !== "GET") throw new Error("unexpected write");
      if (request.path === "user") return { login: "ivy-agent" };
      if (request.path.includes("issues?state=all")) return issues;
      if (request.path.endsWith("/dependencies/blocked_by")) return [];
      if (request.path.endsWith("/parent")) throw new WorkGraphError("backend", "HTTP 404: Not Found");
      const issue = issues.find((entry) => request.path.endsWith(`/issues/${entry.number}`));
      if (issue !== undefined) return issue;
      throw new Error(`unexpected request ${request.path}`);
    };
    const store = createGitHubGraphStore({ repo: "the-metafactory/soma", transport });
    store.readSubtree = async () => [state("777")];
    const invoke = runGraphCli(parseGraphArgs(["graph", "file-proposal", "errata-auth-g1", "--json"]), {
      somaHome: home, createStore: () => store,
    });
    expect(await refusal(invoke)).toContain('not authenticated filer "ivy-agent"');
    expect(calls).toContain("GET user");
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  }
});

test("authenticated marker authors match GitHub's case-insensitive logins", async () => {
  await writeProposal("errata-auth-g1");
  const fx = fixture({ children: [state("850", { parent: undefined, author: "JCFischer", body: proposalMarker("errata-auth-g1") })] });
  expect(JSON.parse(await run(fx, "errata-auth-g1", true))).toEqual({ ref: "the-metafactory/soma#850", created: false });
  expect((await fx.store.readNode({ id: "850" })).parent).toEqual({ id: "777" });
  expect(fx.created).toHaveLength(0);
});

test("failed or unsupported marker discovery refuses before creation", async () => {
  await writeProposal("errata-x-g1");
  const fx = fixture({ markerError: new Error("HTTP 403: issues read denied") });
  expect(await refusal(run(fx, "errata-x-g1"))).toContain("HTTP 403: issues read denied");
  expect(fx.created).toHaveLength(0);
  delete fx.store.findNodesByBodyMarker;
  expect(await refusal(run(fx, "errata-x-g1"))).toContain("cannot discover unattached proposal nodes");
  expect(fx.created).toHaveLength(0);
});

test("a marker outside the target map never reparents a node or creates another", async () => {
  await writeProposal("errata-x-g1");
  const fx = fixture({ children: [state("850", { parent: { id: "888" }, body: proposalMarker("errata-x-g1") })] });
  expect(await refusal(run(fx, "errata-x-g1"))).toContain("already attached to 888");
  expect(fx.created).toHaveLength(0);
});

test("ambiguous markers outside the map refuse another create", async () => {
  await writeProposal("errata-x-g1");
  const fx = fixture({ children: ["850", "851"].map((id) => state(id, { parent: undefined, body: proposalMarker("errata-x-g1") })) });
  expect(await refusal(run(fx, "errata-x-g1"))).toContain("multiple nodes carry");
  expect(fx.created).toHaveLength(0);
});

test("refs outside proposals/ are refused before any store is opened", async () => {
  await writeFile(join(home, "secret.md"), `---\n${frontMatter()}\n---\n${BRIEF}`);
  const outside = await mkdtemp(join(tmpdir(), "soma-file-proposal-out-"));
  await writeFile(join(outside, "evil.md"), `---\n${frontMatter()}\n---\n${BRIEF}`);
  await symlink(join(outside, "evil.md"), join(home, "proposals", "linked.md"));
  try {
    for (const ref of ["../secret", "%2e%2e/secret", "%2E%2E%2Fsecret", "soma:secret.md", "soma:proposals/../secret.md", "/etc/passwd", "linked"]) {
      const fx = fixture();
      expect(await refusal(run(fx, ref))).toContain("outside");
      expect(fx.repos).toEqual([]);
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("a missing file is refused and named", async () => {
  const fx = fixture();
  expect(await refusal(run(fx, "errata-none-g1"))).toContain("no proposal file");
  expect(fx.repos).toEqual([]);
});

test("front-matter that fails the schema is refused, naming the field", async () => {
  const cases: [Record<string, string>, string][] = [
    [{ proposal_kind: "hunch" }, "proposal_kind"],
    [{ landing: "soma" }, "landing"],
    [{ map_root: "0" }, "map_root"],
    [{ map_root: "\"777\"" }, "map_root"],
    [{ title: "\"\"" }, "title"],
    [{ checkpoint: "cp-1" }, "checkpoint"],
    [{ cites: "[]" }, "cites"],
    [{ cites: "[X1]" }, "cites"],
    [{ extra: "yes" }, "extra"],
  ];
  for (const [fields, field] of cases) {
    await writeProposal("bad", BRIEF, fields);
    const fx = fixture();
    const message = await refusal(run(fx, "bad"));
    expect(message).toContain("fails the schema");
    expect(message).toContain(field);
    expect(fx.created).toHaveLength(0);
  }
  await writeFile(join(home, "proposals", "bare.md"), BRIEF);
  expect(await refusal(run(fixture(), "bare"))).toContain("front-matter");
});

test("a body build-brief-not-ready would flag is refused", async () => {
  await writeProposal("unclear", `${BRIEF}\n[NEEDS CLARIFICATION]\n`);
  expect(await refusal(run(fixture(), "unclear"))).toContain("build-brief-not-ready — [NEEDS CLARIFICATION]");
  await writeProposal("no-ac", "## Deliverable\nA check.\n");
  expect(await refusal(run(fixture(), "no-ac"))).toContain("## Acceptance criteria");
  await writeProposal("grill-unclear", "Which standard? [NEEDS CLARIFICATION]\n", { proposal_kind: "rule-memory" });
  expect(await refusal(run(fixture(), "grill-unclear"))).toContain("[NEEDS CLARIFICATION]");
});

test("a body that already carries a proposal marker is refused", async () => {
  await writeProposal("forged", `${BRIEF}\n${proposalMarker("someone-else")}\n`);
  expect(await refusal(run(fixture(), "forged"))).toContain("marker");
});

test("an unreadable map or a refused write exits non-zero with the forge's reason and files nothing", async () => {
  await writeProposal("errata-x-g1");
  const unreadable = fixture({ readError: new Error("HTTP 404: Not Found") });
  const readMessage = await refusal(run(unreadable, "errata-x-g1"));
  expect(readMessage).toContain("the-metafactory/soma#777 is unreadable");
  expect(readMessage).toContain("HTTP 404: Not Found");
  expect(unreadable.created).toHaveLength(0);

  const refused = fixture({ createError: new Error("HTTP 403: Resource not accessible by integration") });
  expect(await refusal(run(refused, "errata-x-g1"))).toContain("HTTP 403: Resource not accessible by integration");
});

test("the marker matches an exact ref, never a prefix", () => {
  expect(hasProposalMarker(`x\n${proposalMarker("errata-a-g10")}`, "errata-a-g1")).toBe(false);
  expect(hasProposalMarker(`x\n${proposalMarker("errata-a-g1")}`, "errata-a-g1")).toBe(true);
  expect(hasProposalMarker(undefined, "errata-a-g1")).toBe(false);
});

test("file-proposal takes only --json", () => {
  expect(() => parseGraphArgs(["graph", "file-proposal", "x", "--repo", "a/b"])).toThrow("Unknown option: --repo");
  expect(() => parseGraphArgs(["graph", "file-proposal"])).toThrow("soma graph file-proposal");
});
