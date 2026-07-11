import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SOMA_FEEDBACK_AUTOMATIC_HOOK_TRIGGER_PATTERN_SOURCE } from "../src/feedback-contract";
import {
  SOMA_CLAUDE_FEEDBACK_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_FEEDBACK_RELATIVE_PATH,
  claudeCodeHookEnabled,
  installClaudeCodeSomaHooks,
  removeClaudeCodeSomaHookFiles,
} from "../src/adapters/claude-code/hooks";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "soma-cc-feedback-"));
}

async function installInto(substrateHome: string, options?: unknown): Promise<string[]> {
  return installClaudeCodeSomaHooks({
    somaHome: join(substrateHome, ".soma"),
    somaRepoPath: process.cwd(),
    substrateHome,
    options,
  });
}

describe("claude-code feedback capture hook", () => {
  test("enabled by default, disabled by feedbackCapture: false", () => {
    expect(claudeCodeHookEnabled(undefined, "feedbackCapture")).toBe(true);
    expect(claudeCodeHookEnabled({}, "feedbackCapture")).toBe(true);
    expect(claudeCodeHookEnabled({ feedbackCapture: false }, "feedbackCapture")).toBe(false);
  });

  test("install writes the generated hook, config, and a UserPromptSubmit settings entry", async () => {
    const substrateHome = tempHome();
    const written = await installInto(substrateHome);

    const hookPath = resolve(substrateHome, SOMA_CLAUDE_FEEDBACK_RELATIVE_PATH);
    const configPath = resolve(substrateHome, SOMA_CLAUDE_FEEDBACK_CONFIG_RELATIVE_PATH);
    expect(written).toContain(hookPath);
    expect(written).toContain(configPath);

    const source = readFileSync(hookPath, "utf8");
    // Excerpts are the point of the fix — content-free capture was the audited drift.
    expect(source).toContain("--store-excerpt");
    expect(source).not.toContain("--no-excerpt");
    expect(source).toContain("readSync(0, chunk");
    expect(source).not.toContain('readFileSync(0, "utf8")');
    // Trigger regex is single-sourced from feedback-contract, not forked.
    expect(source).toContain(JSON.stringify(SOMA_FEEDBACK_AUTOMATIC_HOOK_TRIGGER_PATTERN_SOURCE));
    expect(source).toContain('"--substrate", "claude-code"');

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(typeof config.bunPath).toBe("string");
    expect(typeof config.trustedSomaRepo).toBe("string");

    const settings = JSON.parse(readFileSync(resolve(substrateHome, "settings.json"), "utf8"));
    const groups = settings.hooks.UserPromptSubmit as { hooks: { command: string }[] }[];
    const commands = groups.flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands.some((command) => command.includes(hookPath))).toBe(true);
  });

  test("feedbackCapture: false skips the hook entirely", async () => {
    const substrateHome = tempHome();
    await installInto(substrateHome, { feedbackCapture: false });
    expect(existsSync(resolve(substrateHome, SOMA_CLAUDE_FEEDBACK_RELATIVE_PATH))).toBe(false);
    const settings = JSON.parse(readFileSync(resolve(substrateHome, "settings.json"), "utf8"));
    const raw = JSON.stringify(settings);
    expect(raw).not.toContain("soma-feedback-capture");
  });

  test("disabling feedback capture removes a previously installed settings command", async () => {
    const substrateHome = tempHome();
    await installInto(substrateHome);
    await installInto(substrateHome, { feedbackCapture: false });
    expect(readFileSync(resolve(substrateHome, "settings.json"), "utf8")).not.toContain("soma-feedback-capture");
  });

  test("uninstall removes the hook files and the settings entry", async () => {
    const substrateHome = tempHome();
    await installInto(substrateHome);
    await removeClaudeCodeSomaHookFiles(substrateHome);

    expect(existsSync(resolve(substrateHome, SOMA_CLAUDE_FEEDBACK_RELATIVE_PATH))).toBe(false);
    expect(existsSync(resolve(substrateHome, SOMA_CLAUDE_FEEDBACK_CONFIG_RELATIVE_PATH))).toBe(false);
    const settingsPath = resolve(substrateHome, "settings.json");
    if (existsSync(settingsPath)) {
      expect(readFileSync(settingsPath, "utf8")).not.toContain("soma-feedback-capture");
    }
  });

  test("reinstall is idempotent: no duplicate settings groups", async () => {
    const substrateHome = tempHome();
    await installInto(substrateHome);
    await installInto(substrateHome);
    const settings = JSON.parse(readFileSync(resolve(substrateHome, "settings.json"), "utf8"));
    const groups = settings.hooks.UserPromptSubmit as { hooks: { command: string }[] }[];
    const feedbackCommands = groups
      .flatMap((group) => group.hooks.map((hook) => hook.command))
      .filter((command) => command.includes("soma-feedback-capture.mjs"));
    expect(feedbackCommands).toHaveLength(1);
  });
});
