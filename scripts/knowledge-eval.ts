/**
 * Knowledge-orientation eval entry point.
 *
 *   bun run knowledge-eval field ...   principal corrections per session (scripts/knowledge-eval-field.ts)
 */

import { FieldUsageError, runField } from "./knowledge-eval-field";

const USAGE = "usage: bun run knowledge-eval field [--window <days>] [--sample <n> --seed <n>] [--agree <labels.json>] [--projects-dir <dir>] [--soma-home <dir>] [--json]";

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
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
