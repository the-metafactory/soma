import { classifyDomains, listFrames, normalizeSimilarityThreshold, synthesizeWisdom, updateFrame } from "./index";
import type { WisdomObservationType, WisdomToolOptions } from "./types";

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function readOptionText(args: string[], index: number, name: string): string {
  const values: string[] = [];
  for (let cursor = index + 1; cursor < args.length; cursor += 1) {
    const value = args[cursor];
    if (value.startsWith("--")) break;
    values.push(value);
  }
  if (values.length === 0) throw new Error(`${name} requires a value.`);
  return values.join(" ");
}

function commonOptions(args: string[]): WisdomToolOptions {
  const options: WisdomToolOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--home-dir") options.homeDir = readOption(args, index, "--home-dir");
    if (args[index] === "--soma-home") options.somaHome = readOption(args, index, "--soma-home");
  }
  return options;
}

function stripCommon(args: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--home-dir" || args[index] === "--soma-home") {
      if (index > 0 && ["--domain", "--type", "--observation"].includes(args[index - 1])) {
        stripped.push(args[index]);
        continue;
      }
      index += 1;
      continue;
    }
    stripped.push(args[index]);
  }
  return stripped;
}

function parseThreshold(args: string[]): number | undefined {
  const index = args.indexOf("--threshold");
  if (index === -1) return undefined;
  const value = readOption(args, index, "--threshold");
  const parsed = Number(value);
  return normalizeSimilarityThreshold(parsed, "--threshold");
}

function parseUpdateArgs(args: string[]): { domain: string; type: WisdomObservationType; observation: string } {
  const parsed: Partial<{ domain: string; type: WisdomObservationType; observation: string }> = {};
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--domain") {
      parsed.domain = readOption(args, index, "--domain");
      index += 1;
      continue;
    }
    if (arg === "--type") {
      parsed.type = readOption(args, index, "--type") as WisdomObservationType;
      index += 1;
      continue;
    }
    if (arg === "--observation") {
      parsed.observation = readOptionText(args, index, "--observation");
      while (args[index + 1] && !args[index + 1].startsWith("--")) index += 1;
      continue;
    }
    throw new Error(`Unknown wisdom update argument: ${arg}`);
  }
  if (!parsed.domain || !parsed.type || !parsed.observation) {
    throw new Error("Usage: soma wisdom update --domain <domain> --type <principle|contextual-rule|prediction|anti-pattern|evolution> --observation <text>");
  }
  return { domain: parsed.domain, type: parsed.type, observation: parsed.observation };
}

export async function runWisdomCli(args: string[]): Promise<string> {
  const options = commonOptions(args);
  const local = stripCommon(args);
  const action = local[0];

  if (action === "classify") {
    const text = local.slice(1).join(" ");
    const classifications = await classifyDomains(text, options);
    return JSON.stringify(classifications, null, 2) + "\n";
  }

  if (action === "list") {
    const frames = await listFrames(options);
    return frames.map((frame) => `${frame.domain}\t${frame.observationCount}\t${frame.path}`).join("\n") + (frames.length ? "\n" : "");
  }

  if (action === "update") {
    const parsed = parseUpdateArgs(local);
    const result = await updateFrame({
      ...options,
      ...parsed,
    });
    return `${result.created ? "created" : "updated"} wisdom frame: ${result.domain} (${result.observationCount} observations)\n${result.path}\n`;
  }

  if (action === "synthesize" || action === "health") {
    const result = await synthesizeWisdom({
      ...options,
      dryRun: local.includes("--dry-run"),
      healthOnly: action === "health",
      similarityThreshold: parseThreshold(local),
    });
    return [
      `wisdom ${action}: ${result.principles.length} cross-frame principle(s), ${result.health.length} frame(s)`,
      result.principlesPath ? `principles: ${result.principlesPath}` : "",
      result.healthPath ? `health: ${result.healthPath}` : "",
    ].filter(Boolean).join("\n") + "\n";
  }

  throw new Error("Usage: soma wisdom <classify|list|update|synthesize|health> ...");
}
