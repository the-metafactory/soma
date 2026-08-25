import { homedir } from "node:os";
import { resolve } from "node:path";
import { inspectRuntimeArtifact, rollbackRuntimeArtifact } from "../runtime-artifact";

export interface ParsedRuntimeArgs { command: "runtime"; action: "status" | "rollback"; somaHome?: string; }
export const RUNTIME_COMMAND_HELP = { usage: "Usage: soma runtime <status|rollback> [--soma-home <dir>]", subcommands: { status: "Usage: soma runtime status [--soma-home <dir>]", rollback: "Usage: soma runtime rollback [--soma-home <dir>]" } };
export function parseRuntimeArgs(args: string[]): ParsedRuntimeArgs {
  const [, action, ...rest] = args;
  if (action !== "status" && action !== "rollback") throw new Error(RUNTIME_COMMAND_HELP.usage);
  let somaHome: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== "--soma-home" || !rest[i + 1]) throw new Error(RUNTIME_COMMAND_HELP.subcommands[action]);
    somaHome = rest[++i];
  }
  return { command: "runtime", action, somaHome };
}
export async function runRuntimeCli(args: ParsedRuntimeArgs): Promise<string> {
  const somaHome = resolve(args.somaHome ?? `${homedir()}/.soma`);
  if (args.action === "rollback") {
    const state = await rollbackRuntimeArtifact(somaHome);
    return `soma runtime — activated retained artifact ${state.active}`;
  }
  const result = await inspectRuntimeArtifact(somaHome);
  return result.status === "ready" ? `soma runtime — active artifact ${result.state?.active}` : `soma runtime — ${result.status}`;
}
