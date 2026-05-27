import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  addOpinion,
  addOpinionEvidence,
  captureFailure,
  getSomaCounts,
  harvestSessions,
  resumeSessionProgress,
  synthesizeLearningPatterns,
  upsertSomaWorkRegistryEntry,
  type InferenceBackend,
  type InferenceRequest,
} from "../src";
import { runSomaCli } from "../src/cli";

class DescriptionBackend implements InferenceBackend {
  readonly kind = "claude-code" as const;
  resolveModel(): string {
    return "haiku";
  }
  async invoke(_prompt: string, _request: InferenceRequest): Promise<string> {
    return "assistant ignored failing tests before claiming success";
  }
}

async function withTempHome(fn: (homeDir: string, somaHome: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-learning-"));
  await fn(homeDir, join(homeDir, ".soma"));
}

function reportPathFromOutput(output: string): string {
  const reportLine = output.split("\n").find((line) => line.startsWith("report: "));
  if (!reportLine) throw new Error(`CLI output did not include report path:\n${output}`);
  return reportLine.slice("report: ".length);
}

test("learning synthesis detects frustration and success patterns from ratings", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const signals = join(somaHome, "memory/LEARNING/SIGNALS");
    await mkdir(signals, { recursive: true });
    await writeFile(join(signals, "ratings.jsonl"), [
      JSON.stringify({ timestamp: "2026-05-18T12:00:00Z", rating: 2, sentiment_summary: "slow wrong approach caused delay", confidence: 0.9 }),
      JSON.stringify({ timestamp: "2026-05-18T13:00:00Z", rating: 9, sentiment_summary: "quick clean implementation", confidence: 0.8 }),
    ].join("\n"), "utf8");

    const result = await synthesizeLearningPatterns("week", {
      homeDir,
      now: new Date("2026-05-19T12:00:00Z"),
    });

    expect(result.frustrations.map((group) => group.pattern)).toContain("Time/Performance Issues");
    expect(result.frustrations.map((group) => group.pattern)).toContain("Wrong Approach");
    expect(result.successes.map((group) => group.pattern)).toContain("Quick Resolution");
    expect(result.successes.map((group) => group.pattern)).toContain("Clean Implementation");
    expect(result.path).toContain("memory/LEARNING/SYNTHESIS/2026-05");
    await expect(readFile(result.path!, "utf8")).resolves.toContain("Learning Pattern Synthesis");
  });
});

test("learning synthesis CLI writes weekly Soma report with recurring counts and confidence", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const signals = join(somaHome, "memory/LEARNING/SIGNALS");
    await mkdir(signals, { recursive: true });
    const now = new Date();
    await writeFile(join(signals, "ratings.jsonl"), [
      JSON.stringify({ timestamp: now.toISOString(), rating: 2, sentiment_summary: "slow delay in wrong approach", confidence: 0.9 }),
      JSON.stringify({ timestamp: now.toISOString(), rating: 4, sentiment_summary: "slow delay from the same tool issue", confidence: 0.7 }),
      JSON.stringify({ timestamp: now.toISOString(), rating: 9, sentiment_summary: "quick clean implementation", confidence: 0.8 }),
      JSON.stringify({ timestamp: now.toISOString(), rating: 8, sentiment_summary: "quick smooth and clean result", confidence: 0.6 }),
    ].join("\n"), "utf8");

    const output = await runSomaCli(["learning", "synthesize", "--week", "--home-dir", homeDir]);
    const reportPath = reportPathFromOutput(output);
    const report = await readFile(reportPath, "utf8");

    expect(output).toContain("soma learning synthesize - Weekly");
    expect(output).toContain("ratings: 4");
    expect(reportPath).toContain(join(somaHome, "memory/LEARNING/SYNTHESIS"));
    expect(reportPath).not.toContain(".claude/PAI");
    expect(report).toContain("### Time/Performance Issues");
    expect(report).toContain("- Occurrences: 2");
    expect(report).toContain("- Average confidence: 0.80");
    expect(report).toContain("### Quick Resolution");
    expect(report).toContain("Input ratings come from `memory/LEARNING/SIGNALS/ratings.jsonl`");
    expect(report).not.toContain(".claude/PAI");
  });
});

