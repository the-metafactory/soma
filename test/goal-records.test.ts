import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, spyOn, test } from "bun:test";
import { bootstrapSomaHome } from "../src/flows/index";
import { loadSomaHome } from "../src/home/index";
import { projectAnthropicCoworkHome } from "../src/substrates/adapters/anthropic-cowork";
import { projectClaudeCode } from "../src/substrates/adapters/claude-code";
import { projectCodex } from "../src/substrates/adapters/codex/adapter";
import { projectCursor } from "../src/substrates/adapters/cursor";
import { projectDsh } from "../src/substrates/adapters/dsh/adapter";
import { projectGrok } from "../src/substrates/adapters/grok/adapter";
import { projectPiDev } from "../src/substrates/adapters/pi-dev/adapter";
import { renderAssistantCore } from "../src/substrates/adapters/shared/index";
import type { GoalRecordWarning } from "../src/goal-records";
import type { GoalRecord } from "../src/goal-records";
import type { ProjectionInput } from "../src/home/index";
import { portableProjectionInput } from "./fixtures";

// soma#784 D2–D5, D7–D9: typed goal records in `profile/goals/G<n>.md`.

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PURPOSE = "# Purpose\n\nMission: m\n\n## Missions\n\n- M0 — build\n- M1 — autonomy\n";

async function homeWith(goalFiles: Record<string, string> | undefined): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-goals-"));
  homes.push(homeDir);
  const { somaHome } = await bootstrapSomaHome({ homeDir });
  await writeFile(join(somaHome, "profile/purpose.md"), PURPOSE, "utf8");
  if (goalFiles !== undefined) {
    await mkdir(join(somaHome, "profile/goals"), { recursive: true });
    for (const [name, content] of Object.entries(goalFiles)) {
      await writeFile(join(somaHome, "profile/goals", name), content, "utf8");
    }
  }
  return somaHome;
}

async function load(goalFiles: Record<string, string> | undefined): Promise<{ goals: GoalRecord[]; warnings: GoalRecordWarning[] }> {
  const warnings: GoalRecordWarning[] = [];
  const input = await loadSomaHome(await homeWith(goalFiles), {
    includeSkills: false,
    onGoalWarning: (warning) => warnings.push(warning),
  });
  return { goals: input.profile.purpose.goals, warnings };
}

function goal(frontmatter: string, body = "Publish one essay a month\n\nDrop if nobody reads them.\n"): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

const G5 = goal("id: G5\nstatus: active\nsupports: [M1]\nsensor: feed-check\nreview_by: 2026-12-31\npursuit_window: 7");

test("a G<n>.md file loads into purpose.goals with its fields, wording and body", async () => {
  const { goals, warnings } = await load({ "G5.md": G5 });
  expect(goals).toEqual([
    {
      id: "G5",
      status: "active",
      supports: ["M1"],
      sensor: "feed-check",
      reviewBy: "2026-12-31",
      pursuitWindow: 7,
      wording: "Publish one essay a month",
      body: "Publish one essay a month\n\nDrop if nobody reads them.\n",
    },
  ]);
  expect(warnings).toEqual([]);
});

