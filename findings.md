# Findings — node #1165: scoped graph read followups from PR #1164

Question: which followups from Soma PR #1164 improve scoped graph reads without
changing their permission boundary?

## Answer

Four PRs are worth doing, in this order. Each keeps the boundary as #1164 draws
it: the store authorizes an edge's identity before it reads the target's
content, and a scoped store never gains write authority.

| PR | Followups | What changes | Request budget, fixture tree (9 permitted nodes) |
| --- | --- | --- | --- |
| A | F9, F5 | GitLab: an owned selection builder and batched blocker status reads | scoped `readSubtree` 11 → 3 (unscoped reads 3) |
| B | F4, F7 | GitHub: one child-link read per node, parent taken from the walk, a memo for blocker status that lasts one call, bounded concurrency; a shared helper for root omissions | scoped `readSubtree` 54 → 28 |
| C | F6, F10 | CLI: one owner for the list of scoped read verbs and for the 100-root bound; both the parser and direct `runGraphCli` callers keep their checks | no change |
| D | F2 | A scoped store refuses every write before any transport call, instead of a separate read-only interface | no change |

F3 is optional and low value. F1, F8 and F11 are already resolved in the
reviewed head `0f1515577e3b0a37b3e8034212b06ccb13625951` and need no followup.

None of the four adds a second graph reader, a map registry, raw forge access
from Cortex, or a permission inferred from edges.

## Evidence base

- PR #1164 is open, not merged; head `0f15155`. I read its diff
  (`gh pr diff 1164`). The worktree base `cd0e4dc` does not contain it.
- I applied the PR's `src/` and `test/` hunks to a scratch copy outside this
  worktree. `test/graph/read-scope.test.ts` passes there: 15 pass, 0 fail.
- I counted requests with a recording transport on a synthetic tree. The script
  is in the appendix. Tree: root 1 has children 2, 3, 4 and a private child 90;
  2 has 5 and 6; 3 has 7 and 8; 4 has 9 and 10. Every node from 3 to 10 is
  blocked by permitted node 2 and by private node 91. All nodes are open, so no
  receipt reads occur. The transport also records any query that names a
  denied repository or namespace.

### Measured requests on #1164 head

| Read | Total | Distinct | Repeated | By kind |
| --- | --- | --- | --- | --- |
| GitHub scoped `readSubtree` | 54 | 37 | 17 | 19 subIssues, 17 REST issue, 9 parent, 9 blockedBy |
| GitHub scoped `WorkGraph.frontier` | 54 | 37 | 17 | same |
| GitHub scoped CLI `frontier --json` | 58 | 40 | 18 | adds a root `readNode` (4 requests) |
| GitLab unscoped `readSubtree` | 3 | 3 | 0 | 1 single and 2 batched `items` |
| GitLab scoped `readSubtree` | 11 | 4 | 7 | 9 single-item reads and 2 batched |

No scoped read sent a denied path to the transport (0 in every scoped row). The
unscoped GitLab read sent 1, the private child, as it should without a scope.

