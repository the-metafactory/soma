// Grok lifecycle dispatcher, ported from codex-hook-entry.mjs with
// the Grok-specific deltas verified live on 2026-06-10 (tool-name
// enumeration probe, grok 0.2.38):
//   - payload keys are camelCase (`sessionId`, `toolName`, `toolInput`)
//     with snake_case event values (`session_start`); the snake_case
//     codex aliases are still read for safety.
//   - `GROK_SESSION_ID` is injected on every hook process and equals the
//     ACP sessionId; hook cardinality is per-session, so session-start
//     dedups behind a first-writer-wins guard keyed on it.
//   - Grok 0.2.38 ignores passive-hook stdout, so the projected
//     startup-context.md (pointed at by the `soma` skill) is the
//     load-bearing context surface; the JSON emitted here is the tested
//     contract and works unchanged if Grok adopts Claude-shaped output.
//   - Policy chain: Grok's hook platform is FAIL-OPEN (crash/timeout
//     allows the call — 10-hooks.md), so fail-closed lives INSIDE the
//     hook: every PreToolUse failure path emits the documented deny
//     shape {"decision":"deny","reason":...} (honored regardless of
//     exit code) before exiting. UserPromptSubmit cannot
//     block on 0.2.38 (only PreToolUse can); its runtime inspection
//     still records denials (`--record deny`) and emits the block shape
//     as the tested, forward-compatible contract.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractInboundContentTargets, extractWriteTargets, shouldCheckPolicyTarget } from "./grok-policy-targets.mjs";
import { GROK_PRE_TOOL_USE_VERB } from "./grok-hook-verbs.mjs";
// __SOMA_HOOK_MODULE_IMPORTS__

// __SOMA_PROMPT_SUBMIT_EXTENSION_START__
function runSomaFeedbackCapture(config, prompt) {
  void config;
  void prompt;
}
// __SOMA_PROMPT_SUBMIT_EXTENSION_END__

const STALE_SESSION_GUARD_MS = 7 * 24 * 60 * 60 * 1000;

function readHookInput() {
  try {
    const parsed = JSON.parse(readFileSync(0, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { __somaParseError: "hook input must be a JSON object" };
    }
    return parsed;
  } catch (error) {
    return { __somaParseError: error instanceof Error ? error.message : String(error) };
  }
}

function hookSessionId(input) {
  const candidate = input.sessionId || input.session_id || process.env.GROK_SESSION_ID;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function runSomaCommand(config, args, env = {}) {
  return spawnSync(config.bunPath, args, {
    cwd: config.trustedSomaRepo,
    encoding: "utf8",
    timeout: 25000,
    env: { ...process.env, ...env },
  });
}

function runSomaLifecycle(config, event, sessionId) {
  const args = ["run", "soma", "lifecycle", event, "--soma-home", config.somaHome, "--substrate", "grok"];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }

  return runSomaCommand(config, args);
}

function runSomaClassification(config, prompt) {
  return runSomaCommand(config, ["run", "soma", "algorithm", "classify", "--prompt", prompt || "", "--json"]);
}

function runSomaPolicyCheck(config, targets, action = "write") {
  const args = [
    "run",
    "soma",
    "policy",
    "check",
    "--soma-home",
    config.somaHome,
    "--substrate",
    "grok",
    "--action",
    action,
    "--targets-env",
    "SOMA_POLICY_TARGETS",
    "--record",
    "deny",
    "--json",
  ];
  for (const privateRoot of config.privateRoots || []) {
    args.push("--private-root", privateRoot);
  }

  return runSomaCommand(config, args, { SOMA_POLICY_TARGETS: JSON.stringify(targets) });
}

function runSomaInboundContentScan(config, target) {
  return runSomaCommand(config, [
    "run",
    "soma",
    "policy",
    "scan",
    "--soma-home",
    config.somaHome,
    "--substrate",
    "grok",
    "--path",
    target.filePath,
    "--record",
    "deny",
    "--json",
  ]);
}

function runSomaRuntimePolicyInspect(config, surface, payload) {
  const args = [
    "run",
    "soma",
    "policy",
    "inspect",
    "--soma-home",
    config.somaHome,
    "--substrate",
    "grok",
    "--surface",
    surface,
    "--record",
    "deny",
    "--json",
  ];
  const env = {};
  if (surface === "prompt") {
    args.push("--prompt-env", "SOMA_RUNTIME_POLICY_PROMPT");
    env.SOMA_RUNTIME_POLICY_PROMPT = payload.prompt || "";
  } else if (surface === "tool_call") {
    args.push("--tool-name", payload.toolName || "");
    args.push("--tool-input-env", "SOMA_RUNTIME_POLICY_TOOL_INPUT");
    const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input) ? payload.input : { raw: String(payload.input || "") };
    env.SOMA_RUNTIME_POLICY_TOOL_INPUT = JSON.stringify(input);
  }

  return runSomaCommand(config, args, env);
}

