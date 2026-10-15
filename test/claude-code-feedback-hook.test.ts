import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SOMA_FEEDBACK_AUTOMATIC_HOOK_TRIGGER_PATTERN_SOURCE } from "../src/events/index";
import {
  SOMA_CLAUDE_FEEDBACK_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_FEEDBACK_RELATIVE_PATH,
  claudeCodeHookEnabled,
  installClaudeCodeSomaHooks,
  removeClaudeCodeSomaHookFiles,
} from "../src/adapters/claude-code/hooks";
import { parseFeedbackArgs } from "../src/cli/feedback";
import { captureSomaFeedback } from "../src/feedback";

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

// node #846: drive the generated hook with UserPromptSubmit stdin fixtures. A
// fake `bun` records the argv and stdin the hook would hand `soma feedback
// capture`, so actor derivation and the drop rules are checked without a
// detached real capture child.
describe("claude-code feedback capture hook: session, actor and drop rules", () => {
  const FEEDBACK_PROMPT = "you missed the arc-manifest";

  async function installWithFakeBun(): Promise<{ hookPath: string; argsPath: string; stdinPath: string; dir: string; logPath: string }> {
    const substrateHome = tempHome();
    await installInto(substrateHome);
    const dir = mkdtempSync(join(tmpdir(), "soma-cc-feedback-fake-bun-"));
    const argsPath = join(dir, "capture.args");
    const stdinPath = join(dir, "capture.stdin");
    const logPath = join(dir, "capture.log");
    const fakeBun = join(dir, "fake-bun.sh");
    writeFileSync(
      fakeBun,
      `#!/bin/sh\necho "$*" >> "${logPath}"\ncat > "${stdinPath}"\nprintf '%s\\n' "$@" > "${argsPath}.tmp"\nmv "${argsPath}.tmp" "${argsPath}"\n`,
    );
    chmodSync(fakeBun, 0o755);
    const configPath = resolve(substrateHome, SOMA_CLAUDE_FEEDBACK_CONFIG_RELATIVE_PATH);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, bunPath: fakeBun }));
    return { hookPath: resolve(substrateHome, SOMA_CLAUDE_FEEDBACK_RELATIVE_PATH), argsPath, stdinPath, dir, logPath };
  }

  function runHook(hookPath: string, input: Record<string, unknown>, env: Record<string, string> = {}): void {
    const result = Bun.spawnSync([process.execPath, hookPath], {
      stdin: Buffer.from(JSON.stringify(input)),
      // A clean env: the test runner may itself be a headless or ranger run.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
  }

  async function capturedArgs(argsPath: string): Promise<string[]> {
    for (let attempt = 0; attempt < 100 && !existsSync(argsPath); attempt += 1) await Bun.sleep(50);
    return readFileSync(argsPath, "utf8").trimEnd().split("\n");
  }

  function flagValue(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  }

  test("interactive session forwards session_id, transcript_path and actor interactive into the event", async () => {
    const { hookPath, argsPath, stdinPath, dir } = await installWithFakeBun();
    runHook(hookPath, { session_id: "sess-123", transcript_path: "/tmp/transcripts/sess-123.jsonl", prompt: FEEDBACK_PROMPT });

    const args = await capturedArgs(argsPath);
    expect(args.slice(0, 4)).toEqual(["run", "soma", "feedback", "capture"]);
    expect(flagValue(args, "--session-id")).toBe("sess-123");
    expect(flagValue(args, "--transcript-path")).toBe("/tmp/transcripts/sess-123.jsonl");
    expect(flagValue(args, "--actor")).toBe("interactive");
    expect(flagValue(args, "--substrate")).toBe("claude-code");

    // The argv the hook builds is the argv the CLI accepts: replay it into a
    // real capture and check the appended event's metadata.
    const parsed = parseFeedbackArgs(args.slice(2));
    const somaHome = join(dir, ".soma");
    const result = await captureSomaFeedback({ ...parsed.options, somaHome, text: readFileSync(stdinPath, "utf8") });
    expect(result.event?.substrate).toBe("claude-code");
    expect(result.event?.metadata).toMatchObject({
      schemaVersion: 1,
      sessionId: "sess-123",
      transcriptPath: "/tmp/transcripts/sess-123.jsonl",
      actor: "interactive",
      substrate: "claude-code",
    });
  });

  test("RANGER_JOURNAL_PATH makes the actor automated", async () => {
    const { hookPath, argsPath } = await installWithFakeBun();
    runHook(hookPath, { session_id: "sess-r", prompt: FEEDBACK_PROMPT }, { RANGER_JOURNAL_PATH: "/tmp/ranger.journal", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
    expect(flagValue(await capturedArgs(argsPath), "--actor")).toBe("automated");
  });

  test("a headless run (CLAUDE_CODE_ENTRYPOINT=sdk-*) makes the actor sdk; cli stays interactive", async () => {
    const headless = await installWithFakeBun();
    runHook(headless.hookPath, { session_id: "sess-h", prompt: FEEDBACK_PROMPT }, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
    expect(flagValue(await capturedArgs(headless.argsPath), "--actor")).toBe("sdk");

    const cli = await installWithFakeBun();
    runHook(cli.hookPath, { session_id: "sess-i", prompt: FEEDBACK_PROMPT }, { CLAUDE_CODE_ENTRYPOINT: "cli" });
    expect(flagValue(await capturedArgs(cli.argsPath), "--actor")).toBe("interactive");
  });

  test.each([
    ["<task-notification>", `<task-notification>\n<status>completed</status>\n${FEEDBACK_PROMPT}\n</task-notification>`],
    ["<pasted_content", `  \n<pasted_content id="abc">${FEEDBACK_PROMPT}</pasted_content> please look`],
  ])("a prompt starting with %s appends nothing", async (_prefix, prompt) => {
    const { hookPath, argsPath, logPath } = await installWithFakeBun();
    runHook(hookPath, { session_id: "sess-dropped", prompt });
    // Positive control, spawned after: once its capture lands, a capture the
    // dropped prompt had started earlier would have landed too.
    runHook(hookPath, { session_id: "sess-control", prompt: FEEDBACK_PROMPT });
    await capturedArgs(argsPath);
    await Bun.sleep(100);
    const invocations = readFileSync(logPath, "utf8").trimEnd().split("\n");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain("sess-control");
  });

  test("an input without session_id omits --session-id and --transcript-path and still captures", async () => {
    const { hookPath, argsPath, stdinPath, dir } = await installWithFakeBun();
    runHook(hookPath, { session_id: "", prompt: FEEDBACK_PROMPT });

    const args = await capturedArgs(argsPath);
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--transcript-path");
    const parsed = parseFeedbackArgs(args.slice(2));
    const result = await captureSomaFeedback({ ...parsed.options, somaHome: join(dir, ".soma"), text: readFileSync(stdinPath, "utf8") });
    expect(result.captured).toBe(true);
    expect(result.event?.metadata).not.toHaveProperty("sessionId");
    expect(result.event?.metadata).not.toHaveProperty("transcriptPath");
  });

  test.skipIf(process.platform === "win32")("the blocking path never reads the transcript file", async () => {
    const { hookPath, argsPath } = await installWithFakeBun();
    // A FIFO with no writer blocks any reader forever: a hook that opened the
    // transcript would hit the spawnSync timeout instead of exiting 0.
    const fifoDir = mkdtempSync(join(tmpdir(), "soma-cc-feedback-fifo-"));
    const transcriptPath = join(fifoDir, "transcript.jsonl");
    expect(Bun.spawnSync(["mkfifo", transcriptPath]).exitCode).toBe(0);
    runHook(hookPath, { session_id: "sess-f", transcript_path: transcriptPath, prompt: FEEDBACK_PROMPT });
    expect(flagValue(await capturedArgs(argsPath), "--transcript-path")).toBe(transcriptPath);

    const source = readFileSync(hookPath, "utf8");
    expect(source).not.toMatch(/(?:readFileSync|createReadStream|openSync)\([^)]*transcript/i);
  });
});
