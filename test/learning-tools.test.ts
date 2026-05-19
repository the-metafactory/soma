import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  await withTempHome(async (homeDir, somaHome) => {
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
