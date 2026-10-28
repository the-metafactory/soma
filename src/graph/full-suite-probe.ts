import type { Probe } from "./work-graph";

const SUITE_RUNNERS: ReadonlySet<string> = new Set(["bun", "npm", "pnpm", "yarn"]);

/**
 * True when a command probe's `run` is a whole-suite test invocation: `bun test`,
 * `bun run test`, `npm test` and their pnpm/yarn forms, with flags but no test
 * path. A path argument narrows the run to the files a change touches, so it is
 * not a full suite. Chained or piped commands are not recognised; the registry
 * authorises exact `run` strings, so those are not declarable anyway.
 */
export function isFullSuiteCommand(run: string): boolean {
  const words = run.trim().split(/\s+/u);
  const [runner, ...rest] = words;
  if (runner === undefined || !SUITE_RUNNERS.has(runner)) return false;
  const verbs = rest[0] === "run" ? rest.slice(1) : rest;
  if (verbs[0] !== "test") return false;
  return verbs.slice(1).every((word) => word.startsWith("-"));
}

export function declaresFullSuiteProbe(probes: readonly Probe[] | undefined): boolean {
  return (probes ?? []).some((probe) => probe.type === "command" && isFullSuiteCommand(probe.run));
}