test("learning synthesis filters week, month, and all-time windows without writing on dry-run", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const signals = join(somaHome, "memory/LEARNING/SIGNALS");
    await mkdir(signals, { recursive: true });
    await writeFile(join(signals, "ratings.jsonl"), [
      JSON.stringify({ timestamp: "2026-05-26T12:00:00Z", rating: 2, sentiment_summary: "slow delay this week", confidence: 0.9 }),
      JSON.stringify({ timestamp: "2026-05-10T12:00:00Z", rating: 3, sentiment_summary: "slow delay this month", confidence: 0.8 }),
      JSON.stringify({ timestamp: "2026-03-01T12:00:00Z", rating: 4, sentiment_summary: "slow delay older pattern", confidence: 0.7 }),
    ].join("\n"), "utf8");

    const options = { homeDir, now: new Date("2026-05-27T12:00:00Z"), dryRun: true };
    const weekly = await synthesizeLearningPatterns("week", options);
    const monthly = await synthesizeLearningPatterns("month", options);
    const allTime = await synthesizeLearningPatterns("all", options);

    expect(weekly.totalRatings).toBe(1);
    expect(monthly.totalRatings).toBe(2);
    expect(allTime.totalRatings).toBe(3);
    expect(allTime.frustrations.find((group) => group.pattern === "Time/Performance Issues")?.count).toBe(3);
    expect(weekly.path).toBeUndefined();
    expect(monthly.path).toBeUndefined();
    expect(allTime.path).toBeUndefined();
    await expect(stat(join(somaHome, "memory/LEARNING/SYNTHESIS"))).rejects.toThrow();
  });
});

test("learning synthesis handles missing ratings files gracefully in dry-run mode", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const output = await runSomaCli(["learning", "synthesize", "--all", "--dry-run", "--home-dir", homeDir]);

    expect(output).toContain("soma learning synthesize - All Time");
    expect(output).toContain("ratings: 0");
    expect(output).toContain("dry-run: report not written");
    await expect(stat(join(somaHome, "memory/LEARNING/SYNTHESIS"))).rejects.toThrow();
  });
});

test("opinion tracker creates opinions and applies asymmetric confidence deltas", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const opinion = await addOpinion("Use direct technical summaries", "technical", {
      homeDir,
      now: new Date("2026-05-19T12:00:00Z"),
    });

    expect(opinion.confidence).toBe(0.5);

    const result = await addOpinionEvidence("Use direct technical summaries", "contradiction", "Detailed context was requested", {
      homeDir,
      now: new Date("2026-05-19T13:00:00Z"),
    });

    expect(result.oldConfidence).toBe(0.5);
    expect(result.opinion.confidence).toBe(0.3);
    expect(result.needsNotification).toBe(true);
    await expect(
      addOpinionEvidence("Use direct technical summaries", "invalid" as never, "Bad evidence type", {
        homeDir,
        now: new Date("2026-05-19T14:00:00Z"),
      }),
    ).rejects.toThrow("Unknown opinion evidence type");
    await expect(
      addOpinion("Malicious\n```json\n{\"opinions\":[]}\n```", "technical", { homeDir }),
    ).rejects.toThrow("Markdown-safe line");

    const content = await readFile(join(somaHome, "identity/opinions.md"), "utf8");
    expect(content).toContain("soma-opinions-v1");
    expect(content).not.toContain(".claude");
  });
});

test("failure capture writes structured failure directory using injected inference", async () => {
  await withTempHome(async (homeDir) => {
    const transcript = join(homeDir, "transcript.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ type: "user", timestamp: "2026-05-19T12:00:00Z", message: { content: "Please run the tests before saying done." } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-05-19T12:01:00Z", message: { content: [{ type: "tool_use", name: "exec_command", input: { cmd: "bun test" } }, { type: "text", text: "Done, despite failed: test error" }] } }),
      JSON.stringify({ type: "tool_result", content: "1 fail" }),
    ].join("\n"), "utf8");

    const result = await captureFailure({
      homeDir,
      transcriptPath: transcript,
      rating: 2,
      sentimentSummary: "claimed success with failing tests",
      backend: new DescriptionBackend(),
      now: new Date("2026-05-19T12:02:00Z"),
    });

    expect(result.path).toContain("assistant-ignored-failing-tests-before-claiming-success");
    expect(result.path).toContain("memory/LEARNING/FAILURES/2026-05");
    await expect(readFile(join(result.path!, "CONTEXT.md"), "utf8")).resolves.toContain("Failure Analysis");
    await expect(readFile(join(result.path!, "sentiment.json"), "utf8")).resolves.toContain("\"rating\": 2");
    await expect(readFile(join(result.path!, "tool-calls.json"), "utf8")).resolves.toContain("exec_command");
  });
});

