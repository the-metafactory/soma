import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractInboundContentTargets, extractWriteTargets, shouldCheckPolicyTarget } from "./codex-policy-hook.mjs";
// __SOMA_HOOK_MODULE_IMPORTS__

// __SOMA_PROMPT_SUBMIT_EXTENSION_START__
function runSomaFeedbackCapture(config, prompt) {
  void config;
  void prompt;
}
// __SOMA_PROMPT_SUBMIT_EXTENSION_END__

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

function runSomaCommand(config, args, env = {}) {
  return spawnSync(config.bunPath, args, {
    cwd: config.trustedSomaRepo,
    encoding: "utf8",
    timeout: 25000,
    env: { ...process.env, ...env },
  });
}

function codexHome(config) {
  return resolve(dirname(resolve(config.somaHome)), ".codex");
}

function codexTranscriptRoot(config) {
  return resolve(join(codexHome(config), "sessions"));
}

function isSafeTranscriptPath(candidate, root) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return false;
  const target = resolve(candidate);
  if (!isAbsolute(candidate) || !target.endsWith(".jsonl")) return false;
  const rel = relative(root, target);
  if (rel === "" || rel.includes("/") || rel.includes("\\") || rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    const rootReal = realpathSync(root);
    const parentReal = realpathSync(dirname(target));
    const realRel = relative(rootReal, parentReal);
    if (realRel !== "" && (realRel.startsWith("..") || isAbsolute(realRel))) return false;
    const stat = lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function findSessionTranscript(root, sessionId) {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return undefined;
  const candidate = join(root, `${sessionId}.jsonl`);
  return isSafeTranscriptPath(candidate, root) ? candidate : undefined;
}

function resolveSessionTranscript(config, input, sessionId) {
  const root = codexTranscriptRoot(config);
  const explicit =
    typeof input.transcript_path === "string" ? input.transcript_path :
    typeof input.transcriptPath === "string" ? input.transcriptPath :
    undefined;
  if (explicit && isSafeTranscriptPath(explicit, root)) return explicit;
  if (explicit) return undefined;
  return findSessionTranscript(root, sessionId);
}

function runSomaLifecycle(config, event, input) {
  const sessionId = typeof input.session_id === "string" && input.session_id.trim().length > 0 ? input.session_id : undefined;
  const args = ["run", "soma", "lifecycle", event, "--soma-home", config.somaHome, "--substrate", "codex"];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  if (typeof input.cwd === "string" && input.cwd.trim().length > 0) {
    args.push("--cwd", input.cwd);
  } else if (typeof process.cwd() === "string" && process.cwd().trim().length > 0) {
    args.push("--cwd", process.cwd());
  }
  if (event === "session-end" && sessionId) {
    const transcript = resolveSessionTranscript(config, input, sessionId);
    if (transcript) {
      args.push("--transcript", transcript);
    }
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
    "codex",
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
    "codex",
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
    "codex",
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

function denyPreToolUse(reason) {
  emitAndExit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

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
  // Codex PreToolUse has no portable "ask principal" shape here, so Soma's
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
        'Use the seven-phase rendering contract from `~/.codex/skills/the-algorithm/SKILL.md`.',
        "Emit each phase banner verbatim before producing that phase's content.",
      ].join("\n"),
    },
  };
}

function writeProjectedStartupContext(output) {
  const marker = "# Soma Startup Context";
  const index = output.indexOf(marker);
  if (index === -1) return undefined;
  const context = output.slice(index).trim();
  writeFileSync(`${process.env.HOME}/.codex/memories/soma/startup-context.md`, `${context}\n`, "utf8");
  return context;
}

