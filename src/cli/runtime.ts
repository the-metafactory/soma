import { homedir } from "node:os";
import { resolve } from "node:path";
import { inspectRuntimeArtifact, isRuntimeArtifactTarget, rollbackRuntimeArtifact, type RuntimeArtifactTarget } from "../runtime-artifact";

export interface ParsedRuntimeArgs { command: "runtime"; action: "status" | "rollback"; target: RuntimeArtifactTarget; somaHome?: string; }
export const RUNTIME_COMMAND_HELP = { usage: "Usage: soma runtime <status|rollback> --target <cli|claude-code|codex|grok> [--soma-home <dir>]", subcommands: { status: "Usage: soma runtime status --target <cli|claude-code|codex|grok> [--soma-home <dir>]", rollback: "Usage: soma runtime rollback --target <cli|claude-code|codex|grok> [--soma-home <dir>]" } };
export function parseRuntimeArgs(args: string[]): ParsedRuntimeArgs {
  const [, action, ...rest] = args;
  if (action !== "status" && action !== "rollback") throw new Error(RUNTIME_COMMAND_HELP.usage);
  let somaHome: string | undefined;
  let target: RuntimeArtifactTarget | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]; const value = rest[++i];
    if (!value) throw new Error(RUNTIME_COMMAND_HELP.subcommands[action]);
    if (flag === "--soma-home") somaHome = value;
    else if ((flag === "--target" || flag === "--substrate") && isRuntimeArtifactTarget(value)) target = value;
    else throw new Error(RUNTIME_COMMAND_HELP.subcommands[action]);
  }
  if (!target) throw new Error(RUNTIME_COMMAND_HELP.subcommands[action]);
  return { command: "runtime", action, target, somaHome };
}
export async function runRuntimeCli(args: ParsedRuntimeArgs): Promise<string> {
  const somaHome = resolve(args.somaHome ?? `${homedir()}/.soma`);
  if (args.action === "rollback") {
    const state = await rollbackRuntimeArtifact(somaHome, args.target);
    return `soma runtime — activated retained ${args.target} artifact ${state.active}`;
  }
  const result = await inspectRuntimeArtifact(somaHome, args.target);
  return result.status === "ready" ? `soma runtime — active ${args.target} artifact ${result.state?.active}` : `soma runtime — ${args.target} ${result.status}`;
}
