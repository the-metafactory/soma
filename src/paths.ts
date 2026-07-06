import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { SOMA_MEMORY_PROMOTION_STORE_DIRS } from "./types";
import type { SomaMemoryPromotionStore, SomaPaths } from "./types";

export interface SomaPathsOptions {
  homeDir?: string;
  somaHome?: string;
}

export function defaultSomaHome(options: SomaPathsOptions = {}): string {
  return resolvePath(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

function assertInsideRoot(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return;
  }
  throw new Error(`Soma path escapes root: ${target}`);
}


export function createPaths(optionsOrSomaHome: SomaPathsOptions | string = {}): SomaPaths {
  const options = typeof optionsOrSomaHome === "string"
    ? { somaHome: optionsOrSomaHome }
    : optionsOrSomaHome;
  const root = defaultSomaHome(options);

  const underRoot = (...segments: string[]): string => {
    const target = resolvePath(root, ...segments);
    assertInsideRoot(root, target);
    return target;
  };

  const state = (...segments: string[]): string => underRoot("memory", "STATE", ...segments);

  return {
    root: () => root,
    identity: () => underRoot("identity"),
    memory: () => underRoot("memory"),
    profile: () => underRoot("profile"),
    skills: () => underRoot("skills"),
    learning: () => underRoot("memory", "LEARNING"),
    knowledge: () => underRoot("memory", "KNOWLEDGE"),
    signals: () => underRoot("memory", "LEARNING", "SIGNALS"),
    wisdom: () => underRoot("memory", "WISDOM"),
    relationship: () => underRoot("memory", "RELATIONSHIP"),
    state,
    work: () => underRoot("memory", "WORK"),
    semantic: () => underRoot("memory", "semantic"),
    procedural: () => underRoot("memory", "procedural"),
    episodic: (kind: "sessions" | "actions" | "digests", ...segments: string[]) =>
      underRoot("memory", "episodic", kind, ...segments),
    promoted: (store: SomaMemoryPromotionStore) =>
      underRoot("memory", SOMA_MEMORY_PROMOTION_STORE_DIRS[store], "PROMOTED"),
    archive: (...segments: string[]) => underRoot("memory", "archive", ...segments),
    ratings: () => underRoot("memory", "LEARNING", "SIGNALS", "ratings.jsonl"),
    opinions: () => underRoot("identity", "opinions.md"),
    story: () => underRoot("identity", "our-story.md"),
    events: () => state("events.jsonl"),
    resolve: (...segments: string[]) => underRoot(...segments),
  };
}
