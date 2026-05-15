import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extractWriteTargets, shouldCheckPolicyTarget } from "./codex-policy-hook.mjs";
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

function runSomaLifecycle(config, event, sessionId) {
  const args = ["run", "soma", "lifecycle", event, "--soma-home", config.somaHome, "--substrate", "codex"];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }

  return runSomaCommand(config, args);
}

function runSomaClassification(config, prompt) {
  return runSomaCommand(config, ["run", "soma", "algorithm", "classify", "--prompt", prompt || ""]);
}

function runSomaPolicyCheck(config, targets) {
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
    "write",
    "--targets-env",
    "SOMA_POLICY_TARGETS",
    "--record",
    "deny",
    "--json",
  ];

  return runSomaCommand(config, args, { SOMA_POLICY_TARGETS: JSON.stringify(targets) });
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

function parseClassification(output) {
  const fields = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator === -1) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 2).trim();
  }
  return fields;
}

function renderPromptClassificationContext(classification) {
  const mode = (classification.mode || "algorithm").toUpperCase();
  const effort = classification.effort && classification.effort !== "none" ? classification.effort : "";
  const source = classification.source || "unknown";
  const label = effort ? `${mode} ${effort}` : mode;

  if (mode === "ALGORITHM") {
    return `Soma: ${label} (${source}). Use the-algorithm; create/update the run and record verification evidence.`;
  }

  return `Soma: ${label} (${source}). Full Algorithm harness optional unless context makes it substantial.`;
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
  const context = renderPromptClassificationContext(parseClassification(result.stdout));
  emitAndExit({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  });
}

function handleLifecycleEvent(config, event, input) {
  const result = runSomaLifecycle(config, event, input.session_id);

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
