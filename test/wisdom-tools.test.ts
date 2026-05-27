import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  classifyDomains,
  listFrames,
  synthesizeWisdom,
  updateFrame,
} from "../src";
import { runSomaCli } from "../src/cli";
import { jaccardSimilarity, loadRelevantFrames } from "../src/tools/wisdom";

async function withTempHome(fn: (homeDir: string, somaHome: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-wisdom-"));
  await fn(homeDir, join(homeDir, ".soma"));
}

async function seedClassifierFrames(homeDir: string): Promise<void> {
  await updateFrame({
    homeDir,
    domain: "security-review",
    type: "principle",
    observation: "OAuth token audit catches permission boundary mistakes before release",
    now: new Date("2026-05-21T12:00:00Z"),
  });
  await updateFrame({
    homeDir,
    domain: "deployment",
    type: "contextual-rule",
    observation: "Cloudflare worker DNS changes need explicit rollback notes",
    now: new Date("2026-05-21T12:00:00Z"),
  });
}

test("wisdom update creates frames, appends observations, and lists counts", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const created = await updateFrame({
      homeDir,
      domain: "development",
      type: "principle",
      observation: "TDD catches integration bugs earlier",
      now: new Date("2026-05-19T12:00:00Z"),
    });
    expect(created.created).toBe(true);
    expect(created.observationCount).toBe(1);

    const updated = await updateFrame({
      homeDir,
      domain: "development",
      type: "anti-pattern",
      observation: "Claiming done before tests pass hides regressions",
      now: new Date("2026-05-20T12:00:00Z"),
    });
    expect(updated.created).toBe(false);
    expect(updated.observationCount).toBe(2);

    const content = await readFile(join(somaHome, "memory/WISDOM/FRAMES/development.md"), "utf8");
    expect(content).toContain("[CRYSTAL] TDD catches integration bugs earlier");
    expect(content).toContain("- Observation Count: 2");
    expect(content).not.toContain(".claude");

    const frames = await listFrames({ homeDir });
    expect(frames).toMatchObject([{ domain: "development", observationCount: 2 }]);
  });
});

test("wisdom update appends every observation type with stable frame metadata", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const updates = [
      ["principle", "Prefer small verified changes"],
      ["contextual-rule", "Use explicit handoff notes before pausing"],
      ["prediction", "Missing rollback notes will slow incident recovery"],
      ["anti-pattern", "Bundling unrelated claims hides weak evidence"],
      ["evolution", "Frame split from general development wisdom"],
    ] as const;

    for (const [type, observation] of updates) {
      const output = await runSomaCli([
        "wisdom",
        "update",
        "--domain",
        "operating-practice",
        "--type",
        type,
        "--observation",
        observation,
        "--home-dir",
        homeDir,
      ]);
      expect(output).toContain(".soma/memory/WISDOM/FRAMES/operating-practice.md");
      expect(output).not.toContain(".claude");
    }

    const framePath = join(somaHome, "memory/WISDOM/FRAMES/operating-practice.md");
    const content = await readFile(framePath, "utf8");
    expect(content).toContain("# Operating Practice Wisdom Frame");
    expect(content).toContain("## Crystallized Principles\n- [CRYSTAL] Prefer small verified changes");
    expect(content).toContain("## Contextual Rules\n- Use explicit handoff notes before pausing");
    expect(content).toContain("## Predictive Model\n- Missing rollback notes will slow incident recovery");
    expect(content).toContain("## Anti-Patterns\n- Bundling unrelated claims hides weak evidence");
    expect(content).toContain("## Evolution Log");
    expect(content).toContain("Frame split from general development wisdom (type: evolution)");
    expect(content).toContain("- Observation Count: 5");
    expect(content).not.toContain(".claude");

    const headings = [...content.matchAll(/^## /gm)];
    expect(headings).toHaveLength(7);

    const frames = await listFrames({ homeDir });
    expect(frames).toMatchObject([{ domain: "operating-practice", observationCount: 5 }]);
  });
});

test("wisdom classifier handles default and dynamic frame domains", async () => {
  await withTempHome(async (homeDir) => {
    const defaults = await classifyDomains("how should I structure the PR review", { homeDir });
    expect(defaults[0]).toMatchObject({ domain: "development" });
    expect(defaults[0].relevance).toBeGreaterThanOrEqual(0.8);
    expect(defaults[0].path).toContain(".soma/memory/WISDOM/FRAMES/development.md");
    expect(defaults[0].path).not.toContain(".claude");

    await updateFrame({
      homeDir,
      domain: "security-review",
      type: "principle",
      observation: "Threat modeling catches auth boundary mistakes before release",
    });
    const dynamic = await classifyDomains("auth boundary threat modeling for release", { homeDir });
    expect(dynamic.map((item) => item.domain)).toContain("security-review");
  });
});

