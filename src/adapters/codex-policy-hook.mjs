import { isAbsolute, resolve } from "node:path";
import { hasSomaPolicyPrivateMarker } from "./policy-marker.mjs";

function hasSomaPolicyMarker(config, content) {
  return config.policyMarkers.some((marker) => hasSomaPolicyPrivateMarker(content, marker));
}

function hasPotentialPrivateSourceReference(config, content) {
  if (!content) return false;
  if (hasSomaPolicyMarker(config, content)) return true;
  return config.policyMarkers.some((marker) => marker.startsWith("/") && content.includes(marker.slice(marker.lastIndexOf("/"))));
}

function policyRelevantContent(config, content) {
  if (!hasSomaPolicyMarker(config, content)) return "";
  return (content || "")
    .split("\n")
    .filter((line) => hasSomaPolicyMarker(config, line))
    .join("\n");
}

function resolveToolPath(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd || process.cwd(), path);
}

function normalizeToolInvocation(input) {
  const toolName = input.tool_name || input.toolName || "";
  const rawToolInput = input.tool_input ?? input.toolInput;
  const toolInput = rawToolInput && typeof rawToolInput === "object" && !Array.isArray(rawToolInput) ? rawToolInput : {};
  const cwd = input.cwd || process.cwd();
  const filePath = resolveToolPath(toolInput.file_path || toolInput.filePath || cwd, cwd);
  const rawSourcePath = toolInput.source_path || toolInput.sourcePath;

  return {
    toolName,
    rawToolInput,
    toolInput,
    cwd,
    filePath,
    sourcePath: rawSourcePath ? resolveToolPath(rawSourcePath, cwd) : undefined,
    command: typeof rawToolInput === "string" ? rawToolInput : toolInput.command || toolInput.cmd || "",
  };
}

function pushPatchTarget(config, targets, target) {
  if (!target) return;
  targets.push({
    filePath: target.filePath,
    sourcePath: target.sourcePath,
    content: target.lines.filter((line) => hasSomaPolicyMarker(config, line)).join("\n"),
  });
}

function extractPatchTargets(config, patch, cwd) {
  const targets = [];
  let current;
  const pattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
  const movePattern = /^\*\*\* Move to: (.+)$/;

  for (const line of (patch || "").split("\n")) {
    const moveMatch = line.match(movePattern);
    if (moveMatch) {
      if (current) {
        const originalFilePath = current.filePath;
        current.filePath = resolveToolPath(moveMatch[1].trim(), cwd);
        current.sourcePath = current.sourcePath || originalFilePath;
      } else {
        current = { filePath: resolveToolPath(moveMatch[1].trim(), cwd), sourcePath: config.somaHome, lines: [] };
      }
      continue;
    }

    const fileMatch = line.match(pattern);
    if (fileMatch) {
      pushPatchTarget(config, targets, current);
      current = { filePath: resolveToolPath(fileMatch[1].trim(), cwd), lines: [] };
      continue;
    }

    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.lines.push(line.slice(1));
    }
  }

  pushPatchTarget(config, targets, current);
  return targets;
}

function extractWriteTarget(config, context) {
  return [{ filePath: context.filePath, sourcePath: context.sourcePath, content: policyRelevantContent(config, context.toolInput.content || "") }];
}

function extractEditTarget(config, context) {
  return [{ filePath: context.filePath, sourcePath: context.sourcePath, content: policyRelevantContent(config, context.toolInput.new_string || context.toolInput.newString || "") }];
}

function extractMultiEditTargets(config, context) {
  const edits = Array.isArray(context.toolInput.edits) ? context.toolInput.edits : [];
  return edits.map((edit) => ({
    filePath: context.filePath,
    sourcePath: context.sourcePath,
    content: policyRelevantContent(config, edit?.new_string || edit?.newString || ""),
  }));
}

function extractApplyPatchTargets(config, context) {
  const content =
    typeof context.rawToolInput === "string"
      ? context.rawToolInput
      : context.toolInput.patch || context.toolInput.command || context.toolInput.cmd || JSON.stringify(context.toolInput);
  if (!hasPotentialPrivateSourceReference(config, content) && !content.includes("*** Move to:")) return [];
  const targets = extractPatchTargets(config, content, context.cwd);
  return targets.length > 0 ? targets : [{ filePath: context.cwd, content: policyRelevantContent(config, content) }];
}

function extractShellTarget(config, context) {
  if (hasPotentialPrivateSourceReference(config, context.command)) {
    return [{ filePath: context.cwd, sourcePath: context.command, content: "" }];
  }

  return [];
}

const targetExtractors = {
  Write: extractWriteTarget,
  Edit: extractEditTarget,
  MultiEdit: extractMultiEditTargets,
  apply_patch: extractApplyPatchTargets,
  Bash: extractShellTarget,
  Shell: extractShellTarget,
  exec_command: extractShellTarget,
};

export function extractWriteTargets(config, input) {
  const context = normalizeToolInvocation(input);
  const extractor = targetExtractors[context.toolName];
  return extractor ? extractor(config, context) : [];
}

export function shouldCheckPolicyTarget(config, target) {
  return Boolean(target.sourcePath) || hasSomaPolicyMarker(config, target.content);
}

export function privateShellCommand(config, input) {
  const context = normalizeToolInvocation(input);
  if (context.toolName !== "Bash" && context.toolName !== "Shell" && context.toolName !== "exec_command") return "";
  return hasPotentialPrivateSourceReference(config, context.command) ? context.command : "";
}
