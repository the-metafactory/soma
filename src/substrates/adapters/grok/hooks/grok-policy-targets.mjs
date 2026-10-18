// Grok policy-target extraction, ported from codex-policy-targets.mjs
// with the Grok deltas:
//   - The tool-event normalizer reads Grok's verified runtime shape
//     (2026-06-10-003 enumeration table): camelCase `toolName`/`toolInput`,
//     input keys `path`/`contents`/`new_string` — NOT claude's
//     `file_path`/`content`. The snake_case codex aliases stay as
//     fallbacks for safety.
//   - Extractors are keyed by the verified PascalCase tool names the
//     PreToolUse matcher admits (Shell|Read|Write|StrReplace). New tools
//     must be enumerated live before they are added (the docs' alias
//     table is inverted from reality).
//
// This file is the per-adapter TOOL-INPUT layer only. All shell-extraction
// logic — tokenizer, POSIX passes, the pwsh dialect pass, and the
// fail-closed backstop — lives in the descriptor-parameterized sibling
// shell-policy-core.mjs. Grok's deltas enter the core ONLY through the
// descriptor below.
import { resolve } from "node:path";
import {
  createShellPolicyExtractor,
  hasSomaPolicyMarker,
  isUnderRoot,
  policyRelevantContent,
  resolveToolPath,
} from "./shell-policy-core.mjs";

/**
 * Grok's shell-policy descriptor: the relative path-prefix lists that were
 * previously hardcoded in this file's private/protected path checks,
 * reproduced verbatim. The predicate matrix is intentionally uneven —
 * `bare` controls whether the exact bare token (no trailing path) matches:
 * a bare `.soma` is private, but a bare `.grok/skills/soma` matches only
 * the PROTECTED check (its private entry is prefix-only). Exported so the
 * descriptor-sensitivity tests assert against the shipped value, not a
 * copy.
 */
export const GROK_SHELL_POLICY_DESCRIPTOR = Object.freeze({
  privatePathPrefixes: Object.freeze([
    Object.freeze({ path: ".soma", bare: true }),
    Object.freeze({ path: ".grok/skills/soma", bare: false }),
    Object.freeze({ path: ".codex/memories/soma", bare: false }),
    Object.freeze({ path: ".pi/agent/soma", bare: false }),
  ]),
  protectedPathPrefixes: Object.freeze([
    Object.freeze({ path: ".grok/skills/soma", bare: true }),
    Object.freeze({ path: ".codex/memories", bare: true }),
    Object.freeze({ path: ".claude", bare: true }),
  ]),
});

const extractShellTarget = createShellPolicyExtractor(GROK_SHELL_POLICY_DESCRIPTOR);

/** First truthy candidate among key aliases, or undefined. */
function firstAlias(...candidates) {
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Normalize a Grok pre_tool_use payload into the shared invocation
 * context. Grok's verified input keys come first (`path`, `source_path`);
 * codex/claude key names stay as fallbacks so a compat-aliased payload
 * still resolves.
 */
function normalizeToolInvocation(input) {
  const toolName = firstAlias(input.toolName, input.tool_name) || "";
  const rawToolInput = input.toolInput ?? input.tool_input;
  const toolInput = rawToolInput && typeof rawToolInput === "object" && !Array.isArray(rawToolInput) ? rawToolInput : {};
  const cwd = input.cwd || process.cwd();
  const filePath = resolveToolPath(firstAlias(toolInput.path, toolInput.file_path, toolInput.filePath, cwd), cwd);
  const rawSourcePath = firstAlias(toolInput.source_path, toolInput.sourcePath);

  return {
    toolName,
    rawToolInput,
    toolInput,
    cwd,
    filePath,
    sourcePath: rawSourcePath ? resolveToolPath(rawSourcePath, cwd) : undefined,
    command: typeof rawToolInput === "string" ? rawToolInput : firstAlias(toolInput.command, toolInput.cmd) || "",
  };
}

function extractReadInboundContentTarget(config, context) {
  const roots = config.inboundSecurity?.untrustedRoots || [];
  return roots.some((root) => isUnderRoot(resolve(context.filePath), resolve(root))) ? [{ filePath: context.filePath }] : [];
}

function extractWriteTarget(config, context) {
  // Grok Write carries `contents` (the enumeration table), not claude's `content`.
  return [{ filePath: context.filePath, sourcePath: context.sourcePath, content: policyRelevantContent(config, context.toolInput.contents || context.toolInput.content || "") }];
}

function extractEditTarget(config, context) {
  return [{ filePath: context.filePath, sourcePath: context.sourcePath, content: policyRelevantContent(config, context.toolInput.new_string || context.toolInput.newString || "") }];
}

// Verified Grok runtime tool names ONLY (2026-06-10-003). The PreToolUse
// matcher admits exactly these; enumerate live before adding more.
const targetExtractors = {
  Write: extractWriteTarget,
  StrReplace: extractEditTarget,
  Shell: extractShellTarget,
};

const inboundTargetExtractors = {
  Read: extractReadInboundContentTarget,
};

export function extractWriteTargets(config, input) {
  const context = normalizeToolInvocation(input);
  const extractor = targetExtractors[context.toolName];
  return extractor ? extractor(config, context) : [];
}

export function extractInboundContentTargets(config, input) {
  const context = normalizeToolInvocation(input);
  const extractor = inboundTargetExtractors[context.toolName];
  return extractor ? extractor(config, context) : [];
}

export function shouldCheckPolicyTarget(config, target) {
  return target.action === "delete" || target.action === "modify" || Boolean(target.sourcePath) || hasSomaPolicyMarker(config, target.content);
}
