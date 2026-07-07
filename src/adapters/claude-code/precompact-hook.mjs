#!/usr/bin/env bun
/**
 * Soma PreCompact handover hook (Claude Code).
 *
 * Claude Code compresses the conversation mid-session and does NOT re-run
 * SessionStart afterward, so live work-state (active Algorithm runs) is lost
 * across the boundary. This hook is the persist+resurface pair that carries it:
 *
 *   argv "capture"   — wired to the PreCompact event. Snapshots the startup
 *                      context into a durable, session-scoped file AND echoes it
 *                      to stdout.
 *   argv "resurface" — wired to UserPromptSubmit. On the first prompt after a
 *                      compaction it re-injects that file as additionalContext,
 *                      then the CLI consumes it so it fires exactly once.
 *
 * Fail-open: Soma continuity must never block normal Claude Code use.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function hookDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(hookDir(), "soma-precompact.config.json"), "utf8"));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim().length === 0) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function runSoma(config, args, timeout) {
  return spawnSync(config.bunPath, ["src/cli.ts", ...args], {
    cwd: config.trustedSomaRepo,
    encoding: "utf8",
    timeout,
    env: process.env,
  });
}

function baseArgs(config, action) {
  return ["precompact", action, "--soma-home", config.somaHome, "--substrate", "claude-code"];
}

function withSession(args, input) {
  const id = nonEmptyString(input.session_id);
  if (id) args.push("--session-id", id);
  return args;
}

// PreCompact: persist the handover (the CLI writes the durable file) and echo it
// to stdout. Non-blocking — exit 0 regardless, even if the spawn fails.
function capture(config, input) {
  try {
    const args = withSession(baseArgs(config, "capture"), input);
    const cwd = nonEmptyString(input.cwd);
    if (cwd) args.push("--cwd", cwd);
    const result = runSoma(config, args, 20000);
    const handover = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (handover.length > 0) console.log(handover);
  } catch {
    // Non-blocking: a failed capture must not interfere with compaction.
  }
  process.exit(0);
}

// The durable handover path the CLI would read — a mirror of preCompactHandoverPath
// in src/cli/precompact.ts, kept in sync (same sanitize + filename template) so the
// hook can skip the CLI spawn when no handover is pending. A drift only costs a
// missed fast-path, never correctness: the CLI remains the authoritative reader.
function handoverPath(config, input) {
  const id = nonEmptyString(input.session_id);
  const name = id ? `precompact-handover-${id.replace(/[^A-Za-z0-9_-]/g, "_")}.md` : "precompact-handover.md";
  return join(config.somaHome, "memory/STATE", name);
}

// UserPromptSubmit: resurface the persisted handover once. The CLI consumes the
// file, so this injects additionalContext only on the first prompt after a
// compaction and stays silent otherwise. Fail-open on any error.
function resurface(config, input) {
  try {
    // Hot-path guard: this hook fires on EVERY prompt. Only pay the Bun/TS CLI
    // startup on the rare prompt where a handover file actually exists (once per
    // compaction); otherwise return immediately.
    if (!existsSync(handoverPath(config, input))) emitContinue();
    const result = runSoma(config, withSession(baseArgs(config, "resurface"), input), 8000);
    const handover = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (handover.length === 0) emitContinue();
    emitAndExit({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: handover,
      },
    });
  } catch {
    // Fail-open: Soma continuity must never block a prompt.
    emitContinue();
  }
}

function emitContinue() {
  emitAndExit({ continue: true });
}

function emitAndExit(payload) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

function main() {
  const action = process.argv[2];
  const config = readConfig();
  if (config.error || typeof config.bunPath !== "string" || typeof config.trustedSomaRepo !== "string" || typeof config.somaHome !== "string") {
    // Fail-open: a broken config must not block the prompt or the compaction.
    if (action === "resurface") emitContinue();
    process.exit(0);
  }
  const input = readHookInput();
  if (action === "capture") capture(config, input);
  else if (action === "resurface") resurface(config, input);
  else process.exit(0);
}

main();
