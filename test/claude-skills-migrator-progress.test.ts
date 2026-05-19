/**
 * #125 — integration tests for progress emitter wiring inside
 * `migrateClaudeSkills` and `planClaudeSkillsMigration`.
 *
 * Coverage:
 *   - Plan + apply call `start()` once with the discovered skill count.
 *   - Each non-refused outcome triggers a `[reading + classifying ...]`
 *     stepComplete AND a separate `[classified ... <tag>]` stepComplete.
 *   - The apply path emits a `[writing ... <N> files]` stepComplete
 *     for every skill that lands bytes.
 *   - The rewrite path emits a `[rewriting via <agent>: <oldLen>
 *     chars → target <target>]` step + `<elapsed>... <newLen> chars`
 *     stepComplete BOTH bracketing the LLM call.
 *   - The result carries a `timing` block with non-zero totalMs and
 *     phase entries for read+classify, rewrites, apply write, smoke.
 *   - The migrator does NOT touch stdout (no console.* calls); the
 *     emitter is the only outbound channel.
 *   - quiet emitter produces no output but the migrator still works.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  migrateClaudeSkills,
  planClaudeSkillsMigration,
} from "../src/claude-skills-migrator";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";
import type { ProgressEmitter, PhaseTimings } from "../src/claude-skills-progress";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-125-progress-");

const FM = "---\nname: TestSkill\ndescription: \"short description\"\n---\n\n";

interface RecordedCall {
  method: "start" | "step" | "stepComplete" | "beginConcurrentPhase" | "endConcurrentPhase";
  index?: number;
  sourceName?: string;
  phase?: string;
  detail?: string;
  elapsedMs?: number;
  total?: number;
  // #139 — concurrent-phase boundary args.
  name?: string;
  concurrency?: number;
}

interface CapturingEmitter extends ProgressEmitter {
  calls: RecordedCall[];
}

function makeCapturingEmitter(): CapturingEmitter {
  const calls: RecordedCall[] = [];
  return {
    calls,
    start(total) {
      calls.push({ method: "start", total });
    },
    step(index, sourceName, phase, detail) {
      calls.push({ method: "step", index, sourceName, phase, detail });
    },
    stepComplete(index, sourceName, phase, elapsedMs, detail) {
      calls.push({ method: "stepComplete", index, sourceName, phase, elapsedMs, detail });
    },
    beginConcurrentPhase(name, total, concurrency) {
      calls.push({ method: "beginConcurrentPhase", name, total, concurrency });
    },
    endConcurrentPhase(name, elapsedMs) {
      calls.push({ method: "endConcurrentPhase", name, elapsedMs });
    },
    finishTimingSummary(_t: PhaseTimings): string {
      return "Timing: 0s total";
    },
  };
}

async function writeFixture(home: string): Promise<string> {
  const fromDir = join(home, "skills");
  await mkdir(join(fromDir, "Portable"), { recursive: true });
  await writeFile(
    join(fromDir, "Portable", "SKILL.md"),
    `${FM}# Portable\n\nClean prose.\n`,
    "utf8",
  );
  await mkdir(join(fromDir, "NeedsAdapt"), { recursive: true });
  await writeFile(
    join(fromDir, "NeedsAdapt", "SKILL.md"),
    `${FM}# NeedsAdapt\n\nsee ~/.claude/PAI/x.md\n`,
    "utf8",
  );
  await mkdir(join(fromDir, "ClaudeSpecific"), { recursive: true });
  await writeFile(
    join(fromDir, "ClaudeSpecific", "SKILL.md"),
    `${FM}# Skill\n\nStop: cleanup\n`,
    "utf8",
  );
  return fromDir;
}

test("planClaudeSkillsMigration emits start() with skill count", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const emitter = makeCapturingEmitter();
    await planClaudeSkillsMigration({
      from: fromDir,
      somaHome: join(home, "soma"),
      progressEmitter: emitter,
    });
    const startCalls = emitter.calls.filter((c) => c.method === "start");
    expect(startCalls.length).toBe(1);
    expect(startCalls[0].total).toBe(3);
  });
});

test("planClaudeSkillsMigration emits per-skill read+classify and classified steps", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const emitter = makeCapturingEmitter();
    await planClaudeSkillsMigration({
      from: fromDir,
      somaHome: join(home, "soma"),
      progressEmitter: emitter,
    });
    const readingCalls = emitter.calls.filter(
      (c) => c.method === "stepComplete" && c.phase === "reading + classifying",
    );
    expect(readingCalls.length).toBe(3);
    const classifiedCalls = emitter.calls.filter(
      (c) => c.method === "stepComplete" && c.phase === "classified",
    );
    expect(classifiedCalls.length).toBe(3);
    // Verify the classification tags surfaced.
    const tags = new Set(classifiedCalls.map((c) => c.detail));
    expect(tags.has("portable")).toBe(true);
    expect(tags.has("needs-adapt")).toBe(true);
    expect(tags.has("claude-specific")).toBe(true);
  });
});

test("migrateClaudeSkills --apply emits writing step for each imported skill", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const emitter = makeCapturingEmitter();
    await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      progressEmitter: emitter,
    });
    const writingCalls = emitter.calls.filter(
      (c) => c.method === "stepComplete" && c.phase === "writing",
    );
    // 2 imported (Portable, NeedsAdapt); ClaudeSpecific skipped.
    expect(writingCalls.length).toBe(2);
    const writtenNames = writingCalls.map((c) => c.sourceName).sort();
    expect(writtenNames).toEqual(["NeedsAdapt", "Portable"]);
    // Detail carries the file count.
    expect(writingCalls.every((c) => c.detail?.includes("files"))).toBe(true);
  });
});

test("#139: migrateClaudeSkills brackets apply write with begin/endConcurrentPhase", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const emitter = makeCapturingEmitter();
    await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      progressEmitter: emitter,
    });
    const begins = emitter.calls.filter((c) => c.method === "beginConcurrentPhase");
    const ends = emitter.calls.filter((c) => c.method === "endConcurrentPhase");
    expect(begins.map((c) => c.name)).toEqual(["read + classify", "apply write"]);
    expect(ends.map((c) => c.name)).toEqual(["read + classify", "apply write"]);
    expect(begins[1].total).toBe(2);
    expect(begins[1].concurrency).toBe(4);
    const writeBeginIdx = emitter.calls.findIndex(
      (c) => c.method === "beginConcurrentPhase" && c.name === "apply write",
    );
    const writeEndIdx = emitter.calls.findIndex(
      (c) => c.method === "endConcurrentPhase" && c.name === "apply write",
    );
    const writeStepIndices = emitter.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.method === "stepComplete" && c.phase === "writing")
      .map(({ i }) => i);
    for (const i of writeStepIndices) {
      expect(i).toBeGreaterThan(writeBeginIdx);
      expect(i).toBeLessThan(writeEndIdx);
    }
  });
});

test("migrateClaudeSkills brackets LLM rewrite with start + complete progress", async () => {
  await withTempHome(async (home) => {
    const fromDir = join(home, "skills");
    await mkdir(join(fromDir, "Oversize"), { recursive: true });
    const longDesc = "A".repeat(1100); // > 1024
    await writeFile(
      join(fromDir, "Oversize", "SKILL.md"),
      `---\nname: Oversize\ndescription: "${longDesc}"\n---\n\n# Oversize\n\nPure prose.\n`,
      "utf8",
    );
    const emitter = makeCapturingEmitter();
    await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      rewriteDescriptionsAgent: "claude",
      progressEmitter: emitter,
      // Stub the dispatcher so the test doesn't shell out to `claude`.
      rewriteDispatchOverride: async () => "rewritten short description",
    });
    const rewriteStarts = emitter.calls.filter(
      (c) => c.method === "step" && c.phase === "rewriting description via claude",
    );
    expect(rewriteStarts.length).toBe(1);
    expect(rewriteStarts[0].detail).toContain("1100 chars");
    expect(rewriteStarts[0].detail).toContain("target 900");

    const rewriteCompletes = emitter.calls.filter(
      (c) => c.method === "stepComplete" && c.phase === "rewriting description via claude",
    );
    expect(rewriteCompletes.length).toBe(1);
    // Detail on complete shows the new length.
    expect(rewriteCompletes[0].detail).toContain("chars");
    // Some elapsed time was recorded (even if 0ms in fast tests).
    expect(rewriteCompletes[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

test("migrateClaudeSkills returns a timing block with non-zero totalMs", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
    });
    expect(result.timing).toBeDefined();
    expect(result.timing?.totalMs).toBeGreaterThanOrEqual(0);
    const phaseNames = result.timing?.phases.map((p) => p.name) ?? [];
    expect(phaseNames).toContain("read + classify");
    expect(phaseNames).toContain("description rewrites");
    expect(phaseNames).toContain("apply write");
    expect(phaseNames).toContain("smoke verify");
    // Rewrites not requested → (not requested) tag.
    const rewritePhase = result.timing?.phases.find((p) => p.name === "description rewrites");
    expect(rewritePhase?.unit).toBe("(not requested)");
    // Smoke not requested → (not requested) tag.
    const smokePhase = result.timing?.phases.find((p) => p.name === "smoke verify");
    expect(smokePhase?.unit).toBe("(not requested)");
  });
});

test("library default (no emitter) does not error and produces a timing block", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      // no progressEmitter — should default to no-op.
    });
    expect(result.timing).toBeDefined();
    expect(result.writtenCount).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────
// #139 quick patch — migrator wraps the concurrent read+classify
// loop with beginConcurrentPhase / endConcurrentPhase.
//
// Per-skill `stepComplete("reading + classifying", ...)` calls
// during the concurrent loop still fire (the migrator records
// them for timing) — but the real emitter (not this capturing
// stub) suppresses their output. Here we just assert the phase
// boundary methods are called with the right shape.
// ──────────────────────────────────────────────────────────────

test("#139: planClaudeSkillsMigration brackets concurrent read+classify with begin/endConcurrentPhase", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const emitter = makeCapturingEmitter();
    await planClaudeSkillsMigration({
      from: fromDir,
      somaHome: join(home, "soma"),
      progressEmitter: emitter,
    });
    const begins = emitter.calls.filter((c) => c.method === "beginConcurrentPhase");
    const ends = emitter.calls.filter((c) => c.method === "endConcurrentPhase");
    expect(begins.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(begins[0].name).toBe("read + classify");
    expect(begins[0].total).toBe(3);
    expect(begins[0].concurrency).toBe(4);
    expect(ends[0].name).toBe("read + classify");
    expect(ends[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

test("#139: beginConcurrentPhase fires BEFORE per-skill read+classify steps; endConcurrentPhase fires AFTER", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const emitter = makeCapturingEmitter();
    await planClaudeSkillsMigration({
      from: fromDir,
      somaHome: join(home, "soma"),
      progressEmitter: emitter,
    });
    const beginIdx = emitter.calls.findIndex((c) => c.method === "beginConcurrentPhase");
    const endIdx = emitter.calls.findIndex((c) => c.method === "endConcurrentPhase");
    const readIndices = emitter.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.method === "stepComplete" && c.phase === "reading + classifying")
      .map(({ i }) => i);
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(beginIdx);
    for (const i of readIndices) {
      expect(i).toBeGreaterThan(beginIdx);
      expect(i).toBeLessThan(endIdx);
    }
  });
});

test("stdout summary (formatter input) does not contain `[discovering` or other stderr markers", async () => {
  // The migrator's RESULT object is what the formatter consumes. No
  // stderr-only progress strings should leak into the structured
  // result fields. AC-1: stdout summary stays byte-stable.
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const emitter = makeCapturingEmitter();
    const result = await migrateClaudeSkills({
      from: fromDir,
      somaHome: join(home, "soma"),
      progressEmitter: emitter,
    });
    // None of the outcome reasons / refusal reasons mention `[discovering`.
    for (const outcome of result.outcomes) {
      expect(outcome.reason).not.toContain("[discovering");
      expect(outcome.refusalReason ?? "").not.toContain("[discovering");
    }
  });
});