function emitAndExit(payload) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

// Grok's documented blocking contract (10-hooks.md): a deny payload on
// stdout blocks regardless of exit code. This hook always emits exit 2, the
// documented explicit-deny signal, so the deny lands on both channels. The
// "any exit code" half is grok's platform contract from the hook docs — these
// tests assert the stdout shape and exit 2, not the cross-exit-code behavior,
// since none launches a live grok.
function denyPreToolUse(reason) {
  console.log(JSON.stringify({ decision: "deny", reason }));
  process.exit(2);
}

function allowPreToolUse() {
  emitAndExit({ decision: "allow" });
}

// UserPromptSubmit is passive on grok 0.2.38 — this output is the tested
// contract (and activates if Grok ever honors it); the live effect today
// is the `--record deny` audit entry written by the inspection itself.
function denyPromptSubmit(reason) {
  emitAndExit({
    continue: false,
    stopReason: reason,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      decision: "block",
      reason,
    },
  });
}

function parseRuntimePolicyResult(output, failurePrefix) {
  let inspection;
  try {
    inspection = JSON.parse(output);
  } catch {
    throw new Error(`${failurePrefix} returned invalid JSON: ${output || "empty output"}`);
  }
  if (!inspection || typeof inspection !== "object" || typeof inspection.decision !== "string") {
    throw new Error(`${failurePrefix} returned unexpected structure: ${output || "empty output"}`);
  }
  return inspection;
}

function shouldBlockRuntimePolicyDecision(decision) {
  // Grok PreToolUse has no portable "ask principal" shape, so Soma's
  // substrate-neutral ask decision projects to a denial with an approval reason.
  return decision === "deny" || decision === "ask";
}

function parseClassification(output) {
  try {
    return JSON.parse(output);
  } catch {
    // Fall through for older Soma CLIs that render key-value text.
  }

  const fields = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator === -1) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 2).trim();
  }
  return fields;
}

function shouldPrimeAlgorithmRendering(classification) {
  const mode = (classification.mode || "").toLowerCase();
  return mode === "algorithm" && classification.effort && classification.effort !== "E1" && classification.effort !== "none";
}

function algorithmPromptHookOutput(classification) {
  const mode = (classification.mode || "algorithm").toUpperCase();
  const effort = classification.effort && classification.effort !== "none" ? classification.effort : "";
  const source = classification.source || "unknown";
  const label = effort ? `${mode} ${effort}` : mode;

  if (!shouldPrimeAlgorithmRendering(classification)) {
    return { continue: true };
  }

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `Soma: ${label} (${source}). This prompt classified as ALGORITHM.`,
        "Use the seven-phase rendering contract from `~/.grok/skills/the-algorithm/SKILL.md`.",
        "Emit each phase banner verbatim before producing that phase's content.",
      ].join("\n"),
    },
  };
}

function projectedStartupContextPath(config) {
  // Absolute via the install-time grokHome — never process.env.HOME,
  // which is unset on stock Windows.
  return join(config.grokHome, config.startupContextPath);
}

function writeProjectedStartupContext(config, output) {
  const marker = "# Soma Startup Context";
  const index = output.indexOf(marker);
  if (index === -1) return undefined;
  const context = output.slice(index).trim();
  writeFileSync(projectedStartupContextPath(config), `${context}\n`, "utf8");
  return context;
}

function readProjectedStartupContext(config) {
  try {
    return readFileSync(projectedStartupContextPath(config), "utf8").trim();
  } catch {
    return undefined;
  }
}

