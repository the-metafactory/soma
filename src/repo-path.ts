import { resolve } from "node:path";

export function defaultSomaRepoPath(): string {
  return resolve(import.meta.dirname, "..");
}
