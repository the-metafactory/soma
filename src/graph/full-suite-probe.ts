import { isBareBunTestProbe, type Probe } from "./work-graph";

const SUITE_RUNNERS: ReadonlySet<string> = new Set(["bun", "npm", "pnpm", "yarn"]);

const SELECTION_FLAGS: ReadonlySet<string> = new Set(["-t", "--test-name-pattern", "--changed", "--only", "--todo"]);

function narrowsSelection(word: string): boolean {
  return SELECTION_FLAGS.has(word.split("=")[0] ?? word);
}

/**
 * True when a command probe's `run` is a whole-suite test invocation: `bun test`,
 * `bun run test`, `npm test` and their pnpm/yarn forms, with flags but no test
 * path or selection flag. A path argument or a selection flag (`-t`,
 * `--test-name-pattern`, `--changed`) narrows the run to what a change touches,
 * so it is not a full suite. Chained or piped commands are not recognised; the registry
 * authorises exact `run` strings, so those are not declarable anyway.
 */
export function isFullSuiteCommand(run: string): boolean {
  const words = run.trim().split(/\s+/u);
  const [runner, ...rest] = words;
  if (!SUITE_RUNNERS.has(runner)) return false;
  const verbs = rest[0] === "run" ? rest.slice(1) : rest;
  if (verbs[0] !== "test") return false;
  return verbs.slice(1).every((word) => word.startsWith("-") && !narrowsSelection(word));
}

/**
 * True when a node declares a whole-suite command probe that `isBareBunTestProbe`
 * does not already report, so an audit lists each node in one section only: a
 * bare `bun test` belongs to the bare-bun-test section.
 */
export function declaresFullSuiteProbe(probes: readonly Probe[] | undefined): boolean {
  return (probes ?? []).some((probe) => probe.type === "command" && isFullSuiteCommand(probe.run) && !isBareBunTestProbe(probe));
}