function readProjectedStartupContext() {
  try {
    return readFileSync(`${process.env.HOME}/.codex/memories/soma/startup-context.md`, "utf8").trim();
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

function handlePreToolUse(config, input) {
  if (input.__somaParseError) {
    denyPreToolUse(`Soma policy check failed closed: malformed hook input (${input.__somaParseError})`);
  }
  const runtimeResult = runSomaRuntimePolicyInspect(config, "tool_call", {
    toolName: input.tool_name || input.toolName,
    input: input.tool_input || input.toolInput || {},
  });
  const runtimeOutput = runtimeResult.stdout || runtimeResult.stderr || "";
  if (runtimeResult.status !== 0) {
    denyPreToolUse(`Soma runtime policy inspection failed closed: ${runtimeOutput || "unknown error"}`);
  }
  let runtimeInspection;
  try {
    runtimeInspection = parseRuntimePolicyResult(runtimeOutput, "Soma runtime policy inspection");
  } catch (error) {
    denyPreToolUse(error instanceof Error ? error.message : String(error));
    return;
  }
  if (shouldBlockRuntimePolicyDecision(runtimeInspection.decision)) {
    denyPreToolUse(runtimeInspection.reason || `Soma runtime policy ${runtimeInspection.decision}.`);
    return;
  }

  const inboundTargets = extractInboundContentTargets(config, input);
  for (const target of inboundTargets) {
    const result = runSomaInboundContentScan(config, target);
    const output = result.stdout || result.stderr || "";
    if (result.status !== 0) {
      denyPreToolUse(`Soma inbound content scan failed closed: ${output || "unknown error"}`);
    }
    let scan;
    try {
      scan = JSON.parse(output);
    } catch {
      denyPreToolUse(`Soma inbound content scan returned invalid JSON: ${output || "empty output"}`);
    }
    if (!scan || typeof scan !== "object" || typeof scan.decision !== "string") {
      denyPreToolUse(`Soma inbound content scan returned unexpected structure: ${output || "empty output"}`);
    }
    if (scan.decision === "BLOCKED" || scan.decision === "HUMAN_REVIEW") {
      denyPreToolUse(`Soma inbound content ${scan.decision}: ${scan.reason || "scan did not allow this content"}`);
    }
  }
  const targets = extractWriteTargets(config, input).filter((target) => shouldCheckPolicyTarget(config, target));
  if (targets.length > 0) {
    const result = runSomaPolicyCheck(config, targets);
    const output = result.stdout || result.stderr || "";
    if (result.status !== 0) {
      denyPreToolUse(`Soma policy check failed closed: ${output || "unknown error"}`);
    }
    let policy;
    try {
      policy = JSON.parse(output);
    } catch {
      denyPreToolUse(`Soma policy check returned invalid JSON: ${output || "empty output"}`);
    }
    if (policy.decision === "deny") {
      const reason = policy.reason || "Soma private context policy denied this write.";
      denyPreToolUse(reason);
    }
  }
  emitAndExit({ continue: true });
}

function handlePromptSubmit(config, input) {
  const runtimeResult = runSomaRuntimePolicyInspect(config, "prompt", { prompt: input.prompt });
  const runtimeOutput = runtimeResult.stdout || runtimeResult.stderr || "";
  if (runtimeResult.status !== 0) {
    denyPromptSubmit(`Soma runtime policy inspection failed closed: ${runtimeOutput || "unknown error"}`);
  }
  let runtimeInspection;
  try {
    runtimeInspection = parseRuntimePolicyResult(runtimeOutput, "Soma runtime policy inspection");
  } catch (error) {
    denyPromptSubmit(error instanceof Error ? error.message : String(error));
    return;
  }
  if (shouldBlockRuntimePolicyDecision(runtimeInspection.decision)) {
    denyPromptSubmit(runtimeInspection.reason || `Soma runtime policy ${runtimeInspection.decision}.`);
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

function handleLifecycleEvent(config, event, input) {
  const result = runSomaLifecycle(config, event, input);

  if (result.status !== 0) {
    if (event === "session-start") {
      const context = readProjectedStartupContext();
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
    const context = writeProjectedStartupContext(result.stdout) || readProjectedStartupContext();
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

export function runCodexHook(config, event = process.argv[2], input = readHookInput()) {
  if (event === "pre-tool-use") {
    handlePreToolUse(config, input);
  } else if (event === "prompt-submit") {
    handlePromptSubmit(config, input);
  } else if (event === "session-start" || event === "algorithm-updated" || event === "session-end") {
    handleLifecycleEvent(config, event, input);
  }

  console.log(JSON.stringify({ continue: true }));
}
