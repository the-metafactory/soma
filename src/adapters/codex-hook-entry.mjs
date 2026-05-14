import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extractWriteTargets, shouldCheckPolicyTarget } from "./codex-policy-hook.mjs";

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
  const reason = classification.reason || "No reason provided.";
  const lines = [
    "# Soma Prompt Classification",
    `MODE: ${mode}`,
    effort ? `TIER: ${effort}` : undefined,
    `SOURCE: ${source}`,
    `REASON: ${reason}`,
    "",
  ].filter(Boolean);

  if (mode === "ALGORITHM") {
    lines.push(
      "Operating requirement:",
      "- Use the `the-algorithm` skill for this turn.",
      "- Before giving a substantive answer, create or update a Soma Algorithm run unless this prompt only continues an already-active run.",
      "- Use the classified TIER as the effort level unless the user explicitly overrides it.",
      "- Preserve verification evidence in the run before declaring the answer complete.",
    );
  } else {
    lines.push(
      "Operating requirement:",
      "- This prompt may stay outside the full Algorithm harness unless conversation context makes it Algorithm-shaped.",
    );
  }

  return lines.join("\n");
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
        systemMessage: `Soma lifecycle hook fell back to projected context: ${result.stderr || result.stdout || "unknown error"}`,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context || "Soma lifecycle context is unavailable; read ~/.codex/memories/soma/ when needed.",
        },
      });
    }

    emitAndExit({ continue: true, systemMessage: `Soma lifecycle hook failed: ${result.stderr || result.stdout || "unknown error"}` });
  }

  if (event === "session-start") {
    const context = writeProjectedStartupContext(result.stdout) || readProjectedStartupContext();
    emitAndExit({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context || result.stdout,
      },
    });
  }

  emitAndExit({ continue: true, systemMessage: result.stdout.trim() });
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
