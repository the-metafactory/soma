import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  bootstrapSomaHome,
  getCriteria,
  parseIsa,
  reconcileIsa,
  reconcileIsaArtifacts,
  scaffoldIsa,
  serializeIsa,
  somaMemoryEventsPath,
  writeIsa,
} from "../src/index";
import { SECTION_NAME_MAP, getDecisions, getGoal, renderCriteriaMarkdown, renderLogEntries, setSection } from "../src/isa-accessors";
import type { AlgorithmLogEntry, IdealStateArtifact, IdealStateCriterion } from "../src/types";

async function withSomaHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-isa-reconcile-"));
  try {
    await bootstrapSomaHome({ homeDir });
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function buildIsa(slug: string, criteria: IdealStateCriterion[], sections: Record<string, string> = {}): IdealStateArtifact {
  const timestamp = "2026-05-17T00:00:00.000Z";
  const isa = parseIsa(
    [
      "---",
      `task: ${slug}`,
      "effort: E3",
      "phase: observe",
      `updated: ${timestamp}`,
      "---",
      "",
      "## Goal",
      "",
      `${slug} goal`,
      "",
      "## Criteria",
      "",
      renderCriteriaMarkdown(criteria),
      "",
    ].join("\n"),
  );
  return Object.entries(sections).reduce((current, [name, content]) => setSection(current, name, content), { ...isa, slug });
}

function decisions(...entries: AlgorithmLogEntry[]): string {
  return renderLogEntries(entries);
}

function criterion(id: string, status: IdealStateCriterion["status"], text = `${id} works`, verification?: string): IdealStateCriterion {
  return { id, text, status, verification };
}

test("AC-4 property: reconcile(master, master) is identity", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "open")], { Notes: "Keep me" });
  const result = reconcileIsaArtifacts(master, master);
  expect(serializeIsa(result.isa)).toBe(serializeIsa(master));
  expect(result.report.changed).toBe(false);
});

test("AC-4 property: no-op reconcile ignores timestamp-only changes", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "open")], { Notes: "Keep me" });
  const result = reconcileIsaArtifacts(master, master, { timestamp: "2026-05-17T11:00:00.000Z" });
  expect(serializeIsa(result.isa)).toBe(serializeIsa(master));
  expect(result.report.changed).toBe(false);
});

test("AC-4 property: no-op reconcile preserves existing log sections", () => {
  const entry = { timestamp: "2026-05-17T00:00:00.000Z", phase: "plan", text: "Keep exact log" } as const;
  const master = buildIsa("demo", [criterion("ISC-1", "open")], {
    [SECTION_NAME_MAP.decisions]: decisions(entry),
  });
  const result = reconcileIsaArtifacts(master, master);
  expect(serializeIsa(result.isa)).toBe(serializeIsa(master));
  expect(result.report.changed).toBe(false);
});

test("AC-5 property: reconcile is idempotent for the same feature", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "open")]);
  const feature = buildIsa("demo", [criterion("ISC-1", "passed", "ISC-1 works", "bun test passed"), criterion("ISC-2", "open")], {
    Notes: "Feature notes",
  });
  const once = reconcileIsaArtifacts(master, feature, { onConflict: "prefer-feature" }).isa;
  const twice = reconcileIsaArtifacts(once, feature, { onConflict: "prefer-feature" }).isa;
  expect(serializeIsa(twice)).toBe(serializeIsa(once));
});

test("AC-6 correctness: stable ISC IDs from feature land in master criteria", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "open")]);
  const feature = buildIsa("demo", [criterion("ISC-1", "passed", "ISC-1 works", "evidence"), criterion("ISC-2", "open")]);
  const result = reconcileIsaArtifacts(master, feature, { onConflict: "prefer-feature" });
  const criteria = getCriteria(result.isa);
  expect(criteria.map((c) => c.id)).toEqual(["ISC-1", "ISC-2"]);
  expect(criteria.find((c) => c.id === "ISC-1")?.status).toBe("passed");
  expect(criteria.find((c) => c.id === "ISC-1")?.verification).toBe("evidence");
});

test("invalid conflict policy rejects before merge resolution", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "passed", "Done", "evidence")]);
  const feature = buildIsa("demo", [criterion("ISC-1", "open", "Done")]);
  expect(() => reconcileIsaArtifacts(master, feature, { onConflict: "prefer-mistake" as never })).toThrow("Invalid ISA reconcile conflict policy");
});

