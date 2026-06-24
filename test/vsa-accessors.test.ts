import { expect, test } from "bun:test";
import type { VerificationStateArtifact, Checkpoint } from "../src/index";
import {
  SECTION_NAME_MAP,
  appendCriterion,
  appendVsaChangelog,
  appendVsaDecision,
  appendVsaVerification,
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
} from "../src/vsa-accessors";

function buildVsa(): VerificationStateArtifact {
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
  const isa = buildVsa();
  expect(getGoal(isa)).toBe("Demo derived accessors.");
});

test("getGoal returns null when section is missing", () => {
  const isa: VerificationStateArtifact = { ...buildVsa(), sections: [] };
  expect(getGoal(isa)).toBeNull();
});

test("getCriteria parses checkbox markdown back into typed criteria", () => {
  const isa = buildVsa();
  const criteria = getCriteria(isa);
  expect(criteria).toHaveLength(2);
  expect(criteria[0]).toMatchObject({ id: "C1", text: "First", status: "open" });
  expect(criteria[1]).toMatchObject({ id: "C2", text: "Second", status: "open" });
});

test("updateCriterion rewrites the Criteria section content", () => {
  const isa = buildVsa();
  const next = updateCriterion(isa, "C1", "passed", "Test evidence");
  const criteria = getCriteria(next);
  expect(criteria[0]).toMatchObject({ id: "C1", status: "passed", verification: "Test evidence" });
  expect(criteria[1]?.status).toBe("open");
});

test("updateCriterion throws for unknown criterion id", () => {
  const isa = buildVsa();
  expect(() => updateCriterion(isa, "CX", "passed")).toThrow("Algorithm criterion not found: CX");
});

test("appendCriterion adds a new criterion at the end", () => {
  const isa = buildVsa();
  const next = appendCriterion(isa, { id: "C3", text: "Third", status: "open" });
  expect(getCriteria(next)).toHaveLength(3);
});

test("appendCriterion refuses duplicate id", () => {
  const isa = buildVsa();
  expect(() => appendCriterion(isa, { id: "C1", text: "dup", status: "open" })).toThrow("already exists");
});

test("recomputeProgress reflects passed and dropped criteria", () => {
  const isa = updateCriterion(buildVsa(), "C1", "passed", "ok");
  expect(recomputeProgress(isa)).toBe("1/2");
  const vsaAll = updateCriterion(isa, "C2", "dropped");
  expect(recomputeProgress(vsaAll)).toBe("2/2");
});

test("recomputeVerified true only when every criterion is passed or dropped", () => {
  const isa = buildVsa();
  expect(recomputeVerified(isa)).toBe(false);
  const partial = updateCriterion(isa, "C1", "passed", "ok");
  expect(recomputeVerified(partial)).toBe(false);
  const both = updateCriterion(partial, "C2", "passed", "ok");
  expect(recomputeVerified(both)).toBe(true);
});

test("setSection inserts a missing canonical section at the right index", () => {
  const isa: VerificationStateArtifact = {
    ...buildVsa(),
    sections: [{ name: SECTION_NAME_MAP.goal, content: "g" }],
  };
  const next = setSection(isa, SECTION_NAME_MAP.problem, "Problem statement");
  expect(next.sections.map((s) => s.name)).toEqual([SECTION_NAME_MAP.problem, SECTION_NAME_MAP.goal]);
});

test("appendVsaDecision / Changelog / Verification round-trip", () => {
  const entry = { timestamp: "2026-05-16T10:00:00.000Z", phase: "execute" as const, text: "did the thing" };
  const withDecision = appendVsaDecision(buildVsa(), entry);
  const withChangelog = appendVsaChangelog(withDecision, entry);
  const withVerify = appendVsaVerification(withChangelog, entry);
  expect(getDecisions(withVerify)).toEqual([entry]);
  expect(getChangelog(withVerify)).toEqual([entry]);
  expect(getVerification(withVerify)).toEqual([entry]);
  expect(getSection(withVerify, SECTION_NAME_MAP.decisions)?.content).toContain("did the thing");
});

test("renderLogEntries rejects newlines to prevent log-entry injection", async () => {
  const { renderLogEntries: renderLogs } = await import("../src/vsa-accessors");
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
  const original: Checkpoint[] = [
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
  const isa = buildVsa();
  const first = getCriteria(isa);
  const second = getCriteria(isa);
  expect(first).toEqual(second);
  expect(first).not.toBe(second); // each call returns a fresh array
});

// soma#329 slice 4: `## Criteria` → `## Checkpoints` (dual-read legacy, emit new).
function legacyCriteriaVsa(): VerificationStateArtifact {
  return {
    slug: "legacy",
    frontmatter: {
      task: "legacy task",
      effort: "E2",
      mode: "algorithm",
      phase: "observe",
      progress: "0/1",
      verified: false,
      updated: "2026-05-16T10:00:00.000Z",
    },
    // pre-rename heading authored on disk
    sections: [{ name: "Criteria", content: renderCriteriaMarkdown([{ id: "ISC-1", text: "Legacy", status: "open" }]) }],
  };
}

test("slice4: getCriteria dual-reads a legacy `Criteria` section", () => {
  const criteria = getCriteria(legacyCriteriaVsa());
  expect(criteria.map((c) => c.id)).toEqual(["ISC-1"]);
});

test("slice4: getSection(Checkpoints) resolves a legacy `Criteria` section", () => {
  expect(getSection(legacyCriteriaVsa(), SECTION_NAME_MAP.criteria)?.name).toBe("Criteria");
});

test("slice4: setCriteria-style write upgrades a legacy `Criteria` section in place (no duplicate)", () => {
  const upgraded = setSection(legacyCriteriaVsa(), SECTION_NAME_MAP.criteria, renderCriteriaMarkdown([{ id: "ISC-1", text: "Legacy", status: "passed" }]));
  const names = upgraded.sections.map((s) => s.name);
  expect(names).toContain("Checkpoints");
  expect(names).not.toContain("Criteria"); // renamed in place, not duplicated
  expect(names.filter((n) => n === "Checkpoints")).toHaveLength(1);
});

test("slice4: appendCriterion on a fresh VSA emits the canonical `Checkpoints` heading", () => {
  const isa: VerificationStateArtifact = { ...buildVsa(), sections: [{ name: SECTION_NAME_MAP.goal, content: "g" }] };
  const withCriterion = appendCriterion(isa, { id: "C1", text: "New", status: "open" });
  expect(withCriterion.sections.some((s) => s.name === "Checkpoints")).toBe(true);
  expect(withCriterion.sections.some((s) => s.name === "Criteria")).toBe(false);
});

test("slice4: setSection collapses a VSA carrying both Checkpoints and legacy Criteria", () => {
  const isa: VerificationStateArtifact = {
    ...buildVsa(),
    sections: [
      { name: SECTION_NAME_MAP.goal, content: "g" },
      { name: "Checkpoints", content: renderCriteriaMarkdown([{ id: "C1", text: "canon", status: "open" }]) },
      { name: "Criteria", content: renderCriteriaMarkdown([{ id: "OLD", text: "legacy", status: "open" }]) },
    ],
  };
  const updated = setSection(isa, SECTION_NAME_MAP.criteria, renderCriteriaMarkdown([{ id: "C1", text: "canon", status: "passed" }]));
  const names = updated.sections.map((s) => s.name);
  expect(names.filter((n) => n === "Checkpoints")).toHaveLength(1);
  expect(names).not.toContain("Criteria"); // stale legacy duplicate dropped, not orphaned
});
