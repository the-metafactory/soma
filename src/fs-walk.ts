import { readdirSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

function shouldVisit(entry: Dirent, options: { skipHidden?: boolean }): boolean {
  return !(options.skipHidden && entry.name.startsWith(".")) && (entry.isDirectory() || entry.isFile());
}

/** Regular files recursively; symlinks are not followed. */
export function walkFiles(root: string, options: { skipHidden?: boolean } = {}): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!shouldVisit(entry, options)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path, options));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Async runtime walk; regular files only, without following symlinks. */
export async function* walkFilesAsync(root: string, options: { skipHidden?: boolean } = {}): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!shouldVisit(entry, options)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFilesAsync(path, options);
    else if (entry.isFile()) yield path;
  }
}

export function toPosixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** Code-unit ordering, independent of the system locale. */
export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