test("adversarial 1: section added in feature appends when absent from master", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "open")], { [SECTION_NAME_MAP.constraints]: "Master constraint" });
  const feature = buildIsa("demo", [criterion("ISC-1", "open")], { Research: "Feature evidence" });
  const result = reconcileIsaArtifacts(master, feature);
  expect(result.isa.sections.find((s) => s.name === "Research")?.content).toBe("Feature evidence");
  expect(result.report.mergedLogs).toHaveLength(0);
});

test("adversarial 2: duplicate ISC IDs in master reject file-backed reconcile", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "dup", goal: "G", effort: "E1", initialCriteria: [criterion("ISC-1", "open")] });
    const master = buildIsa("dup", [criterion("ISC-1", "open")], { Extra: "- [ ] ISC-1: Duplicate" });
    await writeIsa("dup", master, { homeDir });
    const feature = buildIsa("dup", [criterion("ISC-2", "open")]);
    await expect(reconcileIsa("dup", feature, { homeDir })).rejects.toThrow("criterion-duplicate");
  });
});

test("adversarial 3: manual master edits are preserved under prefer-master", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "open")], { [SECTION_NAME_MAP.goal]: "Manual master goal" });
  const feature = buildIsa("demo", [criterion("ISC-2", "open")], { [SECTION_NAME_MAP.goal]: "Old feature goal" });
  const result = reconcileIsaArtifacts(master, feature, { onConflict: "prefer-master" });
  expect(getGoal(result.isa)).toBe("Manual master goal");
  expect(getCriteria(result.isa).map((c) => c.id)).toContain("ISC-2");
});

test("adversarial 4 and 5: whitespace normalization and header drift parse as same section", () => {
  const markdown = [
    "---",
    "task: drift",
    "effort: E1",
    "phase: observe",
    "---",
    "",
    "##  Goal   ",
    "",
    "Drift goal  ",
    "",
    "##   Criteria",
    "",
    "- [ ] ISC-1: Works   ",
    "",
  ].join("\n");
  const isa = parseIsa(markdown);
  expect(getGoal(isa)).toBe("Drift goal");
  expect(getCriteria(isa)[0]?.id).toBe("ISC-1");
});

test("adversarial 6: feature cannot regress passed master status by default", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "passed", "Done", "evidence")]);
  const feature = buildIsa("demo", [criterion("ISC-1", "open", "Done")]);
  const result = reconcileIsaArtifacts(master, feature, { onConflict: "prefer-master" });
  expect(getCriteria(result.isa)[0]?.status).toBe("passed");
  expect(result.report.conflicts.some((c) => c.kind === "criterion-status-regression")).toBe(true);
});

test("adversarial 7: conflicting Decisions timestamp errors unless policy resolves", () => {
  const entryA = { timestamp: "2026-05-17T00:00:00.000Z", phase: "plan", text: "Master decision" } as const;
  const entryB = { timestamp: "2026-05-17T00:00:00.000Z", phase: "plan", text: "Feature decision" } as const;
  const master = buildIsa("demo", [criterion("ISC-1", "open")], { [SECTION_NAME_MAP.decisions]: decisions(entryA) });
  const feature = buildIsa("demo", [criterion("ISC-1", "open")], { [SECTION_NAME_MAP.decisions]: decisions(entryB) });
  const errored = reconcileIsaArtifacts(master, feature);
  expect(errored.report.conflicts.some((c) => c.resolution === "error" && c.kind === "log-entry")).toBe(true);
  const resolved = reconcileIsaArtifacts(master, feature, { onConflict: "prefer-feature" });
  expect(getDecisions(resolved.isa).map((entry) => entry.text)).toEqual(["Master decision", "Feature decision"]);
});

test("adversarial 7: duplicate feature log keys merge at most one entry", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "open")]);
  const entryA = { timestamp: "2026-05-17T00:00:00.000Z", phase: "plan", text: "Feature decision A" } as const;
  const entryB = { timestamp: "2026-05-17T00:00:00.000Z", phase: "plan", text: "Feature decision B" } as const;
  const feature = buildIsa("demo", [criterion("ISC-1", "open")], { [SECTION_NAME_MAP.decisions]: decisions(entryA, entryB) });
  const resolved = reconcileIsaArtifacts(master, feature, { onConflict: "prefer-feature" });
  expect(getDecisions(resolved.isa).map((entry) => entry.text)).toEqual(["Feature decision A"]);
  expect(resolved.report.conflicts.some((conflict) => conflict.kind === "log-entry")).toBe(true);
});

