import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Render a pi.dev extension that guards against destructive operations on
 * protected paths (Soma home, PAI home, Pi home, etc.).
 *
 * SUBSTRATE-SPECIFIC: This renders pi.dev extension code. The parser and path
 * matching logic are imported from the portable policy-path-guard runtime so
 * generated substrate code does not drift from core enforcement.
 */
export function renderPathGuardExtension(somaHome: string, runtimeModuleSpecifier = defaultRuntimeModuleSpecifier()): string {
  return `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  evaluatePathGuard,
  parseBashDestructivePaths,
  resolvePath,
  SOMA_DEFAULT_PROTECTED_PATHS,
} from ${JSON.stringify(runtimeModuleSpecifier)};

const SOMA_HOME = ${JSON.stringify(somaHome)};
const PROTECTED_PATHS = [
  ...SOMA_DEFAULT_PROTECTED_PATHS,
  { path: SOMA_HOME, description: "Soma private root" },
];

function blockedTargets(targets: string[], cwd: string, action: "delete" | "modify"): string[] {
  const result = evaluatePathGuard({
    targetPaths: targets,
    cwd,
    protectedPaths: PROTECTED_PATHS,
    action,
  });
  return result.matchedDescriptions;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
    const toolName = event.toolName.toLowerCase();

    if (toolName === "bash") {
      const input = (event as { input?: { command?: string; timeout?: number } }).input;
      if (!input?.command) return;

      const parsed = parseBashDestructivePaths(input.command, cwd);
      const details = blockedTargets(parsed.targetPaths, cwd, "delete");

      if (details.length > 0) {
        const msg = "Soma path guard blocked command targeting protected path: " + details.join("; ") + ".";
        ctx.ui?.notify?.(msg, "error");
        return { block: true, reason: msg };
      }
    }

    if (toolName === "write" || toolName === "edit") {
      const input = (event as { input?: { file_path?: string; path?: string } }).input;
      const targetPath = input?.file_path ?? input?.path;
      if (!targetPath) return;

      const details = blockedTargets([resolvePath(targetPath, cwd)], cwd, "modify");
      if (details.length > 0) {
        const msg = "Soma path guard blocked write to protected path: " + details.join("; ") + ".";
        ctx.ui?.notify?.(msg, "error");
        return { block: true, reason: msg };
      }
    }
  });
}
`;
}

function defaultRuntimeModuleSpecifier(): string {
  return pathToFileURL(join(import.meta.dir, "../policy-path-guard.ts")).href;
}
