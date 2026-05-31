#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function hookDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(hookDir(), "soma-mode-classifier.config.json"), "utf8"));
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
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

function promptFromInput(input) {
  for (const key of ["prompt", "userPrompt", "message", "input"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return "";
}

function runSomaClassification(config, prompt) {
  return spawnSync(config.bunPath, ["src/cli.ts", "algorithm", "classify", "--prompt", prompt || "", "--json"], {
    cwd: config.trustedSomaRepo,
    encoding: "utf8",
    timeout: 3000,
    env: process.env,
  });
}

function parseClassification(output) {
  try {
    return JSON.parse(output);
  } catch {
    return { mode: "algorithm", effort: "E3", source: "fail-safe", reason: "Classifier returned invalid JSON." };
  }
}

function truncateDetails(text, maxLength = 500) {
  if (!text || text.length <= maxLength) return text || "";
  return `${text.slice(0, maxLength)}...`;
}

function renderModeContext(classification) {
  const mode = String(classification.mode || "algorithm").toLowerCase();
  const effort = typeof classification.effort === "string" ? classification.effort : "";
  const source = classification.source || "unknown";
  const reason = classification.reason || "No classifier reason returned.";
  const label = effort ? `${mode.toUpperCase()} ${effort}` : mode.toUpperCase();
  const lines = [
    `Soma MODE: ${label} (${source}).`,
    `Classifier reason: ${reason}`,
  ];

  if (mode === "algorithm") {
    lines.push(
      `Use the Algorithm rendering contract for ${effort || "E3"} work.`,
      "Do not downshift to native execution unless the principal explicitly overrides this classification.",
    );
  } else if (mode === "native") {
    lines.push(
      "Use the substrate-native workflow; do not start an Algorithm run unless the principal explicitly asks for one.",
      "Do not upshift to Algorithm only because Soma is installed.",
    );
  } else {
    lines.push(
      "Treat this as a minimal acknowledgement or small conversational turn.",
      "Do not start an Algorithm run or expand scope unless the principal explicitly asks.",
    );
  }

  return lines.join("\n");
}

function emitAndExit(payload) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

function emitFailOpen(reason) {
  emitAndExit({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `Soma mode classifier unavailable; continue natively unless this prompt clearly needs Algorithm. ${truncateDetails(reason)}`,
    },
  });
}

function main() {
  const config = readConfig();
  if (config.error || typeof config.bunPath !== "string" || typeof config.trustedSomaRepo !== "string") {
    emitFailOpen(config.error || "Invalid mode classifier config.");
  }
  const input = readHookInput();
  const result = runSomaClassification(config, promptFromInput(input));
  if (result.status !== 0) {
    emitFailOpen(result.stderr || result.stdout || "");
  }
  emitAndExit({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: renderModeContext(parseClassification(result.stdout)),
    },
  });
}

main();
