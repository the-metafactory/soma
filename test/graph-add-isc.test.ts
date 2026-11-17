import { expect, test } from "bun:test";
import { parseGraphArgs, runGraphCli } from "../src/cli/graph";
import { createGitHubGraphStore, createGitLabGraphStore, WorkGraphError, type GraphStore, type NodeState } from "../src/graph/index";
import { walkFakeSubtree } from "./fixtures/work-graph-fixtures";

const REPO = { forge: "github", host: "github.com", path: "the-metafactory/soma" } as const;
const VSA = [
  "# VSA",
  "",
  "## Criteria",
  "- [ ] ISC-7: The first criterion.",
  "- [x] ISC-9.2: A done sub-criterion.",
  "* [ ] ISC-11: Star bullets count too.",
  "ISC-99: not a checkbox line, so not a criterion.",
].join("\n");

type VsaRead = string | undefined | Error;

function fixture(vsa: VsaRead) {
  const root: NodeState = {
    ref: { id: "1" },
    node: { id: "1", title: "Map", autonomy: "propose", checkpointId: "cp-1", kind: "map" },
    status: "open",
    updatedAt: "2026-11-17T10:00:00Z",
    assignees: [],
    blockedBy: [],
    author: "ivy-agent",
    typed: true,
    body: "Map destination",
  };
  const nodes = new Map<string, NodeState>([["1", root]]);
  const created: { body?: string }[] = [];
  const reads: string[] = [];
  const unsupported = async (): Promise<never> => { throw new Error("Unexpected store operation"); };
  const lookup = (id: string): NodeState => {
    const node = nodes.get(id);
    if (node === undefined) throw new Error(`No fixture node ${id}`);
    return node;
  };
  const store: GraphStore = {
    attestation: "unverified",
    actingIdentity: async () => "ivy-agent",
    checkConfinement: unsupported,
    createNode: async (spec, _rehome, options) => {
      const id = String(900 + created.length);
      created.push({ ...(spec.body === undefined ? {} : { body: spec.body }) });
      nodes.set(id, {
        ...root, ref: { id }, node: { ...spec, id }, ...(spec.body === undefined ? {} : { body: spec.body }),
        ...(options?.detached === true || spec.parent === undefined ? {} : { parent: spec.parent }),
      });
      return { id };
    },
    attachToParent: async (child, parent) => { lookup(child.id).parent = parent; },
    addBlockingEdge: unsupported,
    readNode: async (ref) => lookup(ref.id),
    readSubtree: async (rootRef) => walkFakeSubtree(
      rootRef,
      (id) => [...nodes.values()].filter((node) => node.parent?.id === id).map((node) => node.ref.id),
      async (ref) => lookup(ref.id),
    ),
    claim: unsupported,
    release: unsupported,
    postComment: unsupported,
    readComment: unsupported,
    readCommentReactions: unsupported,
    listComments: async () => [],
    readRawBody: async (ref) => lookup(ref.id).body ?? "",
    writeRawBody: unsupported,
    close: unsupported,
    readDefaultBranchFile: async (repoPath, file) => {
      reads.push(`${repoPath}:${file}`);
      if (vsa instanceof Error) throw vsa;
      return vsa;
    },
  };
  const run = async (args: string[]) => runGraphCli(parseGraphArgs(["graph", "add", "1", "--title", "Do it", "--autonomy", "propose", "--checkpoint", "cp-x", ...args, "--repo", REPO.path]), {
    createStore: () => store,
    resolveRepo: async () => REPO,
  });
  return { run, created, reads };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
}

test("a build node in a repo with VSA.md and no citation is refused, naming both flags", async () => {
  const { run, created, reads } = fixture(VSA);
  const message = await refusal(run(["--kind", "build", "--body", "Ship it."]));
  expect(message).toContain("--isc ISC-n");
  expect(message).toContain("--isc-none \"<reason>\"");
  expect(created).toEqual([]);
  expect(reads).toEqual(["the-metafactory/soma:VSA.md"]);
});

