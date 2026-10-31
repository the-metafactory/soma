import { expect, test } from "bun:test";
import { parseGraphArgs, runGraphCli } from "../src/cli/graph";
import { SomaCliError } from "../src/cli/errors";
import { WorkGraphError, createGitHubGraphStore, encodeNodeBlock, type CreateNodeSpec, type GitHubApiRequest, type GraphStore, type LabeledNode, type NodeState } from "../src/graph/index";

const REPO = { forge: "github", host: "github.com", path: "the-metafactory/soma" } as const;
const MARKER = "<!-- ranger:intake discord=42 -->";
const LABEL = "ranger:principal-intake";

function fixture(listed: LabeledNode[] | "unsupported" | "fails" = [], parents: Record<string, string> = {}, attachFails = false) {
  const created: CreateNodeSpec[] = [];
  const listedLabels: string[] = [];
  const listedAuthors: string[] = [];
  const attached: string[] = [];
  const unsupported = async (): Promise<never> => { throw new Error("Unexpected store operation"); };
  const state = (id: string): NodeState => ({
    ref: { id }, node: { id, title: id, autonomy: "propose", checkpointId: "cp" }, status: "open",
    updatedAt: "2026-10-30T10:00:00Z", assignees: [], blockedBy: [], author: "ivy-bot", typed: true,
    ...(parents[id] === undefined ? {} : { parent: { id: parents[id] } }),
  });
  const store: GraphStore = {
    attestation: "verifiable",
    actingIdentity: async () => "Ivy-Bot",
    checkConfinement: unsupported,
    createNode: async (spec) => { created.push(spec); return { id: "900" }; },
    attachToParent: async (child) => {
      if (attachFails) throw new WorkGraphError("backend", "GitHub said 502");
      attached.push(child.id);
    },
    addBlockingEdge: unsupported,
    readNode: async (ref) => state(ref.id),
    readSubtree: unsupported,
    claim: unsupported,
    release: unsupported,
    postComment: unsupported,
    readComment: unsupported,
    readCommentReactions: unsupported,
    listComments: unsupported,
    readRawBody: unsupported,
    writeRawBody: unsupported,
    close: unsupported,
    ...(listed === "unsupported" ? {} : {
      listNodesByLabel: async (label: string, author: string) => {
        listedLabels.push(label);
        listedAuthors.push(author);
        if (listed === "fails") throw new WorkGraphError("backend", "GitHub said 502");
        return listed;
      },
    }),
  };
  const run = async (args: string[]) => runGraphCli(parseGraphArgs([
    "graph", "add", "7", "--title", "t", "--autonomy", "propose", "--checkpoint", "cp", ...args, "--repo", REPO.path,
  ]), { createStore: () => store, resolveRepo: async () => REPO, assertInstalledRuntime: async () => undefined });
  const failure = async (args: string[]): Promise<SomaCliError> => {
    try {
      await run(args);
    } catch (error) {
      if (error instanceof SomaCliError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };
  return { created, listedLabels, listedAuthors, attached, run, failure };
}

const once = ["--label", LABEL, "--label", "other", "--once", ` ${MARKER} `];

test("no marked node: creates with the marker as the body's last line, scoped to the first label", async () => {
  const fx = fixture([{ id: "5", author: "someone-else", body: `x\n\n${MARKER}` }]);
  const out = JSON.parse(await fx.run([...once, "--body", "words\n", "--json"])) as Record<string, unknown>;
  expect(out).toEqual({ repo: "the-metafactory/soma", node: "900", parent: "7", blockedBy: [], existing: false });
  expect(fx.created[0]?.body).toBe(`words\n\n${MARKER}`);
  expect(fx.listedLabels).toEqual([LABEL]);
  expect(fx.listedAuthors).toEqual(["Ivy-Bot"]);
});

test("the marker is the whole body when none is given, and is not appended twice", async () => {
  const bare = fixture();
  await bare.run(once);
  expect(bare.created[0]?.body).toBe(MARKER);
  const ending = fixture();
  await ending.run([...once, "--body", `words\n\n${MARKER}\n`]);
  expect(ending.created[0]?.body?.trimEnd()).toBe(`words\n\n${MARKER}`);
});

test("one marked node: returns it with its actual parent and creates nothing", async () => {
  const fx = fixture([{ id: "77", author: "ivy-bot", body: `words\r\n\r\n${MARKER}\r\n` }], { "77": "12" });
  const out = JSON.parse(await fx.run([...once, "--json"])) as Record<string, unknown>;
  expect(out).toEqual({ repo: "the-metafactory/soma", node: "77", parent: "12", blockedBy: [], existing: true });
  expect(await fx.run(once)).toBe(`Node 77 already carries ${MARKER} and sits under 12 (the-metafactory/soma); nothing new filed.`);
  expect(fx.created).toEqual([]);
  expect(fx.attached).toEqual([]);
});

test("one marked unattached node, left by a failed add: a retry attaches it under the requested parent", async () => {
  const fx = fixture([{ id: "77", author: "ivy-bot", body: MARKER }]);
  const out = JSON.parse(await fx.run([...once, "--json"])) as Record<string, unknown>;
  expect(out).toEqual({ repo: "the-metafactory/soma", node: "77", parent: "7", blockedBy: [], existing: true });
  expect(fx.created).toEqual([]);
  expect(fx.attached).toEqual(["77"]);
});

test("a retry that cannot attach the found node fails instead of reporting it filed", async () => {
  const fx = fixture([{ id: "77", author: "ivy-bot", body: MARKER }], {}, true);
  const refused = await fx.failure([...once, "--json"]);
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.message)).toMatchObject({ node: "77", parent: null, existing: true, attached: false, attachError: expect.stringContaining("502") });
  expect(fx.created).toEqual([]);
});