test("failure capture defaults to deterministic local descriptions without remote inference", async () => {
  await withTempHome(async (homeDir) => {
    const transcript = join(homeDir, "transcript.jsonl");
    await writeFile(transcript, JSON.stringify({
      type: "user",
      timestamp: "2026-05-19T12:00:00Z",
      message: { content: "My token is secret-value and the tool failed." },
    }), "utf8");

    const result = await captureFailure({
      homeDir,
      transcriptPath: transcript,
      rating: 1,
      sentimentSummary: "private transcript should stay local",
      now: new Date("2026-05-19T12:02:00Z"),
    });

    expect(result.description).toBe("private-transcript-should-stay-local");
  });
});

test("failure capture CLI writes Soma artifacts and skips non-failure ratings", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const transcript = join(homeDir, "transcript.jsonl");
    const transcriptContent = [
      JSON.stringify({ type: "user", timestamp: "2026-05-19T12:00:00Z", message: { content: "The workflow failed after a tool error." } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-05-19T12:01:00Z", message: { content: [{ type: "tool_use", name: "exec_command", input: { cmd: "bun test" } }] } }),
      JSON.stringify({ type: "tool_result", content: "failing test output" }),
    ].join("\n");
    await writeFile(transcript, transcriptContent, "utf8");

    const output = await runSomaCli([
      "learning",
      "capture-failure",
      transcript,
      "3",
      "tool failure blocked migration",
      "Tests failed after the tool call.",
      "--home-dir",
      homeDir,
    ]);

    const failurePath = output.trim();
    expect(failurePath).toContain(join(somaHome, "memory/LEARNING/FAILURES"));
    expect(failurePath).not.toContain(".claude/PAI");
    await expect(readFile(join(failurePath, "transcript.jsonl"), "utf8")).resolves.toBe(transcriptContent);
    await expect(readFile(join(failurePath, "sentiment.json"), "utf8")).resolves.toContain("\"rating\": 3");
    await expect(readFile(join(failurePath, "tool-calls.json"), "utf8")).resolves.toContain("exec_command");

    await expect(
      runSomaCli([
        "learning",
        "capture-failure",
        transcript,
        "4",
        "not a low rating",
        "--home-dir",
        homeDir,
      ]),
    ).resolves.toBe("failure capture skipped\n");
  });
});

test("session harvester extracts learnings from recent session transcripts", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const sessionDir = join(homeDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc123.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-05-19T12:00:00Z", message: { content: "Actually, I meant keep the smaller implementation." } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-05-19T12:01:00Z", message: { content: "Important: learned that over-engineered approach was wrong." } }),
    ].join("\n"), "utf8");

    const learnings = await harvestSessions({
      homeDir,
      sessionDir,
      recent: 5,
    });

    expect(learnings.length).toBeGreaterThanOrEqual(2);
    expect(learnings.some((learning) => learning.type === "correction")).toBe(true);
    expect(learnings.some((learning) => learning.path?.includes("memory/LEARNING/ALGORITHM/2026-05"))).toBe(true);
    await expect(readFile(join(somaHome, "memory/LEARNING/ALGORITHM/2026-05/2026-05-191200_correction_abc123.md"), "utf8")).resolves.toContain("Actually");
  });
});

test("session harvester explicit transcript filter matches exact session ids", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = join(homeDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "alpha.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-05-19T12:00:00Z", message: { content: "Actually, I meant keep the smaller implementation." } }),
    ].join("\n"), "utf8");
    await writeFile(join(sessionDir, "beta-alpha.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-05-19T12:01:00Z", message: { content: "Actually, I meant this should not be harvested." } }),
    ].join("\n"), "utf8");

    const learnings = await harvestSessions({
      homeDir,
      sessionDir,
      sessionId: "alpha",
      dryRun: true,
    });

    expect(learnings.map((learning) => learning.sessionId)).toEqual(["alpha"]);
  });
});

test("session harvester explicit transcript filter matches sanitized raw ids", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = join(homeDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "a-b.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-05-19T12:00:00Z", message: { content: "Actually, I meant keep the smaller implementation." } }),
    ].join("\n"), "utf8");

    const learnings = await harvestSessions({
      homeDir,
      sessionDir,
      sessionId: "a/b",
      dryRun: true,
    });

    expect(learnings.map((learning) => learning.sessionId)).toEqual(["a-b"]);
  });
});