test("a task node is held to the same rule", async () => {
  const { run, created } = fixture(VSA);
  expect(await refusal(run(["--kind", "task"]))).toContain("must cite the criterion it moves");
  expect(created).toEqual([]);
});

test("known --isc ids open the body with a Serves line", async () => {
  const { run, created } = fixture(VSA);
  await run(["--kind", "build", "--isc", "ISC-7", "--isc", "ISC-9.2", "--isc", "ISC-11", "--body", "## Deliverable\nShip it."]);
  expect(created).toEqual([{ body: "Serves: ISC-7, ISC-9.2, ISC-11.\n\n## Deliverable\nShip it." }]);
});

test("an --isc id that is not a criterion line is refused, naming it and the valid ids", async () => {
  const { run, created } = fixture(VSA);
  const message = await refusal(run(["--kind", "build", "--isc", "ISC-7", "--isc", "ISC-99"]));
  expect(message).toContain("ISC-99 is not a criterion in VSA.md");
  expect(message).not.toContain("ISC-7 is");
  expect(message).toContain("valid ids: ISC-7, ISC-9.2, ISC-11");
  expect(created).toEqual([]);
});

test("--isc-none records the exemption with its reason", async () => {
  const { run, created } = fixture(VSA);
  await run(["--kind", "build", "--isc-none", "repo hygiene, no criterion fits"]);
  expect(created).toEqual([{ body: "ISC: none (repo hygiene, no criterion fits)" }]);
});

test("an empty --isc-none reason is refused before any read", async () => {
  expect(() => parseGraphArgs(["graph", "add", "1", "--title", "t", "--autonomy", "propose", "--checkpoint", "cp", "--isc-none", "  "]))
    .toThrow("--isc-none needs a non-empty reason.");
});

test("--isc and --isc-none together are refused", () => {
  expect(() => parseGraphArgs(["graph", "add", "1", "--title", "t", "--autonomy", "propose", "--checkpoint", "cp", "--isc", "ISC-7", "--isc-none", "x"]))
    .toThrow("not both");
});

test("a malformed --isc id is refused at parse time", () => {
  expect(() => parseGraphArgs(["graph", "add", "1", "--title", "t", "--autonomy", "propose", "--checkpoint", "cp", "--isc", "7"]))
    .toThrow("--isc must match ISC-<n>");
});

test("a repo without VSA.md files a build node with no flag", async () => {
  const { run, created } = fixture(undefined);
  await run(["--kind", "build", "--body", "Ship it."]);
  expect(created).toEqual([{ body: "Ship it." }]);
});

test("grilling and decision nodes need no flag and cost no VSA read", async () => {
  for (const kind of ["grilling", "decision"]) {
    const { run, created, reads } = fixture(VSA);
    await run(["--kind", kind, "--body", "Question."]);
    expect(created).toEqual([{ body: "Question." }]);
    expect(reads).toEqual([]);
  }
});

test("a VSA.md read error other than not-found refuses with the error", async () => {
  const { run, created } = fixture(new WorkGraphError("backend", "gh api GET repos/x/contents/VSA.md failed (exit 1): HTTP 502"));
  const message = await refusal(run(["--kind", "build", "--isc", "ISC-7"]));
  expect(message).toContain("could not read VSA.md");
  expect(message).toContain("HTTP 502");
  expect(created).toEqual([]);
});

test("the GitHub store reads VSA.md from the default branch and maps 404 to absent", async () => {
  const paths: string[] = [];
  const content = Buffer.from(VSA).toString("base64");
  const store = createGitHubGraphStore({ repo: REPO.path, transport: async (request) => {
    paths.push(`${request.method} ${request.path}`);
    if (request.path.startsWith("repos/the-metafactory/soma/")) return { content, encoding: "base64" };
    throw new WorkGraphError("backend", "gh api GET x failed (exit 1): gh: Not Found (HTTP 404)");
  } });
  expect(await store.readDefaultBranchFile?.(REPO.path, "VSA.md")).toBe(VSA);
  expect(await store.readDefaultBranchFile?.("the-metafactory/other", "VSA.md")).toBeUndefined();
  expect(paths).toEqual(["GET repos/the-metafactory/soma/contents/VSA.md", "GET repos/the-metafactory/other/contents/VSA.md"]);

  const failing = createGitHubGraphStore({ repo: REPO.path, transport: async () => { throw new WorkGraphError("backend", "HTTP 502"); } });
  await expect(failing.readDefaultBranchFile?.(REPO.path, "VSA.md")).rejects.toThrow("HTTP 502");
});

