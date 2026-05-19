import { reflectRelationship } from "./reflect";
import type { RelationshipReflectOptions } from "./types";

export const RELATIONSHIP_REFLECT_USAGE = "Usage: soma relationship reflect [--opinions-only|--milestones-only] [--dry-run] [--home-dir <dir>] [--soma-home <dir>]";

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function commonOptions(args: string[]): RelationshipReflectOptions {
  const options: RelationshipReflectOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--home-dir") options.homeDir = readOption(args, index, "--home-dir");
    if (args[index] === "--soma-home") options.somaHome = readOption(args, index, "--soma-home");
  }
  return options;
}

export async function runRelationshipCli(args: string[]): Promise<string> {
  const action = args[0];
  if (action !== "reflect") throw new Error(RELATIONSHIP_REFLECT_USAGE);
  if (args.includes("--opinions-only") && args.includes("--milestones-only")) {
    throw new Error("--opinions-only and --milestones-only cannot be combined.");
  }
  const result = await reflectRelationship({
    ...commonOptions(args),
    opinionsOnly: args.includes("--opinions-only"),
    milestonesOnly: args.includes("--milestones-only"),
    dryRun: args.includes("--dry-run"),
  });
  return [
    `relationship reflect: ${result.notes.length} note(s)`,
    `opinion updates: ${result.opinionUpdates.length}`,
    `milestones: ${result.milestones.length}`,
    result.storyPath ? `story: ${result.storyPath}` : "",
    result.dryRun ? "dry-run: no writes" : "",
  ].filter(Boolean).join("\n") + "\n";
}
