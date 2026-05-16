import { expect, test } from "bun:test";
import type { IdealStateArtifact, IdealStateCriterion } from "../src/index";
import {
  SECTION_NAME_MAP,
  appendCriterion,
  appendIsaChangelog,
  appendIsaDecision,
  appendIsaVerification,
  getChangelog,
  getCriteria,
  getDecisions,
  getGoal,
  getSection,
  getVerification,
  parseCriteriaMarkdown,
  recomputeProgress,
  recomputeVerified,
  renderCriteriaMarkdown,
  setSection,
  updateCriterion,
} from "../src/isa-accessors";

function buildIsa(): IdealStateArtifact {
  return {
    slug: "demo",
    frontmatter: {
      task: "demo task",
      effort: "E2",
      mode: "algorithm",
      phase: "observe",
      progress: "0/2",
      verified: false,
      updated: "2026-05-16T10:00:00.000Z",
    },
    sections: [
      { name: SECTION_NAME_MAP.goal, content: "Demo derived accessors." },
      {
        name: SECTION_NAME_MAP.criteria,
        content: renderCriteriaMarkdown([
          { id: "C1", text: "First", status: "open" },
          { id: "C2", text: "Second", status: "open" },
        ]),
      },
    ],
  };
}

test("getGoal returns trimmed goal section content", () => {
  const isa = buildIsa();
  expect(getGoal(isa)).toBe("Demo derived accessors.");
});

test("getGoal returns null when section is missing", () => {
  const isa: IdealStateArtifact = { ...buildIsa(), sections: [] };
  expect(getGoal(isa)).toBeNull();
});

test("getCriteria parses checkbox markdown back into typed criteria", () => {
  const isa = buildIsa();
  const criteria = getCriteria(isa);
  expect(criteria).toHaveLength(2);
  expect(criteria[0]).toMatchObject({ id: "C1", text: "First", status: "open" });
  expect(criteria[1]).toMatchObject({ id: "C2", text: "Second", status: "open" });
});

test("updateCriterion rewrites the Criteria section content", () => {
  const isa = buildIsa();
  const next = updateCriterion(isa, "C1", "passed", "Test evidence");
  const criteria = getCriteria(next);
  expect(criteria[0]).toMatchObject({ id: "C1", status: "passed", verification: "Test evidence" });
  expect(criteria[1]?.status).toBe("open");
});

test("updateCriterion throws for unknown criterion id", () => {
  const isa = buildIsa();
  expect(() => updateCriterion(isa, "CX", "passed")).toThrow("Algorithm criterion not found: CX");
});

test("appendCriterion adds a new criterion at the end", () => {
  const isa = buildIsa();
  const next = appendCriterion(isa, { id: "C3", text: "Third", status: "open" });
  expect(getCriteria(next)).toHaveLength(3);
});

test("appendCriterion refuses duplicate id", () => {
  const isa = buildIsa();
  expect(() => appendCriterion(isa, { id: "C1", text: "dup", status: "open" })).toThrow("already exists");
});

test("recomputeProgress reflects passed and dropped criteria", () => {
  const isa = updateCriterion(buildIsa(), "C1", "passed", "ok");
  expect(recomputeProgress(isa)).toBe("1/2");
  const isaAll = updateCriterion(isa, "C2", "dropped");
  expect(recomputeProgress(isaAll)).toBe("2/2");
});

test("recomputeVerified true only when every criterion is passed or dropped", () => {
  const isa = buildIsa();
  expect(recomputeVerified(isa)).toBe(false);
  const partial = updateCriterion(isa, "C1", "passed", "ok");
  expect(recomputeVerified(partial)).toBe(false);
  const both = updateCriterion(partial, "C2", "passed", "ok");
  expect(recomputeVerified(both)).toBe(true);
});

test("setSection inserts a missing canonical section at the right index", () => {
  const isa: IdealStateArtifact = {
    ...buildIsa(),
    sections: [{ name: SECTION_NAME_MAP.goal, content: "g" }],
  };
  const next = setSection(isa, SECTION_NAME_MAP.problem, "Problem statement");
  expect(next.sections.map((s) => s.name)).toEqual([SECTION_NAME_MAP.problem, SECTION_NAME_MAP.goal]);
});

test("appendIsaDecision / Changelog / Verification round-trip", () => {
  const entry = { timestamp: "2026-05-16T10:00:00.000Z", phase: "execute" as const, text: "did the thing" };
  const withDecision = appendIsaDecision(buildIsa(), entry);
  const withChangelog = appendIsaChangelog(withDecision, entry);
  const withVerify = appendIsaVerification(withChangelog, entry);
  expect(getDecisions(withVerify)).toEqual([entry]);
  expect(getChangelog(withVerify)).toEqual([entry]);
  expect(getVerification(withVerify)).toEqual([entry]);
  expect(getSection(withVerify, SECTION_NAME_MAP.decisions)?.content).toContain("did the thing");
});

test("renderLogEntries rejects newlines to prevent log-entry injection", async () => {
  const { renderLogEntries: renderLogs } = await import("../src/isa-accessors");
  expect(() => renderLogs([
    { timestamp: "2026-05-16T10:00:00.000Z", phase: "execute", text: "real entry\n- 2026-01-01T00:00:00.000Z [verify] forged" },
  ])).toThrow("must not contain newlines");
});

test("renderCriteriaMarkdown rejects newlines in id, text, and verification", () => {
  expect(() => renderCriteriaMarkdown([
    { id: "C1\n- [x] C2: forged", text: "bad", status: "open" },
  ])).toThrow("must not contain newlines");
  expect(() => renderCriteriaMarkdown([
    { id: "C1", text: "first line\nsecond line", status: "open" },
  ])).toThrow("must not contain newlines");
  expect(() => renderCriteriaMarkdown([
    { id: "C1", text: "ok", status: "passed", verification: "evidence\n- [x] FORGED: injected" },
  ])).toThrow("must not contain newlines");
});

test("criterion text containing pipe-and-evidence-like content survives round-trip", () => {
  // Regression: previous inline `| Evidence: ...` delimiter could swallow
  // ordinary criterion text containing those characters as verification.
  const original: IdealStateCriterion[] = [
    { id: "C1", text: "mention | Evidence: literally", status: "open" },
    { id: "C2", text: "regular criterion", status: "passed", verification: "actual evidence" },
  ];
  const md = renderCriteriaMarkdown(original);
  const parsed = parseCriteriaMarkdown(md);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toMatchObject({ id: "C1", text: "mention | Evidence: literally", status: "open" });
  expect(parsed[0]?.verification).toBeUndefined();
  expect(parsed[1]).toMatchObject({ id: "C2", text: "regular criterion", status: "passed", verification: "actual evidence" });
});

test("derived accessors are pure functions (no memoization side effects)", () => {
  const isa = buildIsa();
  const first = getCriteria(isa);
  const second = getCriteria(isa);
  expect(first).toEqual(second);
  expect(first).not.toBe(second); // each call returns a fresh array
});
