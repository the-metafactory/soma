import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { SomaContextBundle, WrittenContextBundle } from "./types";

function assertSafeBundlePath(rootDir: string, bundlePath: string): string {
  if (bundlePath.length === 0) {
    throw new Error("Context bundle file path must not be empty.");
  }

  if (isAbsolute(bundlePath)) {
    throw new Error(`Context bundle file path must be relative: ${bundlePath}`);
  }

  const root = resolve(rootDir);
  const target = resolve(root, bundlePath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  if (target !== root && !target.startsWith(rootPrefix)) {
    throw new Error(`Context bundle file path escapes root: ${bundlePath}`);
  }

  return target;
}

export async function writeContextBundle(bundle: SomaContextBundle, rootDir: string): Promise<WrittenContextBundle> {
  const writtenFiles: string[] = [];

  for (const file of bundle.files) {
    const target = assertSafeBundlePath(rootDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
    writtenFiles.push(target);
  }

  return {
    substrate: bundle.substrate,
    rootDir: resolve(rootDir),
    files: writtenFiles,
  };
}
