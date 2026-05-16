import { isAbsolute, relative } from "node:path";

export function isInsidePath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
