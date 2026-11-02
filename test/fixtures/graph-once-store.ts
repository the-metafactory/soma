import { parseGraphArgs, runGraphCli } from "../../src/cli/graph";
import { SomaCliError } from "../../src/cli/errors";
import { WorkGraphError, type CreateNodeSpec, type GraphStore, type LabeledNode, type NodeState } from "../../src/graph/index";

export const REPO = { forge: "github", host: "github.com", path: "the-metafactory/soma" } as const;
export const MARKER = "<!-- ranger:intake discord=42 -->";
export const LABEL = "ranger:principal-intake";
export const ADD = ["graph", "add", "7"] as const;
export const CHART = ["graph", "chart"] as const;

export function onceFixture(listed: LabeledNode[] | "unsupported" | "fails" = [], { parents = {}, attachFails = false, readFails = false, command = ADD }: { parents?: Record<string, string>; attachFails?: boolean; readFails?: boolean; command?: readonly string[] } = {}) {
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
    readNode: async (ref) => {
      if (readFails) throw new WorkGraphError("backend", "GitHub said 503");
      return state(ref.id);
    },
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
    ...command, "--title", "t", "--autonomy", "propose", "--checkpoint", "cp", ...args, "--repo", REPO.path,
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