Where the GitHub repeats come from (`src/graph/work-graph-github.ts` at #1164 head):

- `scopedSubtree` calls `readNode(ref)`. That call reads `subIssues` to build
  `unavailableChildren`, and then `visit(ref)` reads `subIssues` again. That is
  9 duplicate reads.
- `readNode` reads the `parent` link even though the walk already knows the
  parent, which `scopedSubtree` then overwrites. That is 9 wasted reads.
- `fetchBlockers` makes one REST read per permitted blocker. Node 2's issue is
  read 8 more times, although the walk has just read it. That is 8 repeats.
- 54 − 9 − 9 − 8 = 28.

Where the GitLab repeats come from (`src/graph/work-graph-gitlab.ts`,
`scopedState`): the scoped selection strips `state` from linked targets, so
each permitted blocker is read again with `await this.item(ref)`, one at a
time. The fixture has 8 such reads, all for node 2, which is already in the
walk's `records`.

## Per-followup disposition

### F1: case-insensitive namespace matching. Resolved in #1164.

`permitsGraphRead` lowercases repository and namespace paths, and the test
`permitsGraphRead(scope, { path: "Example/Team/Project" })` is in
`test/graph/read-scope.test.ts`. No followup.

### F2: a separate read-only store interface. Rejected; do PR D instead.

A `Pick<GraphStore, …>` reader type does not bind:

1. The scoped verbs run through `WorkGraph`, which is constructed over
   `GraphStore`. A reader-typed `WorkGraph` would be a second graph reader,
   which the node rules out.
2. TypeScript types are structural, so a full store still satisfies a reader
   type. The interface would only document the contract.

The gap it would close is real but narrow. The GitHub `writePath` checks that
the target is in the store's repository, not that a read scope is absent. A
library caller that builds a scoped GitHub store can still `claim` or `close`
in the home repository. The CLI refuses this at both the parser and
`runGraphCli`; the store does not.

PR D adds a write check at the store. Every write method on both stores
refuses when `readScope` is set, before any transport call. On GitHub those
methods are `createNode`, `attachToParent`, `addBlockingEdge`, `claim`,
`release`, `postComment`, `editContent`, `writeRawBody` and `close`; GitLab has
the matching set. This tightens the boundary. Keep the GitLab destination
checks (`checkedParts` in writers) as they are; do not remove them for
symmetry. Nothing in #1164 writes through a scoped store (`createStore(repo,
scope)` is only reached by `maps` and the four read verbs), so no caller
breaks. If a future caller needs scoped writes, that is a new authority
decision, not a scope extension.

Test: for each store, a recording transport, and a call to every write method
on a scoped store. Each call rejects, and the transport records zero requests.

### F3: a dedicated unavailable-reference type. Optional, low value.

#1164 adds `unavailable?: true` to `NodeRef`, the most widely shared type, and
`"unavailable"` to `BlockingRef.status`. The status value should stay:
`blockerCleared` treats anything but `closed` as blocking, so a denied blocker
fails closed. That is the property that matters.

Moving the marker to `UnavailableRef { id; unavailable: true }`, used only by
`unavailableChildren`, a scoped `parent` and the membership report, narrows
`NodeRef` but gains no safety. Structural typing lets `UnavailableRef` flow
anywhere a `NodeRef` goes, and a denied ref passed to a scoped store is already
refused by `assertGraphRead` before transport. Do it only if PR B touches those
types anyway, and keep the JSON shape `{ "id", "unavailable": true }` unchanged
for consumers.

### F4: GitHub subtree throughput. Worthwhile; PR B.

Changes, all inside one `readSubtree` call:

1. Read each node's `subIssues` once, and use the result for both the walk and
   `unavailableChildren`. Restructure so that `scopedSubtree` builds the
   state, not `readNode`.
2. Take the parent from the walk. Do not issue the `parent` query inside
   `readSubtree`. A standalone `readNode` keeps it.
3. Memoize issue status per call: a `Map<id, Promise<GitHubIssue>>` created in
   `scopedSubtree` and discarded when it returns. A node read by the walk
   answers a later blocker lookup, and a blocker shared by several nodes is
   read once. Nothing is cached across calls, so every invocation stays as
   fresh as it is today.
4. Read siblings with bounded concurrency (8, as GitLab does). Keep the output
   in depth-first pre-order by assigning slots before awaiting.
   `limitConcurrency` is private to `work-graph-gitlab.ts`; move it to a shared
   graph module rather than copying it.

The identity-before-content order does not change. Link queries stay
identity-only (`number repository{nameWithOwner}`), and a REST issue read
happens only after `allowed(ref)`.

Budget: `1 + 3N + B` requests for N permitted descendants and B distinct
permitted blockers outside the walk, plus the existing receipt reads for
closed nodes. On the fixture, 28 instead of 54.

A further step, which PR B should measure but need not take: select
`subIssues` and `blockedBy` in one identity query per node, giving
`1 + 2N + B` (19 on the fixture). Take it only if the pagination checks stay
separate per connection.

Transport tests:

- A request-budget test on the fixture above asserts `≤ 28` total and zero
  repeated `(path, relation, number)` keys within one call.
- A permission test asserts that no GraphQL `owner/name` variable and no REST
  path names a denied repository.
- A freshness test makes two successive `readSubtree` calls with a node's
  state changed between them. The second call reports the new state.
- An order test with concurrency: the transport resolves sibling reads in
  reverse order, and the output order equals the unscoped depth-first
  pre-order.

### F5: serial GitLab blocker status reads. Worthwhile; PR A.

In `scopedState`, collect the distinct permitted blocker refs and answer each
from the walk's `records` when present. Read the rest through the existing
`items()` batch (6 per request, `limitConcurrency(8)`). `items()` already runs
`checkedParts` on every ref before building the query, so a denied namespace
cannot reach a request.

Budget: unscoped cost plus `ceil(B / 6)`, where B is the number of distinct
permitted blockers outside the walk. The fixture drops from 11 to 3.

Transport tests:

- The fixture asserts total requests `≤ 3` and that no `fullPath` or `pathN`
  variable ever names `example/private`.
- A second fixture has 13 distinct external permitted blockers and asserts
  exactly `ceil(13 / 6) = 3` blocker batches.

### F6: shared registry of scoped read verbs. Worthwhile; PR C.

#1164 spells `node | frontier | audit | decisions` twice as boolean chains: in
`parseGraphArgs` and in `runGraphCli`. Because they are chains, not arrays,
`check:literal-sets` does not see them. Add
`SCOPED_READ_ACTIONS = ["node", "frontier", "audit", "decisions"] as const`
with `isScopedReadAction()`, derive both checks from it, and keep both checks.
The `decisions --write` refusal stays in both places.

Test: call `runGraphCli` directly, without the parser, with a hand-built parsed
object for every action outside the list (and for `decisions` with `write:
true`), each carrying `readScope`. Each rejects, and an injected `createStore`
is never called.

### F7: shared assembly of scoped root omissions. Worthwhile, small; PR B.

`runFrontier` and `runDecisions` each re-read the root and merge
`unavailableChildren`. Extract one helper. The measured cost of that root read
is 4 GitHub requests (58 against 54). The helper keeps one root read; removing
it would mean changing the `readSubtree` contract to return the root's omitted
membership, which is not justified for 4 requests.

### F8: named `assertRepoReadable`. Resolved in #1164.

`GitHubGraphStore.assertRepoReadable()` exists at the reviewed head and guards
`findNodesByBodyMarker`, `listNodesByLabel`, `listOpenRoots`,
`listOpenNodeProbes`, `readComment` and `readCommentReactions`. No followup.

### F9: owned GitLab selection builder. Worthwhile, and the most important; PR A.

The scoped path removes linked-target `state` with
`baseFields.replace("fullPath} state workItemType", "fullPath} workItemType")`.
That edit is fragile in two ways:

- `String.prototype.replace` with a string pattern silently does nothing when
  the text changes, for example a reformatted `ITEM_FIELDS` or an added field
  between `fullPath}` and `state`. The test guarding it asserts the absence of
  the same literal, so it would still pass after such a change while `state`
  leaked again.
- It replaces only the first occurrence. Today there is exactly one in
  `ITEM_FIELDS` and in `SUBTREE_ITEM_FIELDS`. A second linked selection would
  leak.

Replace it with `itemSelection({ children: boolean, linkedTargetState:
boolean })`, which produces `ITEM_FIELDS`, `SUBTREE_ITEM_FIELDS` and the scoped
variants from one definition, so the scoped form is built rather than edited.

Tests:

- Keep the existing regression that linked targets expose identity without
  state before authorization.
- Add a structural assertion: extract every `workItem{…}` selection nested
  under `linkedItems` and under `children` from each emitted query, and assert
  that none contains `state`, `title` or `description` when the scope is set.
- Add a snapshot that unscoped queries are byte-identical to the current
  constants, so unscoped reads do not change.

### F10: hoisting the 100-root bound. Worthwhile only as part of PR C.

`parseMapsArgs` and `runMaps` both check `1 ≤ roots ≤ 100`. Hoist
`MAX_MAP_ROOTS = 100` beside `SCOPED_READ_ACTIONS` and keep both checks.

Test: a direct `runGraphCli` call with 101 roots rejects before any
`createStore` call.

### F11: CI-receipt routing prose. Resolved in #1164.

The PR body and the #1164 changelog hunk both say that CI-receipt verification
reads the check run in the node's own repository, including on unscoped
cross-repository reads, and rejects malformed check-run IDs. No followup.

## Sequencing and scope

- All four PRs follow #1164's release. None reopens the owner dependency.
- A comes first, because F9 removes a fragile edit on the security boundary and
  F5 changes the same function.
- B is independent of A. C and D are small and can land in either order after
  them.
- Each PR's close probe is its own test file (`bun test
  test/graph/read-scope.test.ts`, or a new sibling file), not the full suite.
- Out of scope, as the node requires: a second graph reader, a map registry,
  raw forge access from Cortex, a cache that lasts across calls, and any
  permission inferred from edges. The memo in PR B lasts one call and only
  answers status for refs that `allowed()` already passed.

## Appendix: measurement script

I ran this with Bun from a directory next to a scratch copy (`../work`) of
`cd0e4dc` with the `src/` and `test/` hunks of PR #1164 applied
(`git apply --include='src/*' --include='test/*'`).

```ts
import { createGitHubGraphStore, createGitLabGraphStore, parseRepoRef, WorkGraph, type GraphReadScope } from "../work/src/graph/index";
import { parseGraphArgs, runGraphCli } from "../work/src/cli/graph";

