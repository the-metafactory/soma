import { readSync } from "node:fs";
import { captureSomaFeedback } from "../index";
import { SOMA_FEEDBACK_STDIN_MAX_BYTES } from "../feedback-contract";
import type { SomaFeedbackCaptureOptions, SomaFeedbackCaptureResult } from "../types";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

export interface ParsedFeedbackArgs {
  command: "feedback";
  action: "capture";
  options: SomaFeedbackCaptureOptions;
  readTextFromStdin: boolean;
}

export const FEEDBACK_COMMAND_HELP: { usage: string; subcommands: Record<ParsedFeedbackArgs["action"], string> } = {
  usage: "Usage: soma feedback capture (--text <text> | --stdin) [--substrate <id>] [--source <source>] [--store-excerpt]",
  subcommands: {
    capture: "Usage: soma feedback capture (--text <text> | --stdin) [--substrate <id>] [--source <source>] [--store-excerpt]",
  },
};

export function parseFeedbackArgs(args: string[]): ParsedFeedbackArgs {
  const [command, action, ...rest] = args;

  if (command !== "feedback" || action !== "capture") {
    throw new Error(FEEDBACK_COMMAND_HELP.subcommands.capture);
  }

  const parsed = parseFeedbackCaptureArgs(rest);

  return {
    command,
    action,
    options: parsed.options,
    readTextFromStdin: parsed.readTextFromStdin,
  };
}

function parseFeedbackCaptureArgs(args: string[]): { options: SomaFeedbackCaptureOptions; readTextFromStdin: boolean } {
  const options: Partial<SomaFeedbackCaptureOptions> = {};
  let readTextFromStdin = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(args, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(args, index, arg);
        index += 1;
        break;
      case "--substrate":
        options.substrate = parseSubstrate(readOption(args, index, arg));
        index += 1;
        break;
      case "--text":
        options.text = readOption(args, index, arg);
        index += 1;
        break;
      case "--stdin":
        readTextFromStdin = true;
        break;
      case "--no-excerpt":
        options.storeExcerpt = false;
        break;
      case "--store-excerpt":
        options.storeExcerpt = true;
        break;
      case "--source":
        options.source = readOption(args, index, arg);
        index += 1;
        break;
      case "--timestamp":
        options.timestamp = readOption(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.text && !readTextFromStdin) {
    throw new Error("soma feedback capture is missing required option: --text or --stdin.");
  }
  if (options.text && readTextFromStdin) {
    throw new Error("soma feedback capture accepts either --text or --stdin, not both.");
  }

  const parsedOptions: SomaFeedbackCaptureOptions = {
    ...options,
    text: options.text ?? "",
  };

  return {
    options: parsedOptions,
    readTextFromStdin,
  };
}

export async function runFeedbackCli(parsed: ParsedFeedbackArgs): Promise<string> {
  const options = parsed.readTextFromStdin ? { ...parsed.options, text: readLimitedFeedbackStdin() } : parsed.options;
  return formatFeedbackCaptureResult(await captureSomaFeedback(options));
}

function readLimitedFeedbackStdin(): string {
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const buffer = Buffer.alloc(Math.min(8192, SOMA_FEEDBACK_STDIN_MAX_BYTES + 1 - total));
    const bytesRead = readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > SOMA_FEEDBACK_STDIN_MAX_BYTES) {
      throw new Error(`soma feedback capture --stdin exceeds ${SOMA_FEEDBACK_STDIN_MAX_BYTES} byte limit.`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function formatFeedbackCaptureResult(result: SomaFeedbackCaptureResult): string {
  return [
    "Soma feedback capture",
    `captured: ${result.captured ? "yes" : "no"}`,
    `kind: ${result.classification.kind}`,
    `confidence: ${result.classification.confidence}`,
    `reason: ${result.classification.reason}`,
    result.event?.metadata?.excerptStored === true
      ? "warning: --store-excerpt persists a best-effort redacted excerpt; redaction is not a secret scanner."
      : undefined,
    result.event ? `event: ${result.event.id}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
