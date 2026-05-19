import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { jaccardSimilarity } from "../src/tools/wisdom";

async function withTempHome(fn: (homeDir: string, somaHome: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-wisdom-"));
  await fn(homeDir, join(homeDir, ".soma"));
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

test("wisdom classifier handles default and dynamic frame domains", async () => {
  await withTempHome(async (homeDir) => {
    const defaults = await classifyDomains("how should I structure the PR review", { homeDir });
    expect(defaults[0]).toMatchObject({ domain: "development" });
    expect(defaults[0]!.relevance).toBeGreaterThanOrEqual(0.8);

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