const block = '<!-- soma:work-graph-node\n{"autonomy":"approve","checkpointId":"scope"}\n-->';
const children: Record<number, [string, number][]> = { 1: [["A", 2], ["A", 3], ["A", 4], ["P", 90]], 2: [["A", 5], ["A", 6]], 3: [["A", 7], ["A", 8]], 4: [["A", 9], ["A", 10]] };
const blockers = (n: number): [string, number][] => n > 2 ? [["A", 2], ["P", 91]] : [];
const parentOf = (n: number) => Object.entries(children).find(([, cs]) => cs.some(([r, c]) => r === "A" && c === n))?.[0];

function report(label: string, calls: string[]) {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c, (counts.get(c) ?? 0) + 1);
  const dup = [...counts.values()].reduce((s, v) => s + (v - 1), 0);
  console.log(`${label}: total=${calls.length} unique=${counts.size} repeated=${dup}`);
}

const gh = parseRepoRef("github:github.com/example/allowed");
const ghScope: GraphReadScope = { repositories: [gh], namespaces: [] };
function ghStore(calls: string[], denied: string[]) {
  return createGitHubGraphStore({ repo: gh.path, readScope: ghScope, transport: async (request) => {
    if (request.path === "graphql") {
      const query = String(request.body?.query);
      const v = request.body?.variables as { owner: string; name: string; number: number };
      if (`${v.owner}/${v.name}` !== gh.path) denied.push(`${v.owner}/${v.name}`);
      const relation = query.includes("subIssues(") ? "subIssues" : query.includes("blockedBy(") ? "blockedBy" : "parent";
      calls.push(`gql ${relation} #${v.number}`);
      const id = ([r, n]: [string, number]) => ({ number: n, repository: { nameWithOwner: r === "A" ? gh.path : "example/private" } });
      if (relation === "parent") { const p = parentOf(v.number); return { data: { repository: { issue: { parent: p === undefined ? null : id(["A", Number(p)]) } } } }; }
      const nodes = (relation === "subIssues" ? children[v.number] ?? [] : blockers(v.number)).map(id);
      return { data: { repository: { issue: { [relation]: { nodes, pageInfo: { hasNextPage: false } } } } } };
    }
    if (!request.path.startsWith(`repos/${gh.path}/`)) denied.push(request.path);
    calls.push(`rest ${request.method} ${request.path}`);
    const number = Number(request.path.split("/").at(-1));
    return { id: number + 100, number, title: "Synthetic", body: block, state: "open", updated_at: "2026-11-09T00:00:00Z", user: { login: "fixture" }, assignees: [], html_url: `https://github.com/${gh.path}/issues/${number}` };
  } });
}
// GitHub: store.readSubtree({ id: "1" }), new WorkGraph(store).frontier({ id: "1" }),
// and runGraphCli(parseGraphArgs(["graph","frontier","github:github.com/example/allowed#1","--read-repo","github:github.com/example/allowed","--json"]), { createStore: () => store }).