export function renderStartupContextSummary(context) {
  if (!context) return "Soma: startup context unavailable; read the projected Soma startup context when needed.";
  const assistant = context.match(/^Assistant:\s*(.+)$/m)?.[1]?.trim();
  const principal = context.match(/^Principal:\s*(.+)$/m)?.[1]?.trim();
  const activeRunsSection = context.match(/(?:^|\n)## Active Algorithm Runs\n(?<section>[\s\S]*?)(?=\n## |$)/)?.groups?.section ?? "";
  const activeRuns = [...activeRunsSection.matchAll(/^- [^\n]+$/gm)].length;
  const identity = assistant && principal ? `${assistant} for ${principal}` : assistant || "startup context";
  const runText = activeRuns === 1 ? "1 active run" : `${activeRuns} active runs`;
  return `Soma: ${identity}; ${runText}. Full context is in the projected startup-context.md.`;
}

function pruneStaleSessionGuards(guardDir) {
  try {
    for (const name of readdirSync(guardDir)) {
      const path = join(guardDir, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_SESSION_GUARD_MS) unlinkSync(path);
      } catch {
        // Best-effort pruning; a contested file just waits for next time.
      }
    }
  } catch {
    // Unreadable guard dir falls through to the mkdir below.
  }
}

/**
 * First-writer-wins session-start guard keyed on the Grok session id
 * (SessionStart fires once per session even under a shared
 * leader, so the session id is the dedup unit). Returns true when this
 * process owns the session-start body. Guard failures other than
 * "already claimed" run the body anyway: a duplicated session-start is
 * benign, a silently skipped one loses the context load.
 */
