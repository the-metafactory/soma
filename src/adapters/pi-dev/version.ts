import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MINIMUM_PI_DEV_VERSION = "0.10.0";

export async function validatePiDevInstallRuntime(substrateRoot: string): Promise<void> {
  const packagePath = join(substrateRoot, "agent/package.json");
  const packageJson = await readFile(packagePath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!packageJson) return;

  let version: unknown;
  try {
    version = (JSON.parse(packageJson) as { version?: unknown }).version;
  } catch {
    throw invalidPiDevVersionError(packagePath);
  }

  if (typeof version !== "string" || version.trim() === "") {
    throw invalidPiDevVersionError(packagePath);
  }

  if (!version.trim().includes("-") && !parseVersion(version)) {
    throw invalidPiDevVersionError(packagePath);
  }

  if (isUnsupportedPiDevVersion(version)) {
    throw new Error(
      `Unsupported pi.dev version ${version}. Soma requires pi.dev >= ${MINIMUM_PI_DEV_VERSION} for ExtensionAPI widgets, session entries, and tool_call blocking. Upgrade pi.dev and rerun soma install pi-dev.`,
    );
  }
}

function invalidPiDevVersionError(packagePath: string): Error {
  return new Error(`Unable to read pi.dev version from ${packagePath}. Reinstall or repair pi.dev before installing Soma.`);
}

export function isUnsupportedPiDevVersion(version: string): boolean {
  if (version.trim().includes("-")) return true;
  return compareVersions(version, MINIMUM_PI_DEV_VERSION) < 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return -1;
  for (let index = 0; index < 3; index += 1) {
    const diff = leftParts[index] - rightParts[index];
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
