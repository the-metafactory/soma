import { homedir } from "node:os";
import { resolve } from "node:path";
import { inspectRuntimeArtifact, isGuardedRuntimeSubstrate, rollbackRuntimeArtifact, type GuardedRuntimeSubstrate } from "../runtime-artifact";

export interface ParsedRuntimeArgs { command: "runtime"; action: "status" | "rollback"; substrate: GuardedRuntimeSubstrate; somaHome?: string; }
export const RUNTIME_COMMAND_HELP = { usage: "Usage: soma runtime <status|rollback> --substrate <claude-code|codex|grok> [--soma-home <dir>]", subcommands: { status: "Usage: soma runtime status --substrate <claude-code|codex|grok> [--soma-home <dir>]", rollback: "Usage: soma runtime rollback --substrate <claude-code|codex|grok> [--soma-home <dir>]" } };
export function parseRuntimeArgs(args: string[]): ParsedRuntimeArgs {
  const [, action, ...rest] = args;
  if (action !== "status" && action !== "rollback") throw new Error(RUNTIME_COMMAND_HELP.usage);
  let somaHome: string | undefined;
  let substrate: GuardedRuntimeSubstrate | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]; const value = rest[++i];
    if (!value) throw new Error(RUNTIME_COMMAND_HELP.subcommands[action]);
    if (flag === "--soma-home") somaHome = value;
    else if (flag === "--substrate" && isGuardedRuntimeSubstrate(value)) substrate = value;
    else throw new Error(RUNTIME_COMMAND_HELP.subcommands[action]);
  }
  if (!substrate) throw new Error(RUNTIME_COMMAND_HELP.subcommands[action]);
  return { command: "runtime", action, substrate, somaHome };
}
export async function runRuntimeCli(args: ParsedRuntimeArgs): Promise<string> {
  const somaHome = resolve(args.somaHome ?? `${homedir()}/.soma`);
  if (args.action === "rollback") {
    const state = await rollbackRuntimeArtifact(somaHome, args.substrate);
    return `soma runtime — activated retained ${args.substrate} artifact ${state.active}`;
  }
  const result = await inspectRuntimeArtifact(somaHome, args.substrate);
  return result.status === "ready" ? `soma runtime — active ${args.substrate} artifact ${result.state?.active}` : `soma runtime — ${args.substrate} ${result.status}`;
}
