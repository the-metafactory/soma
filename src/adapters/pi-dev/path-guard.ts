import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Subpaths under the explicit Soma home where `modify` is permitted. Mirrors
 * `SOMA_HOME_ALLOWED_MODIFY_SUBPATHS` in `src/policy.ts` and the
 * `allowedSubpaths` on the `~/.soma` entry of
 * `SOMA_DEFAULT_PROTECTED_PATHS` (#79). Delete remains blocked everywhere
 * under the Soma home.
 */
const SOMA_HOME_ALLOWED_MODIFY_SUBPATHS = ["isa", "memory"] as const;

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
import { resolve } from "node:path";
import {
  evaluatePathGuard,
  parseBashDestructivePaths,
  resolvePath,
  SOMA_DEFAULT_PROTECTED_PATHS,
} from ${JSON.stringify(runtimeModuleSpecifier)};

const SOMA_HOME = ${JSON.stringify(somaHome)};
// Allow legitimate Soma ISA + memory writes under the explicit SOMA_HOME
// while still blocking overwrites of private roots (e.g. profile/) and any
// destructive delete (allowedSubpaths is modify-only). See #79.
const SOMA_HOME_ALLOWED_MODIFY_SUBPATHS = ${JSON.stringify([...SOMA_HOME_ALLOWED_MODIFY_SUBPATHS])};
const PROTECTED_PATHS = [
  ...SOMA_DEFAULT_PROTECTED_PATHS,
  { path: SOMA_HOME, description: "Soma private root", allowedSubpaths: SOMA_HOME_ALLOWED_MODIFY_SUBPATHS },
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
    const cwd = resolve((ctx as { cwd?: string }).cwd ?? process.cwd());
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
  return pathToFileURL(join(import.meta.dir, "../../policy-path-guard.ts")).href;
}