test("a marker by another author or not on the last line is ignored", async () => {
  const fx = fixture([
    { id: "1", author: "intruder", body: MARKER },
    { id: "2", author: "ivy-bot", body: `see ${MARKER}` },
    { id: "3", author: "ivy-bot", body: `${MARKER}\nmore words` },
  ]);
  expect(JSON.parse(await fx.run([...once, "--json"]))).toMatchObject({ node: "900", existing: false });
  expect(fx.created).toHaveLength(1);
});

test("two marked nodes refuse and create nothing", async () => {
  const listed = [{ id: "9", author: "ivy-bot", body: MARKER }, { id: "10", author: "ivy-bot", body: `x\n${MARKER}` }];
  const plain = fixture(listed);
  const error = await plain.failure(once);
  expect(error.exitCode).toBe(1);
  expect(error.message).toBe(`nodes #9, #10 all carry ${MARKER}; nothing more is filed`);
  const json = fixture(listed);
  expect(JSON.parse((await json.failure([...once, "--json"])).message)).toEqual({ error: "once-ambiguous", marker: MARKER, nodes: ["9", "10"] });
  expect([...plain.created, ...json.created]).toEqual([]);
});

test("--once without a label, or with a multi-line, empty or long marker, is a usage error", () => {
  const add = ["graph", "add", "7", "--title", "t", "--autonomy", "propose", "--checkpoint", "cp"];
  expect(() => parseGraphArgs([...add, "--once", MARKER])).toThrow(/needs a --label/u);
  for (const marker of ["a\nb", "a\rb", "   ", "x".repeat(301)]) {
    expect(() => parseGraphArgs([...add, "--label", LABEL, "--once", marker])).toThrow(/one line of 1-300/u);
  }
  expect(() => parseGraphArgs(["graph", "chart", "--title", "t", "--autonomy", "propose", "--checkpoint", "cp", "--label", LABEL, "--once", MARKER])).toThrow(/not chart/u);
});

test("a listing that fails, or a store that cannot list, refuses and creates nothing", async () => {
  for (const listed of ["fails", "unsupported"] as const) {
    const fx = fixture(listed);
    const error = await fx.failure(once);
    expect(error.message).toContain("--once refused");
    expect(fx.created).toEqual([]);
  }
});

test("without --once the add output keeps its shape", async () => {
  const fx = fixture();
  expect(Object.keys(JSON.parse(await fx.run(["--label", LABEL, "--json"])) as object)).toEqual(["repo", "node", "parent", "blockedBy"]);
  expect(fx.listedLabels).toEqual([]);
});

test("GitHub lists a label's issues, open and closed, with the node block stripped and pull requests dropped", async () => {
  const requests: GitHubApiRequest[] = [];
  const raw = `words\n\n${MARKER}\n\n${encodeNodeBlock({ title: "t", autonomy: "propose", checkpointId: "cp" })}`;
  const store = createGitHubGraphStore({ repo: REPO.path, transport: async (request) => {
    requests.push(request);
    return [
      { number: 77, body: raw, user: { login: "ivy-bot" } },
      { number: 78, body: null, user: null },
      { number: 79, body: MARKER, user: { login: "ivy-bot" }, pull_request: {} },
    ];
  } });
  expect(await store.listNodesByLabel?.(LABEL, "ivy-bot")).toEqual([
    { id: "77", author: "ivy-bot", body: `words\n\n${MARKER}` },
    { id: "78", author: "", body: "" },
  ]);
  expect(requests).toEqual([{ method: "GET", path: `repos/${REPO.path}/issues?labels=ranger%3Aprincipal-intake&creator=ivy-bot&state=all&per_page=100`, paginate: true }]);
});

test("GitHub label listing rejects a failed read and a label it cannot express", async () => {
  const store = createGitHubGraphStore({ repo: REPO.path, transport: async () => { throw new Error("HTTP 502"); } });
  await expect(store.listNodesByLabel?.(LABEL, "ivy-bot")).rejects.toThrow(/HTTP 502/u);
  await expect(store.listNodesByLabel?.("a,b", "ivy-bot")).rejects.toThrow(/without commas/u);
  await expect(store.listNodesByLabel?.(LABEL, " ")).rejects.toThrow(/author is empty/u);
});