const gl = parseRepoRef("gitlab:gitlab.example.test/example/allowed");
const glScope: GraphReadScope = { repositories: [gl], namespaces: [] };
const edge = (r: string, n: number) => ({ iid: String(n), namespace: { fullPath: r === "A" ? gl.path : "example/private" }, workItemType: { name: "Issue" } });
const glItem = (n: number) => ({ id: `gid://gitlab/WorkItem/${n}`, iid: String(n), workItemType: "Issue", namespace: { fullPath: gl.path }, title: "Synthetic", description: block, state: "OPEN", updatedAt: "2026-11-09T00:00:00Z", author: { username: "fixture" }, widgets: [
  { type: "ASSIGNEES", assignees: { nodes: [] } },
  { type: "HIERARCHY", children: { nodes: (children[n] ?? []).map(([r, c]) => edge(r, c)), pageInfo: { hasNextPage: false } } },
  { type: "LINKED_ITEMS", linkedItems: { nodes: blockers(n).map(([r, c]) => ({ linkType: "IS_BLOCKED_BY", workItem: edge(r, c) })), pageInfo: { hasNextPage: false } } },
] });
// GitLab: createGitLabGraphStore({ host: gl.host, readScope?: glScope, transport }) where the transport
// records each request's iid variables, flags any fullPath/pathN other than gl.path, and answers
// single (fullPath/iid) and batched (pathN/iidN -> itemN) queries from glItem; then readSubtree({ id: `${gl.path}#1` }).
```
