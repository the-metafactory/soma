#!/usr/bin/env bun
/* eslint-disable no-undef -- The handler table placeholder is replaced before installation. */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const FLUSH_EVENT = "flush-writeback-queue";
const HOOK_EVENT_HANDLERS = __SOMA_CLAUDE_HOOK_EVENT_HANDLERS__;
const MAX_FLUSH_RETRIES = 5;
const STALE_FLUSH_LOCK_MS = 5 * 60 * 1000;

function hookDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function readConfig() {
  return JSON.parse(readFileSync(join(hookDir(), "soma-claude-code-hook.config.json"), "utf8"));
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

function isErrorCode(error, code) {
  return error && typeof error === "object" && error.code === code;
}

function removeIfExists(path) {
  try {
    unlinkSync(path);
  } catch {
    return undefined;
  }
}

function ignoreSpawnError() {
  return undefined;
}

function spawnDetached(command, args, cwd, env = {}, onError = ignoreSpawnError) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  child.on("error", onError);
  child.unref();
}

function runSomaDetached(config, args, env = {}) {
  spawnDetached(config.bunPath, args, config.trustedSomaRepo, env);
}

function runSomaBlocking(config, args) {
  return spawnSync(config.bunPath, args, {
    cwd: config.trustedSomaRepo,
    stdio: "ignore",
    env: process.env,
  });
}

function runHookDetached(config, args, onError = ignoreSpawnError) {
  spawnDetached(config.bunPath, [fileURLToPath(import.meta.url), ...args], config.trustedSomaRepo, {}, onError);
}

function sessionId(input) {
  return typeof input.session_id === "string" && input.session_id.trim().length > 0 ? input.session_id : undefined;
}

function lifecycle(config, event, input) {
  const args = ["src/cli.ts", "lifecycle", event, "--soma-home", config.somaHome, "--substrate", "claude-code"];
  const id = sessionId(input);
  if (id) args.push("--session-id", id);
  const cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : undefined;
  if (cwd) args.push("--cwd", cwd);
  runSomaDetached(config, args);
}

function metadata(input, source) {
  return {
    sessionId: sessionId(input),
    source,
    hookEventName: typeof input.hook_event_name === "string" ? input.hook_event_name : undefined,
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    toolName: typeof input.tool_name === "string" ? input.tool_name : undefined,
    agentType: typeof input.agent_type === "string" ? input.agent_type : undefined,
    agentId: typeof input.agent_id === "string" ? input.agent_id : undefined,
  };
}

function artifactPaths(input) {
  const toolInput = input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input) ? input.tool_input : {};
  const paths = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof toolInput[key] === "string") paths.push(toolInput[key]);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit === "object" && typeof edit.file_path === "string") paths.push(edit.file_path);
    }
  }
  return Array.from(new Set(paths));
}

function writebackQueuePath() {
  return join(hookDir(), "soma-claude-code-writeback-queue.jsonl");
}

function acquireFlushLock(path) {
  removeStaleFlushLock(path);
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) return false;
    throw error;
  }
}