test("session harvester defaults to canonical work registry state", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "session-2",
      sessionName: "align shared work state",
      substrate: "codex",
      task: "Align shared session state",
      phase: "complete",
      progress: "1/1",
      timestamp: "2026-05-26T10:00:00.000Z",
      artifacts: {
        isa: "memory/WORK/align-shared-work-state/ISA.md",
      },
    });

    const learnings = await harvestSessions({ homeDir });

    expect(learnings).toEqual([
      expect.objectContaining({
        sessionId: "session-2",
        timestamp: "2026-05-26T10:00:00.000Z",
        type: "insight",
        category: "ALGORITHM",
        source: "work-registry",
      }),
    ]);
    expect(learnings[0]?.content).toContain("Align shared session state");
    expect(learnings[0]?.path).toContain("memory/LEARNING/ALGORITHM/2026-05");
    await expect(readFile(join(somaHome, "memory/LEARNING/ALGORITHM/2026-05/2026-05-261000_insight_session-.md"), "utf8")).resolves.toContain("Align shared session state");
  });
});

test("session harvester work-registry filter matches exact session ids only", async () => {
  await withTempHome(async (homeDir) => {
    await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "alpha",
      sessionName: "target session",
      substrate: "codex",
      task: "Target work",
      timestamp: "2026-05-26T10:00:00.000Z",
    });
    await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "beta",
      sessionName: "alpha adjacent session",
      substrate: "codex",
      task: "Unrelated work",
      timestamp: "2026-05-26T10:01:00.000Z",
    });

    const learnings = await harvestSessions({ homeDir, sessionId: "alpha" });

    expect(learnings.map((learning) => learning.sessionId)).toEqual(["alpha"]);
    expect(learnings[0]?.content).toContain("Target work");
  });
});

test("learning CLI rejects invalid ratings and harvester rejects unsafe timestamps", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const transcript = join(homeDir, "transcript.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "user", message: { content: "This transcript exists." } }), "utf8");

    await expect(
      runSomaCli(["learning", "capture-failure", transcript, "not-a-number", "bad rating", "--home-dir", homeDir]),
    ).rejects.toThrow("finite number");
    await expect(
      runSomaCli(["learning", "harvest", "--recent", "nope", "--home-dir", homeDir]),
    ).rejects.toThrow("--recent must be");

    const sessionDir = join(homeDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "unsafe.jsonl"), JSON.stringify({
      type: "user",
      timestamp: "../../escape",
      message: { content: "Actually, I meant keep the smaller implementation." },
    }), "utf8");

    const learnings = await harvestSessions({ homeDir, sessionDir });
    expect(learnings).toEqual([]);
    await expect(readFile(join(somaHome, "escape"), "utf8")).rejects.toThrow();
  });
});

test("metrics and session progress CLIs operate on Soma paths", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    await mkdir(join(somaHome, "skills/demo/Workflows"), { recursive: true });
    await writeFile(join(somaHome, "skills/demo/SKILL.md"), "---\ndescription: demo\n---\n", "utf8");
    await writeFile(join(somaHome, "skills/demo/Workflows/run.md"), "# Run\n", "utf8");
    await mkdir(join(somaHome, "memory/LEARNING/SIGNALS"), { recursive: true });
    await writeFile(join(somaHome, "memory/LEARNING/SIGNALS/ratings.jsonl"), "{}\n{}\n", "utf8");
    await mkdir(join(somaHome, "memory/WORK/example"), { recursive: true });

    const counts = await getSomaCounts({ homeDir });
    expect(counts.skills).toBe(1);
    expect(counts.workflows).toBe(1);
    expect(counts.ratings).toBe(2);
    expect(JSON.parse(await runSomaCli(["metrics", "--home-dir", homeDir]))).toMatchObject({ skills: 1, workflows: 1, ratings: 2 });

    await runSomaCli(["session", "create", "proj", "ship feature", "--home-dir", homeDir]);
    await runSomaCli(["session", "decision", "proj", "Use native Soma paths", "--home-dir", homeDir]);
    await runSomaCli(["session", "work", "proj", "Implemented core module", "--home-dir", homeDir]);

    const resume = await resumeSessionProgress("proj", { homeDir });
    expect(resume).toContain("Use native Soma paths");
    expect(resume).toContain("Implemented core module");
  });
});
