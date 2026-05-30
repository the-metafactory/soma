import { parseBashDestructivePaths } from "../../../policy-path-guard";
import {
  extractToolCallPolicyTargets as extractNormalizedToolCallPolicyTargets,
  somaPolicyActionForToolAction,
  type SomaToolPolicyAction,
  type SomaToolPolicyExtraction,
} from "../../../policy-targets";

export { somaPolicyActionForToolAction };

export interface PiDevToolPolicyExtractionOptions {
  cwd: string;
  maxTargets?: number;
}

function eventBag(event: unknown): Record<string, unknown> {
  return event && typeof event === "object" && !Array.isArray(event) ? event as Record<string, unknown> : {};
}

function firstString(candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function nestedString(event: unknown, keys: string[]): string | undefined {
  const e = eventBag(event);
  const direct = firstString(keys.map((key) => e[key]));
  if (direct) return direct;
  for (const bagKey of ["args", "input"]) {
    const bag = eventBag(e[bagKey]);
    const nested = firstString(keys.map((key) => bag[key]));
    if (nested) return nested;
  }
  return undefined;
}

function toolCallContent(event: unknown): string | undefined {
  return nestedString(event, ["command", "content", "text"]);
}

function toolCallSource(event: unknown): string | undefined {
  return nestedString(event, ["sourcePath", "source_path", "source", "from"]);
}

function toolCallName(event: unknown): string {
  const e = eventBag(event);
  return firstString([e.toolName, e.name])?.toLowerCase() ?? "";
}

function toolCallIsShell(event: unknown): boolean {
  return /(bash|shell)/u.test(toolCallName(event));
}

function toolCallDestinations(event: unknown, cwd: string): string[] {
  if (toolCallIsShell(event)) {
    const command = toolCallContent(event);
    return command ? parseBashDestructivePaths(command, cwd).targetPaths : [];
  }
  const destination = nestedString(event, ["destination", "path", "target", "file_path"]);
  return destination ? [destination] : [];
}

function shellCommandNameFromEvent(event: unknown): string | undefined {
  const command = toolCallContent(event);
  if (!command) return undefined;
  return parseBashDestructivePaths(command, process.cwd()).command.toLowerCase();
}

function isDeleteShellCommand(event: unknown): boolean {
  const command = toolCallContent(event)?.trim();
  if (!command) return false;
  if (/^(sudo\s+|command\s+|env\s+)*\b(rm|delete|trash|unlink)\b/u.test(command)) return true;
  return /^(rm|delete|trash|unlink)$/u.test(shellCommandNameFromEvent(event) ?? "");
}

function isReadOnlyShellCommand(event: unknown): boolean {
  const command = toolCallContent(event)?.trim();
  if (!command || command.includes("`") || /[$\n\r><|;&(){}]/u.test(command)) return false;
  if (parseBashDestructivePaths(command, process.cwd()).targetPaths.length > 0) return false;
  return /^(pwd|ls(\s+-[A-Za-z0-9]+)*(\s+[A-Za-z0-9._/:-]+)*|rg(\s+[-A-Za-z0-9._/:'=]+)*|grep(\s+[-A-Za-z0-9._/:'=]+)*|cat(\s+[A-Za-z0-9._/:-]+)+|git\s+(status|diff|log|show|branch)(\s+[-A-Za-z0-9._/:'=]+)*)$/u.test(command);
}

function toolCallAction(event: unknown): SomaToolPolicyAction {
  const name = toolCallName(event);
  if (/(rm|delete|trash|unlink)/u.test(name)) return "delete";
  if (/(edit|write|patch|cp|copy)/u.test(name)) return "write";
  if (/(bash|shell)/u.test(name) && isDeleteShellCommand(event)) return "delete";
  if (/(bash|shell)/u.test(name) && isReadOnlyShellCommand(event)) return "read";
  if (/(bash|shell)/u.test(name)) return "write";
  if (/(mv|move)/u.test(name)) return "modify";
  if (/^(read|list|search|grep|find|query|view)([_:-].*)?$/u.test(name)) return "read";
  return "modify";
}

export function extractToolCallPolicyTargets(event: unknown, options: PiDevToolPolicyExtractionOptions): SomaToolPolicyExtraction {
  return extractNormalizedToolCallPolicyTargets(
    {
      action: toolCallAction(event),
      destinations: toolCallDestinations(event, options.cwd),
      sourcePath: toolCallSource(event),
      content: toolCallContent(event),
    },
    { maxTargets: options.maxTargets },
  );
}