test("adversarial 8: tombstoned criteria are preserved and never resurrected", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "dropped", "[DROPPED - see Decisions]")]);
  const feature = buildIsa("demo", [criterion("ISC-1", "passed", "Resurrected", "evidence")]);
  const result = reconcileIsaArtifacts(master, feature, { onConflict: "prefer-feature" });
  const merged = getCriteria(result.isa)[0];
  expect(merged?.status).toBe("dropped");
  expect(merged?.text).toContain("DROPPED");
});

test("feature-side dropped status obeys conflict policy", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "passed", "Done", "evidence")]);
  const feature = buildIsa("demo", [criterion("ISC-1", "dropped", "Drop it")]);
  const preferMaster = reconcileIsaArtifacts(master, feature, { onConflict: "prefer-master" });
  expect(getCriteria(preferMaster.isa)[0]?.status).toBe("passed");
  expect(preferMaster.report.conflicts.some((conflict) => conflict.kind === "criterion-status-regression")).toBe(true);

  const preferFeature = reconcileIsaArtifacts(master, feature, { onConflict: "prefer-feature" });
  expect(getCriteria(preferFeature.isa)[0]?.status).toBe("dropped");
});

test("adversarial 9: likely section rename conflicts instead of duplicating", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "open")], { "Acceptance Criteria": "Same body" });
  const feature = buildIsa("demo", [criterion("ISC-1", "open")], { "Verification Criteria": "Same body" });
  const result = reconcileIsaArtifacts(master, feature);
  expect(result.report.conflicts.some((c) => c.kind === "section-rename" && c.resolution === "error")).toBe(true);
  expect(result.isa.sections.some((s) => s.name === "Verification Criteria")).toBe(false);
});

test("error-policy conflicts return the original master artifact", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "passed", "Done", "evidence")], { Keep: "Master" });
  const feature = buildIsa("demo", [criterion("ISC-1", "open", "Done"), criterion("ISC-2", "open")], { Added: "Feature" });
  const result = reconcileIsaArtifacts(master, feature);
  expect(result.report.conflicts.some((conflict) => conflict.resolution === "error")).toBe(true);
  expect(result.report.changed).toBe(false);
  expect(result.report.mergedCriteria).toEqual([]);
  expect(serializeIsa(result.isa)).toBe(serializeIsa(master));
});

test("file-backed reconcile reads conflict policy from config and appends event report", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "cfg", goal: "G", effort: "E1", initialCriteria: [criterion("ISC-1", "open")] });
    const somaHome = join(homeDir, ".soma");
    await mkdir(join(somaHome, "isa"), { recursive: true });
    await writeFile(join(somaHome, "isa", "config.json"), '{"defaultConflictPolicy":"prefer-feature"}\n', "utf8");
    const featurePath = join(homeDir, "feature.md");
    await writeFile(featurePath, serializeIsa(buildIsa("cfg", [criterion("ISC-1", "passed", "ISC-1 works", "ok")])), "utf8");
    const result = await reconcileIsa("cfg", featurePath, { homeDir, timestamp: "2026-05-17T10:00:00.000Z" });
    expect(result.report.policy).toBe("prefer-feature");
    expect(getCriteria(result.isa)[0]?.status).toBe("passed");
    const events = (await readFile(somaMemoryEventsPath(somaHome), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; metadata?: { policy?: string; conflictCount?: number } });
    const event = [...events].reverse().find((candidate) => candidate.kind === "isa.reconcile");
    expect(event?.metadata?.policy).toBe("prefer-feature");
    expect(event?.metadata?.conflictCount).toBeGreaterThanOrEqual(0);
  });
});

test("correctness: master content untouched by feature stays present", () => {
  const master = buildIsa("demo", [criterion("ISC-1", "open")], { [SECTION_NAME_MAP.constraints]: "Do not lose this" });
  const feature = buildIsa("demo", [criterion("ISC-2", "open")]);
  const result = reconcileIsaArtifacts(master, feature);
  expect(result.isa.sections.find((s) => s.name === SECTION_NAME_MAP.constraints)?.content).toBe("Do not lose this");
});
