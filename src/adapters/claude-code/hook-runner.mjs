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
  // M5b: on SessionEnd, forward the transcript path + sub-agent markers so the
  // lifecycle handler can attempt the deterministic digest FALLBACK (dispatched to the
  // Claude Code transcript adapter — `soma memory digest` itself stays neutral/body-only).
  // Assistant-authored digests come from the wrap-up rule, not here.
  if (event === "session-end") {
    const transcriptPath =
      typeof input.transcript_path === "string" && input.transcript_path.trim().length > 0 ? input.transcript_path : undefined;
    if (transcriptPath) args.push("--transcript", transcriptPath);
    // Claude Code's payload keys are `agent_id`/`agent_type`; Soma's flags are the
    // qualified `--subagent-*` (bare `agent` is banned in Soma surfaces).
    if (typeof input.agent_id === "string" && input.agent_id.trim().length > 0) args.push("--subagent-id", input.agent_id);
    if (typeof input.agent_type === "string" && input.agent_type.trim().length > 0) args.push("--subagent-type", input.agent_type);
  }
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

// 2026-07-10 proxy-drift audit §3: ~89% of 52k events (per-tool writeback +
// session bookkeeping) have no automated reader, so the hook's append cost on
// every tool call buys nothing. The high-volume `writeback.claude_code.tool`
// event is sampled 1-in-N; session start/end and subagent events are left
// unsampled (low-volume and consumed). See docs/harness-objective-function.md.
const WRITEBACK_TOOL_SAMPLE_RATE = 10;

// FNV-1a 32-bit — a cheap, well-distributed, dependency-free string hash. Used
// only to bucket a tool call for sampling, never for anything security-bearing.
function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Stateless 1-in-N sampler for the high-volume `writeback.claude_code.tool`
// event (Sage review, PR #455): the earlier version read+wrote a counter file on
// EVERY tool call — two blocking FS ops even for the ~90% of calls it then
// dropped. This derives the keep/drop decision from a hash of the call's own
// identity instead, so a skipped call touches no disk at all, and there is no
// shared counter to race across parallel hook processes. Deterministic and
// replayable (same call → same decision), which is why it is a hash and not
// Math.random. The rate is statistical (~1/N over distinct calls), not an exact
// stride — acceptable, since the counter version was already only approximate
// under concurrency. Same-file re-edits within a session share a key and thus a
// decision; that is fine for sampling. An identity-less call (no session/tool/
// path) hashes a constant key — a negligible corner for real tool writebacks.
function shouldSampleToolWriteback(input, source) {
  const sessionId = input && typeof input.session_id === "string" ? input.session_id : "";
  const toolName = input && typeof input.tool_name === "string" ? input.tool_name : "";
  const key = `${sessionId}|${source}|${toolName}|${artifactPaths(input).join(",")}`;
  return fnv1a32(key) % WRITEBACK_TOOL_SAMPLE_RATE === 0;
}

// Match shared Soma VSA files, legacy PAI VSA files during migration, OR a
// project-root `VSA.md`. Anything else is ignored so the sync bridge only fires
// on real VSA edits.
function isVsaPath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.endsWith("/VSA.md") && normalized !== "VSA.md") return false;
  if (/\/\.soma\/memory\/WORK\/[^/]+\/VSA\.md$/.test(normalized)) return true;
  if (/\/MEMORY\/WORK\/[^/]+\/VSA\.md$/.test(normalized)) return true;
  // Otherwise any `VSA.md` basename (project-root OR nested, e.g. src/VSA.md).
  // Broader than the MEMORY/WORK case by design: false positives are harmless
  // because sync-from-isa runs parseVsa, which validates slug + criteria and
  // no-ops on anything that isn't a real VSA.
  return /(^|\/)VSA\.md$/.test(normalized);
}

// Fire-and-forget mirror of any edited VSA file into a soma Algorithm run.
// Detached + failure-isolated: must never block or break the telemetry
// writeback. The sync CLI itself is idempotent and exits 0 on bad input.
function syncVsaPaths(config, input) {
  try {
    for (const path of artifactPaths(input)) {
      if (!isVsaPath(path)) continue;
      runSomaDetached(config, [
        "src/cli.ts",
        "algorithm",
        "sync-from-isa",
        "--isa",
        path,
        "--substrate",
        "claude-code",
        "--soma-home",
        config.somaHome,
      ]);
    }
  } catch {
    // Never propagate — the writeback path owns the hook's success.
  }
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
  // Hook bridge: on tool-edit writebacks, mirror any edited VSA file into a soma
  // Algorithm run so the run is resumable on other substrates. This is
  // FUNCTIONAL, not telemetry — it runs on every PostToolUse edit BEFORE (and
  // independent of) the sampling gate below, so sampling never drops a VSA sync.
  if (source === "PostToolUse") syncVsaPaths(config, input);

  // Sample the high-volume per-tool writeback event (see WRITEBACK_TOOL_SAMPLE_RATE).
  if (kind === "writeback.claude_code.tool" && !shouldSampleToolWriteback(input, source)) return;

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