test("wisdom classifier orders multi-domain matches from dynamic and default frames", async () => {
  await withTempHome(async (homeDir) => {
    await seedClassifierFrames(homeDir);

    const classifications = await classifyDomains("oauth token audit before cloudflare worker deploy review", { homeDir });
    expect(classifications.map((item) => item.domain)).toEqual(["security-review", "deployment", "development"]);
    expect(classifications[0].relevance).toBeGreaterThan(classifications[1].relevance);
    expect(classifications[0].matches).toEqual(expect.arrayContaining(["oauth", "token", "audit"]));
    expect(classifications.map((item) => item.path)).toEqual(expect.arrayContaining([
      expect.stringContaining(".soma/memory/WISDOM/FRAMES/security-review.md"),
      expect.stringContaining(".soma/memory/WISDOM/FRAMES/deployment.md"),
      expect.stringContaining(".soma/memory/WISDOM/FRAMES/development.md"),
    ]));
    expect(classifications.map((item) => item.path).join("\n")).not.toContain(".claude");
  });
});

test("wisdom classifier loads relevant dynamic frame content", async () => {
  await withTempHome(async (homeDir) => {
    await seedClassifierFrames(homeDir);

    const frames = await loadRelevantFrames("token permission boundary", { homeDir });
    expect(frames.map((frame) => frame.domain)).toEqual(["security-review"]);
    expect(frames[0].content).toContain("OAuth token audit catches permission boundary mistakes before release");
  });
});

test("wisdom CLI classifies and lists dynamic frame domains", async () => {
  await withTempHome(async (homeDir) => {
    await seedClassifierFrames(homeDir);

    const cliClassified = JSON.parse(await runSomaCli([
      "wisdom",
      "classify",
      "oauth",
      "token",
      "audit",
      "cloudflare",
      "worker",
      "deploy",
      "review",
      "--home-dir",
      homeDir,
    ])) as { domain: string; relevance: number; matches: string[] }[];
    expect(cliClassified.map((item) => item.domain)).toEqual(["security-review", "deployment", "development"]);

    const list = await runSomaCli(["wisdom", "list", "--home-dir", homeDir]);
    expect(list).toContain("security-review\t1\t");
    expect(list).toContain("deployment\t1\t");
  });
});

test("wisdom synthesis detects cross-frame principles and health thresholds", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    await updateFrame({
      homeDir,
      domain: "development",
      type: "principle",
      observation: "Small PR review catches integration bugs early",
      now: new Date("2026-05-19T12:00:00Z"),
    });
    await updateFrame({
      homeDir,
      domain: "deployment",
      type: "principle",
      observation: "Small deploy review catches integration failures early",
      now: new Date("2026-05-19T12:00:00Z"),
    });

    const result = await synthesizeWisdom({ homeDir, now: new Date("2026-05-20T12:00:00Z") });
    expect(jaccardSimilarity("small review catches bugs early", "small review catches failures early")).toBeGreaterThanOrEqual(0.6);
    expect(result.principles.length).toBeGreaterThanOrEqual(1);
    expect(result.health.map((item) => item.status)).toContain("stable");
    await expect(readFile(join(somaHome, "memory/WISDOM/PRINCIPLES/verified.md"), "utf8")).resolves.toContain("deployment + development");
    await expect(readFile(join(somaHome, "memory/WISDOM/META/frame-health.md"), "utf8")).resolves.toContain("stable");
  });
});

