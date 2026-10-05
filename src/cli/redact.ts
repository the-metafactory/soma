import { readFile } from "node:fs/promises";
import { isEnvFileName, redactSecrets } from "../redact";

export interface ParsedRedactArgs {
  command: "redact";
  sources: string[];
  number: boolean;
  env: boolean;
}

export const REDACT_COMMAND_HELP = {
  usage:
    "Usage: soma redact [-n] [--env] <path|->...\n" +
    "Print config files (or stdin with `-`) with secret values masked: keys, structure, paths and public keys stay readable.\n" +
    "  -n     number lines\n" +
    "  --env  treat every input as a .env file (mask all non-path values)",
};

export function parseRedactArgs(args: string[]): ParsedRedactArgs {
  const [command, ...rest] = args;
  if (command !== "redact") throw new Error(REDACT_COMMAND_HELP.usage);

  const parsed: ParsedRedactArgs = { command, sources: [], number: false, env: false };
  for (const arg of rest) {
    if (arg === "-n") parsed.number = true;
    else if (arg === "--env") parsed.env = true;
    else if (arg === "-" || !arg.startsWith("-")) parsed.sources.push(arg);
    else throw new Error(`Unknown option: ${arg}\n${REDACT_COMMAND_HELP.usage}`);
  }
  if (parsed.sources.length === 0) throw new Error(REDACT_COMMAND_HELP.usage);
  return parsed;
}

export async function runRedactCli(parsed: ParsedRedactArgs, readStdin: () => Promise<string> = () => Bun.stdin.text()): Promise<string> {
  const blocks: string[] = [];
  let total = 0;

  for (const source of parsed.sources) {
    const raw = source === "-" ? await readStdin() : await readFile(source, "utf8");
    // Redact the body without its final newline, so `-n` does not number a
    // phantom empty last line; the CLI runner prints one newline after.
    const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const result = redactSecrets(body, { envFile: parsed.env || (source !== "-" && isEnvFileName(source)), number: parsed.number });
    total += result.redacted;
    blocks.push(parsed.sources.length > 1 ? `==> ${source} <==\n${result.text}` : result.text);
  }

  process.stderr.write(`soma redact: ${total} value(s) redacted\n`);
  return blocks.join("\n");
}
