import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Regular files recursively; symlinks are not followed. */
export function walkFiles(root: string, options: { skipHidden?: boolean } = {}): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (options.skipHidden && entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path, options));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function toPosixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** Code-unit ordering, independent of the host's locale. */
export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