test("wisdom synthesis supports dry-run previews and configurable similarity thresholds", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    await updateFrame({
      homeDir,
      domain: "development",
      type: "principle",
      observation: "Small review catches integration bugs early",
      now: new Date("2026-05-19T12:00:00Z"),
    });
    await updateFrame({
      homeDir,
      domain: "deployment",
      type: "principle",
      observation: "Small review catches integration failures early",
      now: new Date("2026-05-19T12:00:00Z"),
    });

    const preview = await synthesizeWisdom({
      homeDir,
      dryRun: true,
      similarityThreshold: 0.7,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    expect(preview.principles).toHaveLength(1);
    expect(preview.principlesPath).toBeUndefined();
    expect(preview.healthPath).toBeUndefined();
    await expect(readFile(join(somaHome, "memory/WISDOM/PRINCIPLES/verified.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(somaHome, "memory/WISDOM/META/frame-health.md"), "utf8")).rejects.toThrow();

    const strictPreview = await synthesizeWisdom({
      homeDir,
      dryRun: true,
      similarityThreshold: 0.9,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    expect(strictPreview.principles).toHaveLength(0);

    const cliPreview = await runSomaCli([
      "wisdom",
      "synthesize",
      "--dry-run",
      "--threshold",
      "0.9",
      "--home-dir",
      homeDir,
    ]);
    expect(cliPreview).toContain("wisdom synthesize: 0 cross-frame principle(s)");

    await expect(runSomaCli(["wisdom", "synthesize", "--dry-run", "--threshold", "1.1", "--home-dir", homeDir])).rejects.toThrow(
      "--threshold must be a number between 0 and 1.",
    );
  });
});

test("wisdom synthesis validates library similarity thresholds", async () => {
  await withTempHome(async (homeDir) => {
    await expect(synthesizeWisdom({ homeDir, similarityThreshold: Number.NaN })).rejects.toThrow(
      "similarityThreshold must be a number between 0 and 1.",
    );
    await expect(synthesizeWisdom({ homeDir, similarityThreshold: 1.1 })).rejects.toThrow(
      "similarityThreshold must be a number between 0 and 1.",
    );
  });
});

test("wisdom health reports growing stable and stale frames without writing principles", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    for (let index = 0; index < 10; index += 1) {
      await updateFrame({
        homeDir,
        domain: "growing-domain",
        type: "principle",
        observation: `Fresh principle ${index}`,
        now: new Date("2026-05-27T12:00:00Z"),
      });
    }
    await updateFrame({
      homeDir,
      domain: "stable-domain",
      type: "principle",
      observation: "Moderately recent principle",
      now: new Date("2026-05-07T12:00:00Z"),
    });
    await updateFrame({
      homeDir,
      domain: "stale-domain",
      type: "principle",
      observation: "Old principle",
      now: new Date("2026-03-01T12:00:00Z"),
    });

    const output = await runSomaCli(["wisdom", "health", "--home-dir", homeDir]);
    expect(output).toContain("wisdom health: 0 cross-frame principle(s), 3 frame(s)");
    expect(output).toContain(".soma/memory/WISDOM/META/frame-health.md");
    expect(output).not.toContain(".claude");

    const health = await readFile(join(somaHome, "memory/WISDOM/META/frame-health.md"), "utf8");
    expect(health).toContain("growing-domain: growing");
    expect(health).toContain("stable-domain: stable");
    expect(health).toContain("stale-domain: stale");
    expect(health).not.toContain(".claude");
    await expect(readFile(join(somaHome, "memory/WISDOM/PRINCIPLES/verified.md"), "utf8")).rejects.toThrow();
  });
});

test("wisdom CLI routes classify, list, update, synthesize, and health", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli([
      "wisdom",
      "update",
      "--domain",
      "communication",
      "--type",
      "contextual-rule",
      "--observation",
      "Thread-first",
      "updates",
      "reduce",
      "channel",
      "noise",
      "--home-dir",
      homeDir,
    ]);

    const list = await runSomaCli(["wisdom", "list", "--home-dir", homeDir]);
    expect(list).toContain("communication");
    await expect(readFile(join(homeDir, ".soma/memory/WISDOM/FRAMES/communication.md"), "utf8")).resolves.toContain("Thread-first updates reduce channel noise");
    await expect(runSomaCli([
      "wisdom",
      "update",
      "--observation",
      "note",
      "--domain",
      "--type",
      "principle",
      "--home-dir",
      homeDir,
    ])).rejects.toThrow("--domain requires a value");
    await expect(runSomaCli([
      "wisdom",
      "update",
      "--domain",
      "--home-dir",
      homeDir,
      "--type",
      "principle",
      "--observation",
      "note",
    ])).rejects.toThrow("--domain requires a value");

    const classified = JSON.parse(await runSomaCli(["wisdom", "classify", "thread update", "--home-dir", homeDir]));
    expect(classified[0].domain).toBe("communication");

    const synth = await runSomaCli(["wisdom", "synthesize", "--home-dir", homeDir]);
    expect(synth).toContain("wisdom synthesize");

    const health = await runSomaCli(["wisdom", "health", "--home-dir", homeDir]);
    expect(health).toContain("wisdom health");
  });
});