function acquireSessionStartGuard(config, sessionId) {
  if (!sessionId) return true;
  try {
    const guardDir = join(config.somaHome, "memory", "STATE", "grok-session-guards");
    mkdirSync(guardDir, { recursive: true });
    pruneStaleSessionGuards(guardDir);
    const guardPath = join(guardDir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    writeFileSync(guardPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") return false;
    return true;
  }
}

// The fail-closed PreToolUse chain, ported from codex.
// Order: runtime-policy inspect (every call) → inbound-content scan
// (untrusted-root reads) → write-target policy check (extracted private
// targets). Each leg denies on failure, bad JSON, or an explicit
// deny/ask decision. Deny is honored regardless of exit code and
// `--yolo` does not bypass it; denies are turn-fatal in headless 0.2.38.
//
// Each leg below is a pure decision helper returning the deny reason or
// undefined; process exit stays with the handlers so the fail-closed
// emission shape lives in exactly one place per event.
function policyCommandOutput(result) {
  return result.stdout || result.stderr || "";
}

function runtimePolicyDenyReason(config, surface, payload) {
  const result = runSomaRuntimePolicyInspect(config, surface, payload);
  const output = policyCommandOutput(result);
  if (result.status !== 0) {
    return `Soma runtime policy inspection failed closed: ${output || "unknown error"}`;
  }
  let inspection;
  try {
    inspection = parseRuntimePolicyResult(output, "Soma runtime policy inspection");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (shouldBlockRuntimePolicyDecision(inspection.decision)) {
    return inspection.reason || `Soma runtime policy ${inspection.decision}.`;
  }
  return undefined;
}

function inboundScanDenyReason(result) {
  const output = policyCommandOutput(result);
  if (result.status !== 0) {
    return `Soma inbound content scan failed closed: ${output || "unknown error"}`;
  }
  let scan;
  try {
    scan = JSON.parse(output);
  } catch {
    return `Soma inbound content scan returned invalid JSON: ${output || "empty output"}`;
  }
  if (!scan || typeof scan !== "object" || typeof scan.decision !== "string") {
    return `Soma inbound content scan returned unexpected structure: ${output || "empty output"}`;
  }
  // Allowlist, not denylist: only an explicit ALLOWED passes. Denying solely
  // on BLOCKED/HUMAN_REVIEW let an unrecognized non-empty decision fall
  // through to allow — fail-open on the one value the hook can't anticipate.
  // The server normalizes unknowns to HUMAN_REVIEW today, but the hook must
  // not depend on that to stay closed.
  if (scan.decision !== "ALLOWED") {
    return `Soma inbound content ${scan.decision}: ${scan.reason || "scan did not allow this content"}`;
  }
  return undefined;
}

function inboundContentDenyReason(config, input) {
  for (const target of extractInboundContentTargets(config, input)) {
    const reason = inboundScanDenyReason(runSomaInboundContentScan(config, target));
    if (reason) return reason;
  }
  return undefined;
}

function writeTargetPolicyDenyReason(config, input) {
  const targets = extractWriteTargets(config, input).filter((target) => shouldCheckPolicyTarget(config, target));
  if (targets.length === 0) return undefined;
  const result = runSomaPolicyCheck(config, targets);
  const output = policyCommandOutput(result);
  if (result.status !== 0) {
    return `Soma policy check failed closed: ${output || "unknown error"}`;
  }
  let policy;
  try {
    policy = JSON.parse(output);
  } catch {
    return `Soma policy check returned invalid JSON: ${output || "empty output"}`;
  }
  if (policy.decision === "deny") {
    return policy.reason || "Soma private context policy denied this write.";
  }
  return undefined;
}

function handlePreToolUse(config, input) {
  if (input.__somaParseError) {
    denyPreToolUse(`Soma policy check failed closed: malformed hook input (${input.__somaParseError})`);
    return;
  }
  const reason =
    runtimePolicyDenyReason(config, "tool_call", {
      toolName: input.toolName || input.tool_name,
      input: input.toolInput || input.tool_input || {},
    }) ??
    inboundContentDenyReason(config, input) ??
    writeTargetPolicyDenyReason(config, input);
  if (reason) {
    denyPreToolUse(reason);
    return;
  }
  allowPreToolUse();
}

function handlePromptSubmit(config, input) {
  const runtimeReason = runtimePolicyDenyReason(config, "prompt", { prompt: input.prompt });
  if (runtimeReason) {
    denyPromptSubmit(runtimeReason);
    return;
  }

  runSomaFeedbackCapture(config, input.prompt);
  const result = runSomaClassification(config, input.prompt);
  if (result.status !== 0) {
    emitAndExit({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Soma prompt classification failed; if this prompt is substantial, use the-algorithm manually. ${result.stderr || result.stdout || ""}`,
      },
    });
  }
  emitAndExit(algorithmPromptHookOutput(parseClassification(result.stdout)));
}

// PreCompact persists the active Algorithm/ISA state through
// the algorithm-observed lifecycle shell-out — work index, active-run
// pointer, and observation provenance land in ~/.soma before the
// context window is cut. The startup context itself is already durable
// on disk (projected at session-start), so no re-render happens here.
function handlePreCompact(config, input) {
  const result = runSomaLifecycle(config, "algorithm-observed", hookSessionId(input));
  if (result.status !== 0) {
    emitAndExit({
      continue: true,
      systemMessage: "Soma pre-compact persist failed; active Algorithm state may be stale after compaction.",
    });
  }
  emitAndExit({ continue: true, systemMessage: "Soma pre-compact persisted active Algorithm state." });
}

// PostCompact re-points the model at Soma context after the
// cut. Pure file read — no shell-out — so it stays cheap and works even
// when the soma repo is unusable mid-session. Grok 0.2.38 ignores
// passive-hook stdout, so the projected startup-context.md (pointed at
// by the `soma` skill) remains the load-bearing surface; this JSON is
// the tested contract and activates if Grok ever honors hook output.
function handlePostCompact(config) {
  emitAndExit({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostCompact",
      additionalContext: renderStartupContextSummary(readProjectedStartupContext(config)),
    },
  });
}

function handleLifecycleEvent(config, event, input) {
  const sessionId = hookSessionId(input);
  if (event === "session-start" && !acquireSessionStartGuard(config, sessionId)) {
    emitAndExit({ continue: true, systemMessage: `Soma session-start already handled for session ${sessionId}.` });
  }

  const result = runSomaLifecycle(config, event, sessionId);

  if (result.status !== 0) {
    if (event === "session-start") {
      const context = readProjectedStartupContext(config);
      emitAndExit({
        continue: true,
        systemMessage: "Soma lifecycle hook fell back to projected startup context.",
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: renderStartupContextSummary(context),
        },
      });
    }

    emitAndExit({ continue: true, systemMessage: `Soma lifecycle hook failed for ${event}; read projected Soma context when needed.` });
  }

  if (event === "session-start") {
    const context = writeProjectedStartupContext(config, result.stdout) || readProjectedStartupContext(config);
    emitAndExit({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: renderStartupContextSummary(context || result.stdout),
      },
    });
  }

  emitAndExit({ continue: true, systemMessage: `Soma lifecycle ${event} handled.` });
}

export function runGrokHook(config, event = process.argv[2], input = readHookInput()) {
  if (event === GROK_PRE_TOOL_USE_VERB) {
    // Backstop for the fail-open platform: an unexpected throw anywhere
    // in the chain must still end in an explicit deny, never a crash.
    try {
      handlePreToolUse(config, input);
    } catch (error) {
      denyPreToolUse(`Soma policy hook failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (event === "prompt-submit") {
    handlePromptSubmit(config, input);
  } else if (event === "pre-compact") {
    handlePreCompact(config, input);
  } else if (event === "post-compact") {
    handlePostCompact(config);
  } else if (event === "session-start" || event === "algorithm-updated" || event === "session-end") {
    handleLifecycleEvent(config, event, input);
  }

  console.log(JSON.stringify({ continue: true }));
}
