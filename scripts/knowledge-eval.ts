/**
 * Knowledge-orientation eval entry point.
 *
 *   bun run knowledge-eval field ...   principal corrections per session (scripts/knowledge-eval-field.ts)
 *   bun run knowledge-eval trial ...   one frozen fixture, one isolated trial (scripts/knowledge-eval-trial.ts)
 *   bun run knowledge-eval batch ...   repeated interleaved hint ladders (scripts/knowledge-eval-batch.ts)
 */

import { FieldUsageError, runField } from "./knowledge-eval-field";
import { main as runTrialCommand } from "./knowledge-eval-trial";
import { main as runBatchCommand } from "./knowledge-eval-batch";

const USAGE = [
  "usage: bun run knowledge-eval field [--window <days>] [--sample <n> --seed <n>] [--agree <labels.json>] [--projects-dir <dir>] [--soma-home <dir>] [--json]",
  "       bun run knowledge-eval trial --fixture <id> --arm <label> --home-source <dir> --substrate <claude|codex> [...]",
  "       bun run knowledge-eval batch --arms <a>[,<b>] --home-source <dir> --substrate <claude|codex> [--fixtures <id,...>] [...]",
].join("\n");

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "trial") return runTrialCommand(argv);
  if (command === "batch") return runBatchCommand(argv);
  if (command !== "field") {
    console.error(USAGE);
    return 2;
  }
  try {
    await runField(rest, { now: new Date(), write: (line) => { console.log(line); } });
    return 0;
  } catch (error) {
    if (error instanceof FieldUsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