test("no profile/goals directory yields no goals and no warning", async () => {
  const warn = spyOn(console, "warn");
  try {
    const somaHome = await homeWith(undefined);
    expect((await loadSomaHome(somaHome, { includeSkills: false })).profile.purpose.goals).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test.each([
  ["unknown status", "id: G6\nstatus: someday\nsupports: [M1]", "G6.md", "status"],
  ["id not matching G<n>", "id: goal-6\nstatus: draft", "G6.md", "id"],
  ["id differing from the file name", "id: G7\nstatus: draft", "G6.md", "id"],
  ["non-date review_by", "id: G6\nstatus: draft\nreview_by: next spring", "G6.md", "review_by"],
  ["non-positive pursuit_window", "id: G6\nstatus: draft\npursuit_window: 0", "G6.md", "pursuit_window"],
])("a file with %s is skipped with one warning, and the others still load", async (_case, frontmatter, file, field) => {
  const { goals, warnings } = await load({ "G5.md": G5, [file]: goal(frontmatter) });
  expect(goals.map((g) => g.id)).toEqual(["G5"]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.file).toBe(file);
  expect(warnings[0]?.field).toBe(field);
  expect(warnings[0]?.message).toContain(file);
  expect(warnings[0]?.message).toContain(field);
});

test("a skipped file warns through console.warn when no handler is given", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const somaHome = await homeWith({ "G6.md": goal("id: G6\nstatus: someday") });
    expect((await loadSomaHome(somaHome, { includeSkills: false })).profile.purpose.goals).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("G6.md");
  } finally {
    warn.mockRestore();
  }
});

test("an active goal without sensor or review_by loads, with a warning naming it", async () => {
  const { goals, warnings } = await load({
    "G8.md": goal("id: G8\nstatus: active\nsupports: [M0]\nreview_by: 2027-01-01"),
    "G9.md": goal("id: G9\nstatus: active\nsupports: [M0]"),
  });
  expect(goals.map((g) => g.id)).toEqual(["G8", "G9"]);
  expect(warnings.map((w) => [w.file, w.field])).toEqual([
    ["G8.md", "sensor"],
    ["G9.md", "sensor, review_by"],
  ]);
  expect(warnings[0]?.message).toContain("G8");
});

test("a supports code no mission starts with loads, with one warning naming the code", async () => {
  const { goals, warnings } = await load({
    "G5.md": goal("id: G5\nstatus: draft\nsupports: [M1, M9]"),
  });
  expect(goals.map((g) => g.supports)).toEqual([["M1", "M9"]]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.field).toBe("supports");
  expect(warnings[0]?.message).toContain("M9");
});

test("sweep.yaml and files not named G<n>.md are ignored by the loader", async () => {
  const { goals, warnings } = await load({
    "G5.md": G5,
    "sweep.yaml": "repos:\n  - the-metafactory/soma\n",
    "README.md": "notes",
    "G5.md.bak": "junk",
    "g6.md": goal("id: G6\nstatus: active"),
  });
  expect(goals.map((g) => g.id)).toEqual(["G5"]);
  expect(warnings).toEqual([]);
});

function withGoals(goals: GoalRecord[]): ProjectionInput {
  return {
    ...portableProjectionInput,
    profile: {
      ...portableProjectionInput.profile,
      purpose: { ...portableProjectionInput.profile.purpose, goals },
    },
  };
}

const record = (id: string, status: GoalRecord["status"], supports: string[] = ["M1"]): GoalRecord => ({
  id,
  status,
  supports,
  wording: `wording of ${id}`,
  body: `wording of ${id}\n`,
});

const EVERY_STATUS = [
  record("G12", "active", ["M0", "M1"]),
  record("G5", "draft"),
  record("G6", "paused"),
  record("G7", "achieved"),
  record("G8", "dropped"),
  record("G9", "active"),
];

test("the shared renderer projects only active goals, in id order, under Goals", () => {
  const core = renderAssistantCore(withGoals(EVERY_STATUS));
  expect(core).toContain("Goals:\n- G9: wording of G9 (supports M1)\n- G12: wording of G12 (supports M0, M1)\n");
  for (const id of ["G5", "G6", "G7", "G8"]) expect(core).not.toContain(`wording of ${id}`);
});

test("every adapter carries the active goals through the shared core", () => {
  const input = withGoals(EVERY_STATUS);
  const bundles = {
    "claude-code": projectClaudeCode(input),
    cursor: projectCursor(input),
    "anthropic-cowork": projectAnthropicCoworkHome(input),
    codex: projectCodex(input),
    dsh: projectDsh(input),
    grok: projectGrok(input),
    "pi-dev": projectPiDev(input),
  };
  for (const [name, bundle] of Object.entries(bundles)) {
    const texts = [bundle.instructions, ...bundle.files.map((file) => file.content)].join("\n");
    expect(texts, name).toContain("G9: wording of G9 (supports M1)");
    expect(texts, name).not.toContain("wording of G5");
  }
  const purpose = projectAnthropicCoworkHome(input).files.find((file) => file.content.includes("## Missions"));
  expect(purpose?.content).toContain("## Goals\n\n- G9: wording of G9 (supports M1)\n- G12: wording of G12 (supports M0, M1)");
});

test("no active goal renders no Goals heading", () => {
  const core = renderAssistantCore(withGoals([record("G5", "draft")]));
  expect(core).not.toMatch(/^Goals:$/m);
});