test("the GitLab store reads VSA.md from the project's default branch", async () => {
  const paths: string[] = [];
  const store = createGitLabGraphStore({ host: "gitlab.example.org", transport: async (request) => {
    paths.push(request.path);
    if (request.path === "projects/group%2Fproj") return { default_branch: "trunk" };
    return { content: Buffer.from(VSA).toString("base64"), encoding: "base64" };
  } });
  expect(await store.readDefaultBranchFile?.("group/proj", "VSA.md")).toBe(VSA);
  expect(paths).toEqual(["projects/group%2Fproj", "projects/group%2Fproj/repository/files/VSA.md?ref=trunk"]);

  const missing = createGitLabGraphStore({ host: "gitlab.example.org", transport: async () => { throw new WorkGraphError("backend", "glab api GET x failed (exit 1): 404 Not Found"); } });
  expect(await missing.readDefaultBranchFile?.("group/proj", "VSA.md")).toBeUndefined();
});

test("a body Serves line counts as the citation and the body is filed unchanged", async () => {
  const { run, created } = fixture(VSA);
  const body = "## Deliverable\nShip it.\n\nServes: ISC-7, ISC-9.2.";
  await run(["--kind", "build", "--body", body]);
  expect(created).toEqual([{ body }]);
});

test("a body Serves line naming an unknown id is refused, naming it", async () => {
  const { run, created } = fixture(VSA);
  const message = await refusal(run(["--kind", "build", "--body", "Serves: ISC-7, ISC-42.\n\nShip it."]));
  expect(message).toContain("ISC-42 is not a criterion in VSA.md");
  expect(created).toEqual([]);
});

test("a body ISC: none line with a reason counts as the exemption", async () => {
  const { run, created } = fixture(VSA);
  const body = "ISC: none (repo hygiene)\n\nTidy up.";
  await run(["--kind", "task", "--body", body]);
  expect(created).toEqual([{ body }]);
});

test("a body ISC: none line with an empty reason does not count", async () => {
  const { run, created } = fixture(VSA);
  expect(await refusal(run(["--kind", "build", "--body", "ISC: none ( )\n\nTidy up."]))).toContain("must cite the criterion it moves");
  expect(created).toEqual([]);
});

test("prose that mentions an id outside the Serves line format is still refused", async () => {
  const { run, created } = fixture(VSA);
  expect(await refusal(run(["--kind", "build", "--body", "This serves ISC-7 nicely.\nServes ISC-7"]))).toContain("must cite the criterion it moves");
  expect(created).toEqual([]);
});

test("a flag whose line the body already carries is not added twice", async () => {
  const { run, created } = fixture(VSA);
  await run(["--kind", "build", "--isc", "ISC-7", "--body", "Serves: ISC-7.\n\nShip it."]);
  expect(created).toEqual([{ body: "Serves: ISC-7.\n\nShip it." }]);
});

test("a flag with a body Serves line naming an unknown id is refused, naming it", async () => {
  const { run, created } = fixture(VSA);
  const message = await refusal(run(["--kind", "build", "--isc", "ISC-7", "--body", "Serves: ISC-99.\n\nShip it."]));
  expect(message).toContain("ISC-99 is not a criterion in VSA.md");
  expect(created).toEqual([]);
});

test("a flag with a different valid body Serves line is filed with the flag line on top", async () => {
  const { run, created } = fixture(VSA);
  await run(["--kind", "build", "--isc", "ISC-7", "--body", "Serves: ISC-11.\n\nShip it."]);
  expect(created).toEqual([{ body: "Serves: ISC-7.\n\nServes: ISC-11.\n\nShip it." }]);
});
