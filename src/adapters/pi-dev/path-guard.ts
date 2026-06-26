import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Render a pi.dev extension that enforces the Soma runtime policy on tool
 * calls. Two layers, both fail-closed:
 *
 *   1. Runtime-policy inspection (parity with codex/claude-code) — dangerous
 *      commands, outbound exfiltration, credential-path access, and prompt
 *      injection are denied via the portable `inspectRuntimePolicy` engine.
 *   2. Destructive path guard — overwrites/deletes of protected roots (Soma
 *      home private roots, PAI home, Pi home) are blocked.
 *
 * SUBSTRATE-SPECIFIC: this renders pi.dev extension code. All decision logic is
 * imported from the portable runtime (`runtime-policy.ts`, `policy-path-guard.ts`)
 * so generated substrate code never drifts from core enforcement.
 *
 * ADAPTER LIMITATION: pi.dev exposes a `tool_call` event but no prompt-submit
 * surface, so the prompt-injection inspector that codex/claude-code run on
 * UserPromptSubmit has no hook point here. Prompt-surface enforcement on pi.dev
 * is deferred until pi exposes a prompt event.
 */
export function renderPathGuardExtension(
  somaHome: string,
  runtimeModuleSpecifier = defaultRuntimeModuleSpecifier(),
  runtimePolicyModuleSpecifier = defaultRuntimePolicyModuleSpecifier(),
): string {
  return `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";
import {
  evaluatePathGuard,
  parseBashDestructivePaths,
  resolvePath,
  SOMA_DEFAULT_PROTECTED_PATHS,
  SOMA_HOME_ALLOWED_MODIFY_SUBPATHS,
} from ${JSON.stringify(runtimeModuleSpecifier)};
import { inspectRuntimePolicy } from ${JSON.stringify(runtimePolicyModuleSpecifier)};

const SOMA_HOME = ${JSON.stringify(somaHome)};

// Soma's substrate-neutral "ask principal" decision has no portable pi.dev
// approval shape, so it projects to a block — the conservative choice for an
// enforcement gate.
function runtimePolicyBlocks(decision: string): boolean {
  return decision === "deny" || decision === "ask";
}

// FAIL-CLOSED: any throw from the inspector blocks the tool call rather than
// letting an un-inspected action through.
async function runtimePolicyVerdict(toolName: string, input: unknown): Promise<{ block: true; reason: string } | undefined> {
  try {
    const result = await inspectRuntimePolicy({
      substrate: "pi-dev",
      surface: "tool_call",
      somaHome: SOMA_HOME,
      toolCall: { toolName, input: (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown> },
      record: "deny",
    });
    if (runtimePolicyBlocks(result.decision)) {
      return { block: true, reason: "Soma runtime policy " + result.decision + ": " + result.reason };
    }
    return undefined;
  } catch (error) {
    return { block: true, reason: "Soma runtime policy failed closed: " + (error instanceof Error ? error.message : String(error)) };
  }
}
// Allow legitimate Soma VSA + memory writes under the explicit SOMA_HOME
// while still blocking overwrites of private roots (e.g. profile/) and any
// destructive delete (allowedSubpaths is modify-only). The allowed subpaths
// are sourced from policy-path-guard.ts so all enforcement layers agree on
// one list. See #79.
const PROTECTED_PATHS = [
  ...SOMA_DEFAULT_PROTECTED_PATHS,
  { path: SOMA_HOME, description: "Soma private root", allowedSubpaths: [...SOMA_HOME_ALLOWED_MODIFY_SUBPATHS] },
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

    // Layer 1: portable runtime-policy inspection (codex/claude-code parity).
    const runtimeVerdict = await runtimePolicyVerdict(event.toolName, (event as { input?: unknown }).input);
    if (runtimeVerdict) {
      ctx.ui?.notify?.(runtimeVerdict.reason, "error");
      return runtimeVerdict;
    }

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

function defaultRuntimePolicyModuleSpecifier(): string {
  return pathToFileURL(join(import.meta.dir, "../../runtime-policy.ts")).href;
}
