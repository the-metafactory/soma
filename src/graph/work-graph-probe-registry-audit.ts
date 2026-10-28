/**
 * Stale probe-registry entries, for `soma graph audit` (node #1107).
 *
 * The registry is principal-edited and nothing removes an entry, so it only
 * grows. Deleting one an open node still declares makes that node unclosable
 * (a probe cannot be edited after `graph add`), which is why this reports per
 * entry which open nodes still use it and never edits anything.
 *
 * "Use" is the rule the close applies in `authorizeCommand`: a declared command and the
 * probe's resolved directory, both via {@link probeDirectory}, so the audit and
 * the close cannot disagree about whether a node matches an entry.
 */

import type { OpenNodeProbes } from "./work-graph";
import { probeDirectory } from "./work-graph-probes";
import { matchesDeclaredCommand, type RegistryCommandEntry } from "./work-graph-probe-registry";

export interface StaleRegistryFindings {
  /** Every registry repo, not just the audited one: a vanished directory is stale whoever declared it. */
  cwdMissing: RegistryCommandEntry[];
  /**
   * The audited repo's entries that no open node in the whole repo declares, or
   * `undefined` when the store could not list the repo's open nodes: absence of
   * evidence is never reported as non-use.
   */
  unusedByOpenNodes: RegistryCommandEntry[] | undefined;
  /** The audited repo's entries open nodes do use, with the node ids. */
  inUse: (RegistryCommandEntry & { nodes: string[] })[];
}

export interface StaleRegistryInput {
  entries: readonly RegistryCommandEntry[];
  /** Registry key of the audited repo, `host/path`. */
  repoKey: string;
  /** Every open node in the audited repo, whatever map it sits under; `undefined` when the store cannot list them. */
  openNodes: readonly OpenNodeProbes[] | undefined;
  /** The directory a probe without its own `cwd` resolves against — the close's `probeCwd`. */
  baseCwd: string;
  directoryExists: (path: string) => boolean;
}

export function findStaleRegistryEntries(input: StaleRegistryInput): StaleRegistryFindings {
  const repoKey = input.repoKey.toLowerCase();
  const cwdMissing = input.entries.filter((entry) => !input.directoryExists(entry.cwd));

  if (input.openNodes === undefined) return { cwdMissing, unusedByOpenNodes: undefined, inUse: [] };

  const unusedByOpenNodes: RegistryCommandEntry[] = [];
  const inUse: StaleRegistryFindings["inUse"] = [];
  for (const entry of input.entries) {
    if (entry.repo !== repoKey) continue;
    const nodes = input.openNodes.filter((node) => node.probes.some((probe) => {
      if (probe.type !== "command") return false;
      const cwd = probeDirectory(probe, input.baseCwd);
      return cwd !== undefined && matchesDeclaredCommand(entry, { run: probe.run, cwd });
    })).map((node) => node.id);
    if (nodes.length === 0) unusedByOpenNodes.push(entry);
    else inUse.push({ ...entry, nodes });
  }
  return { cwdMissing, unusedByOpenNodes, inUse };
}
