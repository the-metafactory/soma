// Session-scoped mode+effort feeder for the claude-code statusline (soma
// #statusline-mode-feeder). The mode-classifier hook computes the
// authoritative {mode, effort} for every prompt via `soma algorithm classify`;
// this module is the write side of that feed. It is deliberately NOT the
// per-session `current-work` pointer (soma#329 slice 3's work-registry.ts):
// that pointer tracks task/phase across the whole Algorithm run and does not
// carry mode/effort, and the global `active-algorithm-run.json` leaks across
// concurrent sessions. This file is small, session-keyed, and overwritten on
// every classified prompt.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createPaths, type SomaPathsOptions } from "./paths";
import type { AlgorithmPromptClassification } from "./types";

export interface StatuslineModeState {
  mode: string;
  effort: string;
  updatedAt: string;
}

export interface WriteStatuslineModeStateOptions extends SomaPathsOptions {
  sessionId: string;
  classification: AlgorithmPromptClassification;
  // Caller-supplied timestamp (ISO 8601) rather than stamped internally here —
  // keeps this function pure/deterministic for tests. CLI callers pass
  // `new Date().toISOString()` at the call site.
  updatedAt: string;
}

// No hash suffix (unlike work-registry.ts's current-work-<slug>-<hash>.json):
// this file is looked up by the statusline script via the RAW session id from
// Claude Code's stdin JSON (`$sid`, unsanitized), so the write side must use
// that same raw string to keep the two sides symmetric. `createPaths().resolve`
// still guards against the id escaping the Soma home root.
export function statuslineModeStatePath(options: SomaPathsOptions, sessionId: string): string {
  return createPaths(options).resolve("memory", "STATE", `statusline-mode-${sessionId}.json`);
}

export async function writeStatuslineModeState(options: WriteStatuslineModeStateOptions): Promise<string> {
  const path = statuslineModeStatePath(options, options.sessionId);
  const payload: StatuslineModeState = {
    mode: options.classification.mode,
    effort: options.classification.effort ?? "",
    updatedAt: options.updatedAt,
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
