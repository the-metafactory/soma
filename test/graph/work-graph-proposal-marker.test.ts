import { expect, test } from "bun:test";
import { proposalMarker } from "../../src/graph/index";
import { WorkGraphError, type GraphStore } from "../../src/graph/index";
import { createGitHubGraphStore, parseGhApiOutput, type GitHubApiRequest, type GitHubApiTransport } from "../../src/graph/index";

const REPO = "the-metafactory/soma";
const MARKER = proposalMarker("errata-check-g1");
const issue = (number: number, body: string | null = MARKER, state = "open") => ({
  number, id: number + 1000, title: `node ${number}`, body, state,
  updated_at: "2026-10-15T10:00:00Z", user: { login: "ivy-agent" }, assignees: [],
});

async function find(store: GraphStore) {
  if (store.findNodesByBodyMarker === undefined) throw new Error("marker discovery unsupported");
  return await store.findNodesByBodyMarker(MARKER);
}

function fixture(pages: unknown[][], current: Record<string, unknown>, fail?: (request: GitHubApiRequest) => void) {
  const calls: GitHubApiRequest[] = [];
  const transport: GitHubApiTransport = async (request) => {
    calls.push(request);
    fail?.(request);
    if (request.path.startsWith(`repos/${REPO}/issues?`)) {
      expect(request.path).toContain("state=all");
      expect(request.path).toContain("sort=created&direction=asc");
      expect(request.paginate).toBe(true);
      return parseGhApiOutput(JSON.stringify(pages), request);
    }
    const match = new RegExp(`^repos/${REPO}/issues/(\\d+)(.*)$`, "u").exec(request.path);
    if (match === null) throw new Error(`unexpected path ${request.path}`);
    if (match[2] === "/parent") throw new WorkGraphError("backend", "HTTP 404: Not Found");
    if (match[2] === "/dependencies/blocked_by") return [];
    if (match[2] === "" && current[match[1]] !== undefined) return current[match[1]];
    throw new Error(`unreadable issue ${match[1]}`);
  };
  return { store: createGitHubGraphStore({ repo: REPO, transport }), calls };
}

test("marker discovery scans all pages of live issues and includes closed, unattached matches", async () => {
  const first = Array.from({ length: 100 }, (_, index) => issue(index + 1, null));
  const { store, calls } = fixture([first, [
    issue(101), issue(102, MARKER, "closed"),
    issue(103, proposalMarker("errata-check-g10")),
    { ...issue(104), pull_request: {} },
  ]], { 101: issue(101), 102: issue(102, MARKER, "closed") });
  expect((await find(store)).map((node) => ({ id: node.ref.id, status: node.status, parent: node.parent }))).toEqual([
    { id: "101", status: "open", parent: undefined },
    { id: "102", status: "closed", parent: undefined },
  ]);
  expect(calls.some((call) => call.path.includes("search") || call.path === "graphql")).toBe(false);
  expect(calls.some((call) => call.path.endsWith("comments"))).toBe(false);
});

test("marker candidates are confirmed against the current body", async () => {
  const { store } = fixture([[issue(1)]], { 1: issue(1, "marker removed") });
  expect(await find(store)).toEqual([]);
});

test("an empty marker is refused before any API request", async () => {
  const { store, calls } = fixture([], {});
  await expect(store.findNodesByBodyMarker!("")).rejects.toThrow("marker must not be empty");
  expect(calls).toHaveLength(0);
});

test("listing and candidate read failures reject with the forge reason and repo", async () => {
  const listing = fixture([[issue(1)]], {}, (request) => {
    if (request.paginate) throw new Error("HTTP 403: page read denied");
  });
  await expect(find(listing.store)).rejects.toThrow(`${REPO}: HTTP 403: page read denied`);
  const candidate = fixture([[issue(1)]], {});
  await expect(find(candidate.store)).rejects.toThrow(`${REPO}: unreadable issue 1`);
});

test("a malformed listing cannot silently hide a marker", async () => {
  const { store } = fixture([[{ number: 1 }]], {});
  await expect(find(store)).rejects.toThrow("missing issue body");
});