function removeStaleFlushLock(path) {
  try {
    if (Date.now() - statSync(path).mtimeMs > STALE_FLUSH_LOCK_MS) removeIfExists(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

function scheduleWritebackFlush(config) {
  const lockPath = `${writebackQueuePath()}.lock`;
  if (!acquireFlushLock(lockPath)) {
    writeFileSync(`${writebackQueuePath()}.followup`, "1", "utf8");
    return;
  }
  try {
    runHookDetached(config, [FLUSH_EVENT], () => {
      removeIfExists(lockPath);
    });
  } catch (error) {
    removeIfExists(lockPath);
    throw error;
  }
}

function consumeFlushFollowup(queuePath) {
  try {
    unlinkSync(`${queuePath}.followup`);
    return true;
  } catch {
    return false;
  }
}

function queueHasEntries(queuePath) {
  try {
    return statSync(queuePath).size > 0;
  } catch {
    return false;
  }
}

function retryAttemptsPath(queuePath) {
  return `${queuePath}.attempts`;
}

function retryCheckpointPath(queuePath) {
  return `${queuePath}.checkpoint`;
}

function readRetryAttempts(queuePath) {
  try {
    const value = Number.parseInt(readFileSync(retryAttemptsPath(queuePath), "utf8"), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function recordFlushFailure(queuePath) {
  const attempts = readRetryAttempts(queuePath) + 1;
  writeFileSync(retryAttemptsPath(queuePath), `${attempts}`, "utf8");
  return attempts;
}

function clearFlushFailures(queuePath) {
  removeIfExists(retryAttemptsPath(queuePath));
}

function clearRetryCheckpoint(queuePath) {
  removeIfExists(retryCheckpointPath(queuePath));
}

function retryDelayMs(attempts) {
  if (attempts <= 0) return 250;
  return Math.min(5000, 250 * 2 ** Math.min(attempts - 1, 4));
}

function claimQueuedWritebacks(queuePath, retryPath) {
  if (queueHasEntries(retryPath)) return true;
  return claimFreshQueuedWritebacks(queuePath, retryPath);
}

function claimFreshQueuedWritebacks(queuePath, retryPath) {
  removeIfExists(retryPath);
  clearRetryCheckpoint(queuePath);
  try {
    renameSync(queuePath, retryPath);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function deadLetterQueuedWritebacks(queuePath, retryPath) {
  if (!queueHasEntries(retryPath)) {
    removeIfExists(retryPath);
    clearFlushFailures(queuePath);
    clearRetryCheckpoint(queuePath);
    return false;
  }
  try {
    renameSync(retryPath, `${retryPath}.failed.${Date.now()}.${process.pid}`);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  clearFlushFailures(queuePath);
  clearRetryCheckpoint(queuePath);
  return true;
}

function shouldRescheduleFlush(queuePath, retryPath, flushFailed, failureAttempts) {
  if (flushFailed) {
    if (failureAttempts < MAX_FLUSH_RETRIES) return queueHasEntries(retryPath);
    deadLetterQueuedWritebacks(queuePath, retryPath);
    return consumeFlushFollowup(queuePath) || queueHasEntries(queuePath);
  }
  return consumeFlushFollowup(queuePath) || queueHasEntries(queuePath) || queueHasEntries(retryPath);
}

async function flushWritebackQueue(config) {
  const queuePath = writebackQueuePath();
  const lockPath = `${queuePath}.lock`;
  const retryPath = `${queuePath}.retry`;
  let result = { flushFailed: false, failureAttempts: 0 };
  try {
    result = await runFlushAttempt(config, { queuePath, retryPath });
  } finally {
    removeIfExists(lockPath);
    const reschedule = shouldRescheduleFlush(queuePath, retryPath, result.flushFailed, result.failureAttempts);
    if (reschedule) scheduleWritebackFlush(config);
  }
}

async function runFlushAttempt(config, paths) {
  let flushFailed = false;
  let failureAttempts = 0;
  await delay(retryDelayMs(readRetryAttempts(paths.queuePath)));
  if (!claimQueuedWritebacks(paths.queuePath, paths.retryPath)) return { flushFailed, failureAttempts };
  try {
    flushFailed = true;
    const result = runSomaBlocking(config, ["src/cli.ts", "writeback", "events", "--soma-home", config.somaHome, "--queue-file", paths.retryPath, "--checkpoint-file", retryCheckpointPath(paths.queuePath), "--substrate", "claude-code"]);
    flushFailed = Boolean(result.error || result.status !== 0);
  } finally {
    if (flushFailed) failureAttempts = recordFlushFailure(paths.queuePath);
    else clearFlushFailures(paths.queuePath);
  }
  return { flushFailed, failureAttempts };
}

async function writeback(config, input, kind, summary, source) {
  const artifacts = artifactPaths(input);
  const event = {
    substrate: "claude-code",
    kind,
    summary,
    artifactPaths: artifacts.length > 0 ? artifacts : undefined,
    metadata: metadata(input, source),
  };
  await appendFile(writebackQueuePath(), `${JSON.stringify(event)}\n`, "utf8");
  scheduleWritebackFlush(config);
}

async function main() {
  const config = readConfig();
  const event = process.argv[2];
  if (event === FLUSH_EVENT) {
    await flushWritebackQueue(config);
    return;
  }
  const input = readHookInput();
  const handler = HOOK_EVENT_HANDLERS[event];
  if (!handler) return;
  if (handler.kind === "lifecycle") lifecycle(config, handler.lifecycleEvent, input);
  else if (handler.kind === "writeback") await writeback(config, input, handler.eventKind, handler.eventSummary, handler.source);
}

main().catch(() => {
  // Fail soft: Soma observability must never block normal Claude Code use.
});
