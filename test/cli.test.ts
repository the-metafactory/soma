import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-cli-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("cli dry-runs codex install without writing files", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["install", "codex", "--home-dir", homeDir]);

    expect(output).toContain("mode: dry-run");
    expect(output).toContain(join(homeDir, ".soma/profile/assistant.md"));
    expect(output).toContain(join(homeDir, ".codex/rules/soma.rules"));
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();
    await expect(stat(join(homeDir, ".codex"))).rejects.toThrow();
  });
});

test("cli creates persisted Algorithm runs", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli([
      "algorithm",
      "new",
      "--home-dir",
      homeDir,
      "--prompt",
      "Port TheAlgorithm",
      "--intent",
      "Make Algorithm deterministic.",
      "--current-state",
      "Algorithm is declarative.",
      "--goal",
      "Harness exists.",
      "--criterion",
      "C1:Harness state is written.",
    ]);

    expect(output).toContain("Soma Algorithm run created");
    expect(output).toContain("phase: observe");
    const path = output
      .split("\n")
      .find((line) => line.startsWith("path: "))
      ?.slice("path: ".length);

    expect(path?.startsWith(join(homeDir, ".soma/memory/WORK/algorithm-runs"))).toBe(true);
    await expect(readFile(path ?? "", "utf8")).resolves.toContain('"goal": "Harness exists."');
  });
});

test("cli drives Algorithm runs through gated mutations", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli([
      "algorithm",
      "new",
      "--home-dir",
      homeDir,
      "--id",
      "cli-run",
      "--prompt",
      "Use the harness",
      "--intent",
      "Drive work through gates.",
      "--current-state",
      "Only create exists.",
      "--goal",
      "Run reaches learn phase.",
      "--criterion",
      "C1:Mutation commands work.",
    ]);

    await expect(readFile(join(homeDir, ".soma/memory/STATE/algorithm-work-index.json"), "utf8")).resolves.toContain("cli-run");

    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli(["algorithm", "capabilities", "--home-dir", homeDir, "--id", "cli-run", "--capability", "FeedbackMemoryConsult"]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli(["algorithm", "plan", "--home-dir", homeDir, "--id", "cli-run", "--step", "P1:C1:Exercise mutation commands."]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli(["algorithm", "change", "--home-dir", homeDir, "--id", "cli-run", "--text", "Added CLI mutation commands."]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli(["algorithm", "step", "--home-dir", homeDir, "--id", "cli-run", "--step-id", "P1", "--status", "done", "--evidence", "Step command persisted state."]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli([
      "algorithm",
      "verify",
      "--home-dir",
      homeDir,
      "--id",
      "cli-run",
      "--criterion-id",
      "C1",
      "--status",
      "passed",
      "--evidence",
      "CLI commands advanced through gates.",
    ]);
    const output = await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);

    expect(output).toContain("phase: learn");
    expect(output).toContain("[passed] C1");
  });
});

test("cli handles lifecycle events", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir]);
    const output = await runSomaCli([
      "lifecycle",
      "session-start",
      "--home-dir",
      homeDir,
      "--substrate",
      "codex",
      "--session-id",
      "cli-session",
    ]);

    expect(output).toContain("Soma lifecycle event handled");
    expect(output).toContain("event: session_start");
    expect(output).toContain("# Soma Startup Context");
    await expect(readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8")).resolves.toContain("lifecycle.session_start");
  });
});

test("cli applies codex install only with explicit apply flag", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir]);

    expect(output).toContain("Soma install applied");
    expect(output).toContain(`somaHome: ${join(homeDir, ".soma")}`);
    expect(output).toContain(`substrateHome: ${join(homeDir, ".codex")}`);
    await expect(readFile(join(homeDir, ".soma/profile/assistant.md"), "utf8")).resolves.toContain("Name: soma");
    await expect(readFile(join(homeDir, ".codex/rules/soma.rules"), "utf8")).resolves.toContain("Soma default availability");
  });
});

test("cli dry-runs and applies pi.dev install", async () => {
  await withTempHome(async (homeDir) => {
    const dryRun = await runSomaCli(["install", "pi-dev", "--home-dir", homeDir]);

    expect(dryRun).toContain("substrate: pi-dev");
    expect(dryRun).toContain(join(homeDir, ".pi/agent/extensions/soma.ts"));
    expect(dryRun).toContain(join(homeDir, ".pi/agent/skills/soma/SKILL.md"));
    await expect(stat(join(homeDir, ".pi"))).rejects.toThrow();

    const output = await runSomaCli(["install", "pi-dev", "--apply", "--home-dir", homeDir]);

    expect(output).toContain("Soma install applied");
    expect(output).toContain(`substrate: pi-dev`);
    await expect(readFile(join(homeDir, ".pi/agent/extensions/soma.ts"), "utf8")).resolves.toContain("soma_context");
    await expect(readFile(join(homeDir, ".pi/agent/skills/soma/SKILL.md"), "utf8")).resolves.toContain("name: soma");
  });
});

test("cli rejects unsupported commands", async () => {
  await expect(runSomaCli(["install", "claude-code"])).rejects.toThrow("Usage:");
});
