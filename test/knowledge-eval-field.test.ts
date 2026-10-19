import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/knowledge-eval";
import { appendSomaMemoryEvent } from "../src/events/index";
import {
  FieldUsageError,
  buildFieldReport,
  computeAgreement,
  drawSample,
  loadFieldSessions,
  parseLabelSheet,
  readFeedbackCandidates,
  runField,
  sampleGroup,
  storeRoot,
} from "../scripts/knowledge-eval-field";

const NOW = new Date("2026-10-19T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

type Line = Record<string, unknown>;

function user(text: string, at: string): Line {
  return { type: "user", timestamp: at, message: { role: "user", content: text } };
}

function assistant(text: string, at: string): Line {
  return { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } };
}

function toolResult(text: string, at: string): Line {
  return { type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } };
}

let root: string;
let projectsDir: string;
let somaHome: string;

function session(project: string, id: string, lines: Line[]): void {
  const dir = join(projectsDir, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

const SOMA = "-Users-x-work-mf-soma";
const RANGER = "-Users-x-work-mf-ranger";
const WORKER = "-Users-x-work-ranger-repos-the-metafactory-soma--worktrees-node-1";

function seedSessions(): void {
  session(SOMA, "s-soma-1", [
    user("Please add the field command to the eval script", daysAgo(2)),
    assistant("Done, added it.", daysAgo(2)),
    user("Actually, use the harvester instead of a new regex", daysAgo(2)),
    toolResult("error: actually, this stack trace mentions wait, and more filler", daysAgo(2)),
    user("Thanks that works now, ship it please", daysAgo(2)),
  ]);
  session(SOMA, "s-soma-2", [user("Summarise the open nodes for me please", daysAgo(5))]);
  session(RANGER, "s-ranger-1", [
    user("Wait, you misunderstood the request about the lane", daysAgo(10)),
    user("Run the full test suite before committing", daysAgo(10)),
  ]);
  session(WORKER, "s-worker-1", [user("Implement node 1 in this worktree as described", daysAgo(1))]);
  session(SOMA, "s-old", [user("Actually, this one is far outside the window", daysAgo(200))]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "field-eval-"));
  projectsDir = join(root, "projects");
  somaHome = join(root, "soma-home");
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(somaHome, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("field report", () => {
  test("counts principal corrections per project and overall, inside the window only", async () => {
    seedSessions();
    const sessions = await loadFieldSessions(projectsDir, { now: NOW, windowDays: 60 });
    const report = buildFieldReport(sessions, { total: 0, bySession: new Map() }, { now: NOW, windowDays: 60 });

    const soma = report.projects.find((project) => project.project === SOMA);
    expect(soma).toMatchObject({ sessions: 2, corrections: 1, correctionsPerSession: 0.5, sessionIds: ["s-soma-1", "s-soma-2"] });
    expect(report.projects.find((project) => project.project === RANGER)).toMatchObject({ sessions: 1, corrections: 1 });
    expect(report.overall).toMatchObject({ sessions: 4, corrections: 2, correctionsPerSession: 0.5 });
    expect(report.overall.sessionIds).not.toContain("s-old");
  });

  test("a session spanning the cutoff counts only its in-window corrections", async () => {
    session(SOMA, "s-span", [
      user("Actually, use the other approach instead", daysAgo(200)),
      user("Wait, you misunderstood the request", daysAgo(3)),
      user("Run the tests before committing please", daysAgo(1)),
    ]);
    const sessions = await loadFieldSessions(projectsDir, { now: NOW, windowDays: 60 });
    const spanning = sessions.find((candidate) => candidate.sessionId === "s-span");
    expect(spanning?.corrections).toBe(1);
    expect(spanning?.turns.map((turn) => turn.turn)).toEqual([2, 3]);
    const all = await loadFieldSessions(projectsDir, { now: NOW });
    expect(all.find((candidate) => candidate.sessionId === "s-span")?.corrections).toBe(2);
  });

  test("sessionIds restricts which transcripts are read", async () => {
    seedSessions();
    const sessions = await loadFieldSessions(projectsDir, { now: NOW, sessionIds: new Set(["s-soma-1", "s-old"]) });
    expect(sessions.map((candidate) => candidate.sessionId).sort()).toEqual(["s-old", "s-soma-1"]);
  });

  test("a tool result that matches a correction pattern is not a principal turn", async () => {
    seedSessions();
    const sessions = await loadFieldSessions(projectsDir, { now: NOW, windowDays: 60 });
    const first = sessions.find((candidate) => candidate.sessionId === "s-soma-1");
    expect(first?.turns).toHaveLength(3);
    expect(first?.corrections).toBe(1);
  });

  test("attaches in-window feedback.candidate events to their session", async () => {
    seedSessions();
    const candidate = (at: string, sessionId?: string) =>
      appendSomaMemoryEvent(somaHome, {
        timestamp: at,
        substrate: "claude-code",
        kind: "feedback.candidate",
        summary: "Feedback candidate captured: correction.",
        metadata: sessionId === undefined ? {} : { sessionId },
      });
    await candidate(daysAgo(2), "s-soma-1");
    await candidate(daysAgo(2), "s-soma-1");
    await candidate(daysAgo(3));
    await candidate(daysAgo(90), "s-soma-1");

    const candidates = await readFeedbackCandidates(somaHome, new Date(NOW.getTime() - 60 * 86400000));
    expect(candidates.total).toBe(3);
    const sessions = await loadFieldSessions(projectsDir, { now: NOW, windowDays: 60 });
    const report = buildFieldReport(sessions, candidates, { now: NOW, windowDays: 60 });
    expect(report.projects.find((project) => project.project === SOMA)?.feedbackCandidates).toBe(2);
    expect(report.overall.feedbackCandidates).toBe(2);
    expect(report.unmatchedFeedbackCandidates).toBe(1);
  });

  test("runField prints the report and writes nothing", async () => {
    seedSessions();
    const lines: string[] = [];
    await runField(["--window", "60", "--projects-dir", projectsDir, "--soma-home", somaHome], { now: NOW, write: (line) => lines.push(line) });
    const out = lines.join("\n");
    expect(out).toContain(SOMA);
    expect(out).toContain("corrections per session: 0.50");
    expect(out).toContain("s-soma-1, s-soma-2");
    expect(existsSync(storeRoot(somaHome))).toBe(false);
  });

  test("a missing transcripts directory is a usage error", async () => {
    await expect(loadFieldSessions(join(root, "nope"), { now: NOW })).rejects.toBeInstanceOf(FieldUsageError);
  });
});

describe("labelling sheet", () => {
  function manySessions(): void {
    for (let index = 0; index < 8; index++) {
      session(SOMA, `soma-${index}`, [user(`Soma session ${index}, actually do it differently`, daysAgo(3))]);
      session(RANGER, `ranger-${index}`, [user(`Ranger session ${index} please run the checks`, daysAgo(3))]);
      session(WORKER, `worker-${index}`, [user(`Worker session ${index} implement the node`, daysAgo(3))]);
    }
  }

  test("classifies project directories", () => {
    expect(sampleGroup(SOMA)).toBe("soma");
    expect(sampleGroup(RANGER)).toBe("ranger");
    expect(sampleGroup(WORKER)).toBe("ranger-worker");
    expect(sampleGroup("-Users-x-work-mf-arc")).toBeUndefined();
  });

  test("draws across the three groups, repeatably for a seed", async () => {
    manySessions();
    const sessions = await loadFieldSessions(projectsDir, { now: NOW, windowDays: 60 });
    const first = drawSample(sessions, 9, 7);
    const again = drawSample(sessions, 9, 7);
    expect(first.map((s) => s.sessionId)).toEqual(again.map((s) => s.sessionId));
    for (const group of ["soma", "ranger", "ranger-worker"]) {
      expect(first.filter((s) => sampleGroup(s.project) === group)).toHaveLength(3);
    }
    expect(drawSample(sessions, 9, 8).map((s) => s.sessionId)).not.toEqual(first.map((s) => s.sessionId));
  });

  test("--sample writes the sheet inside the store with unlabelled turns, and never overwrites it", async () => {
    manySessions();
    const argv = ["--sample", "6", "--seed", "3", "--projects-dir", projectsDir, "--soma-home", somaHome];
    const lines: string[] = [];
    await runField(argv, { now: NOW, write: (line) => lines.push(line) });

    const dir = join(storeRoot(somaHome), "field");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const sheet = parseLabelSheet(JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8")), "sheet");
    expect(sheet.sessions).toHaveLength(6);
    expect(sheet.sessions.every((s) => s.turns.length > 0 && s.turns.every((t) => t.correction === null))).toBe(true);
    expect(readdirSync(somaHome)).toEqual(["evals"]);

    await expect(runField(argv, { now: NOW, write: () => undefined })).rejects.toThrow("Refusing to overwrite");
  });

  test("--sample without --seed is refused", async () => {
    await expect(runField(["--sample", "5"], { now: NOW, write: () => undefined })).rejects.toThrow("--sample needs --seed");
  });
});

describe("agreement", () => {
  async function labelsFor(verdicts: Record<string, Record<number, boolean>>): Promise<string> {
    const path = join(root, "labels.json");
    writeFileSync(
      path,
      JSON.stringify({
        sessions: Object.entries(verdicts).map(([sessionId, turns]) => ({
          sessionId,
          turns: Object.entries(turns).map(([turn, correction]) => ({ turn: Number(turn), correction })),
        })),
      }),
    );
    return path;
  }

  test("keeps the arm when precision and recall both reach 0.7", async () => {
    seedSessions();
    const path = await labelsFor({ "s-soma-1": { 1: false, 2: true, 3: false }, "s-ranger-1": { 1: true, 2: false } });
    const lines: string[] = [];
    await runField(["--agree", path, "--projects-dir", projectsDir], { now: NOW, write: (line) => lines.push(line) });
    const out = lines.join("\n");
    expect(out).toContain("precision: 1.000");
    expect(out).toContain("recall: 1.000");
    expect(out).toContain("field arm: keep");
  });

  test("drops the arm below 0.7 and scores false positives and misses", async () => {
    seedSessions();
    const path = await labelsFor({ "s-soma-1": { 1: false, 2: false, 3: true }, "s-ranger-1": { 1: true, 2: true } });
    const lines: string[] = [];
    await runField(["--agree", path, "--projects-dir", projectsDir], { now: NOW, write: (line) => lines.push(line) });
    const out = lines.join("\n");
    expect(out).toContain("true positives: 1, false positives: 1, false negatives: 2, true negatives: 1");
    expect(out).toContain("precision: 0.500");
    expect(out).toContain("recall: 0.333");
    expect(out).toContain("field arm: drop");
  });

  test("scores sessions outside the report window", async () => {
    seedSessions();
    const path = await labelsFor({ "s-old": { 1: true } });
    const lines: string[] = [];
    await runField(["--agree", path, "--projects-dir", projectsDir], { now: NOW, write: (line) => lines.push(line) });
    expect(lines.join("\n")).toContain("field arm: keep");
  });

  test("an unknown session id fails naming the id", async () => {
    seedSessions();
    const path = await labelsFor({ "s-soma-1": { 1: false }, "ghost-session": { 1: true } });
    await expect(runField(["--agree", path, "--projects-dir", projectsDir], { now: NOW, write: () => undefined })).rejects.toThrow("ghost-session");
  });

  test("an unlabelled or out-of-range turn fails naming the session", async () => {
    seedSessions();
    const sessions = await loadFieldSessions(projectsDir, { now: NOW });
    const unlabelled = parseLabelSheet({ sessions: [{ sessionId: "s-soma-1", turns: [{ turn: 1, correction: null }] }] }, "x");
    expect(() => computeAgreement(unlabelled, sessions)).toThrow("Unlabelled turn 1 in session s-soma-1");
    const outOfRange = parseLabelSheet({ sessions: [{ sessionId: "s-soma-1", turns: [{ turn: 9, correction: true }] }] }, "x");
    expect(() => computeAgreement(outOfRange, sessions)).toThrow("Unknown turn 9 in session s-soma-1");
  });

  test("no detected corrections leaves precision undefined and drops the arm", async () => {
    seedSessions();
    const sessions = await loadFieldSessions(projectsDir, { now: NOW });
    const agreement = computeAgreement(parseLabelSheet({ sessions: [{ sessionId: "s-soma-2", turns: [{ turn: 1, correction: true }] }] }, "x"), sessions);
    expect(agreement.precision).toBeUndefined();
    expect(agreement.keep).toBe(false);
  });
});

describe("knowledge-eval entry", () => {
  test("rejects an unknown command", async () => {
    expect(await main(["bogus"])).toBe(2);
  });
});
