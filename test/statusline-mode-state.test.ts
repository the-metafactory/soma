/**
 * Session-scoped mode+effort feeder for the claude-code statusline.
 *
 * The mode-classifier hook spawns `soma algorithm classify --session-id <id>
 * --json` on every prompt; that CLI action now ALSO writes (best-effort) the
 * classification to `<somaHome>/memory/STATE/statusline-mode-<id>.json`,
 * which the statusline script reads directly (see
 * test/claude-code-statusline.test.ts for the render side).
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { writeStatuslineModeState } from "../src";
import type { AlgorithmPromptClassification } from "../src";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-statusline-mode-state-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("writeStatuslineModeState writes mode, effort, and the caller-supplied updatedAt", async () => {
  await withTempHome(async (homeDir) => {
    const classification: AlgorithmPromptClassification = {
      mode: "algorithm",
      effort: "E3",
      source: "auto",
      reason: "Prompt shape maps to Algorithm E3.",
    };

    const path = await writeStatuslineModeState({
      homeDir,
      sessionId: "sess1",
      classification,
      updatedAt: "2026-07-07T10:00:00.000Z",
    });

    expect(path).toBe(join(homeDir, ".soma/memory/STATE/statusline-mode-sess1.json"));
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content).toEqual({
      mode: "algorithm",
      effort: "E3",
      updatedAt: "2026-07-07T10:00:00.000Z",
    });
  });
});

test("writeStatuslineModeState writes an empty effort when the classification has none", async () => {
  await withTempHome(async (homeDir) => {
    const classification: AlgorithmPromptClassification = {
      mode: "minimal",
      source: "auto",
      reason: "Prompt is a minimal acknowledgement.",
    };

    const path = await writeStatuslineModeState({
      homeDir,
      sessionId: "sess2",
      classification,
      updatedAt: "2026-07-07T10:05:00.000Z",
    });

    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content).toEqual({
      mode: "minimal",
      effort: "",
      updatedAt: "2026-07-07T10:05:00.000Z",
    });
  });
});

test("cli algorithm classify --session-id writes the statusline mode state file", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli([
      "algorithm",
      "classify",
      "--home-dir",
      homeDir,
      "--prompt",
      "Port a multi-file PAI adapter into Soma",
      "--session-id",
      "sess1",
      "--json",
    ]);
    const classification = JSON.parse(output) as { mode: string; effort: string };
    expect(classification.mode).toBe("algorithm");
    expect(classification.effort).toBe("E3");

    const path = join(homeDir, ".soma/memory/STATE/statusline-mode-sess1.json");
    expect(await fileExists(path)).toBe(true);
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.mode).toBe("algorithm");
    expect(content.effort).toBe("E3");
    expect(typeof content.updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(content.updatedAt))).toBe(false);
  });
});

test("cli algorithm classify --session-id also writes the state file for the plain-text (non-JSON) output", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli([
      "algorithm",
      "classify",
      "--home-dir",
      homeDir,
      "--prompt",
      "ok",
      "--session-id",
      "sess-text",
    ]);
    expect(output).toContain("mode: minimal");

    const path = join(homeDir, ".soma/memory/STATE/statusline-mode-sess-text.json");
    expect(await fileExists(path)).toBe(true);
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content).toMatchObject({ mode: "minimal", effort: "" });
  });
});

test("cli algorithm classify without --session-id writes no statusline mode state file", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli([
      "algorithm",
      "classify",
      "--home-dir",
      homeDir,
      "--prompt",
      "Port a multi-file PAI adapter into Soma",
    ]);

    expect(await fileExists(join(homeDir, ".soma/memory/STATE"))).toBe(false);
  });
});
