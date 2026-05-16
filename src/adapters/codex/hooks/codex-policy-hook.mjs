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

function resolveShellPath(config, path, cwd) {
  if (path.startsWith("~/.soma")) {
    return `${config.somaHome}${path.slice("~/.soma".length)}`;
  }

  if (path.startsWith("~/") && config.somaHome.endsWith("/.soma")) {
    return `${config.somaHome.slice(0, -"/.soma".length)}/${path.slice(2)}`;
  }

  return path.startsWith("~/") ? path : resolveToolPath(path, cwd);
}

function cleanShellToken(token) {
  return token.replace(/^[<>"']+|[>"']+$/g, "");
}

function tokenizeShellCommand(command) {
  return [...(command || "").matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)].map((match) => cleanShellToken(match[1] || match[2] || match[0])).filter(Boolean);
}

function hasPrivatePathReference(config, token, cwd) {
  if (!token) return false;
  if (hasSomaPolicyMarker(config, token)) return true;
  if (token === ".soma" || token.startsWith(".soma/") || token.startsWith("./.soma/")) return true;
  if (token.startsWith(".codex/memories/soma/") || token.startsWith("./.codex/memories/soma/")) return true;
  if (token.startsWith(".pi/agent/soma/") || token.startsWith("./.pi/agent/soma/")) return true;
  const resolved = resolveToolPath(token, cwd);
  return config.policyMarkers.some((marker) => {
    if (!marker.startsWith("/")) return false;
    const root = marker.endsWith("/") ? marker.slice(0, -1) : marker;
    return resolved === root || resolved.startsWith(`${root}/`);
  });
}

function firstPrivatePathToken(config, tokens, cwd) {
  return tokens.find((token) => hasPrivatePathReference(config, token, cwd));
}

function lastPathToken(tokens) {
  return [...tokens].reverse().find((token) => token && !token.startsWith("-") && token !== "--");
}

function redirectionTarget(tokens) {
  const redirectIndex = tokens.findIndex((token) => token === ">" || token === ">>");
  if (redirectIndex !== -1) return tokens[redirectIndex + 1];
  const redirectToken = tokens.find((token) => token.startsWith(">") && token.length > 1);
  return redirectToken ? redirectToken.replace(/^>+/, "") : undefined;
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
  const tokens = tokenizeShellCommand(context.command);
  const privateSource = firstPrivatePathToken(config, tokens, context.cwd);
  if (!privateSource) return [];

  const command = tokens[0] || "";
  if (command === "cp" || command === "mv" || command === "rsync") {
    const destination = lastPathToken(tokens.slice(1));
    if (destination && destination !== privateSource) {
      return [{ filePath: resolveShellPath(config, destination, context.cwd), sourcePath: resolveShellPath(config, privateSource, context.cwd), content: "" }];
    }
  }

  const redirectedDestination = redirectionTarget(tokens);
  if (redirectedDestination) {
    return [{ filePath: resolveShellPath(config, redirectedDestination, context.cwd), sourcePath: resolveShellPath(config, privateSource, context.cwd), content: "" }];
  }

  if (command === "tee") {
    const destination = lastPathToken(tokens.slice(1));
    if (destination && destination !== privateSource) {
      return [{ filePath: resolveShellPath(config, destination, context.cwd), sourcePath: resolveShellPath(config, privateSource, context.cwd), content: "" }];
    }
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
