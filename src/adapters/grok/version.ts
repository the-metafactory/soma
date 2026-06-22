import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isEnoent } from "../../fs-errors";
import { isBelowVersionFloor, parseVersion } from "../shared/version-floor";

/**
 * The verified-baseline floor. Everything in this adapter was built and
 * live-verified against grok 0.2.38 (the tool-name enumeration, the
 * lifecycle/compaction/policy probes) and re-confirmed on 0.2.39. The
 * whole surface is a set of version-pinned assumptions:
 *
 *   - bare-exec hook command shape (`<bun> <abs>.mjs <verb>`);
 *   - `grok inspect --json` shape the doctor parses;
 *   - the hook event set, including the only blocking event, PreToolUse,
 *     and the matcher-less lifecycle/compaction events;
 *   - the enumerated runtime tool NAMES and toolInput key shapes the
 *     matcher and extractors depend on — and, downstream, the pwsh verb
 *     tables;
 *   - passive-hook stdout being ignored, which the file-relay context
 *     delivery works around.
 *
 * A Grok release that renames a tool, changes the hook schema, or starts
 * honoring passive stdout would silently invalidate one of these. The
 * floor is the gate; the re-probe checklists are the manual follow-up a
 * version bump triggers.
 */
export const MINIMUM_GROK_VERSION = "0.2.38";

/**
 * Where Grok records its installed version. Written by the binary on its
 * update check: `{ version, stable_version, checked_at }`. Reading the
 * manifest keeps the validator deterministic and testable — nothing
 * launches a live grok.
 */
const GROK_VERSION_MANIFEST = "version.json";

export async function validateGrokInstallRuntime(substrateRoot: string): Promise<void> {
  const manifestPath = join(substrateRoot, GROK_VERSION_MANIFEST);
  const manifest = await readFile(manifestPath, "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  // Missing manifest → an unversioned dev/source runtime. Do not block
  // (mirrors pi-dev's missing-package.json tolerance).
  if (manifest === undefined) return;

  let version: unknown;
  try {
    version = (JSON.parse(manifest) as { version?: unknown }).version;
  } catch {
    throw invalidGrokVersionError(manifestPath);
  }

  if (typeof version !== "string" || version.trim() === "") {
    throw invalidGrokVersionError(manifestPath);
  }

  // A well-formed stable version must parse; a prerelease (`-`) is allowed
  // to skip the numeric parse only to be refused below.
  if (!version.trim().includes("-") && !parseVersion(version)) {
    throw invalidGrokVersionError(manifestPath);
  }

  if (isUnsupportedGrokVersion(version)) {
    throw new Error(
      `Unsupported grok version ${version}. Soma requires grok >= ${MINIMUM_GROK_VERSION} for the verified hook surface: ` +
        `direct-exec hook commands, the PreToolUse blocking event and matcher-less lifecycle/compaction events, the ` +
        `'grok inspect --json' shape, and the enumerated runtime tool names. Upgrade grok and rerun soma install grok.`,
    );
  }
}

function invalidGrokVersionError(manifestPath: string): Error {
  return new Error(`Unable to read grok version from ${manifestPath}. Reinstall or repair grok before installing Soma.`);
}

export function isUnsupportedGrokVersion(version: string): boolean {
  // Prereleases are refused outright: a `0.2.40-rc.1` may carry hook-schema
  // churn the verified baseline does not cover.
  return isBelowVersionFloor(version, MINIMUM_GROK_VERSION);
}
