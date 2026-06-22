/**
 * Strict three-part version floor shared by adapter install validators
 * (grok, pi-dev). Substrate facts — the minimum itself, the manifest
 * location, and the error text — stay in each adapter; only the
 * version arithmetic lives here.
 */

/**
 * True when the version is below the floor. Prereleases are refused
 * outright: a `-rc.1` may carry schema churn a verified baseline does
 * not cover.
 */
export function isBelowVersionFloor(version: string, minimum: string): boolean {
  if (version.trim().includes("-")) return true;
  return compareVersions(version, minimum) < 0;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  // Throw, never coerce. Coercing an unparseable version to -1 silently
  // reads as "below floor" — safe for today's callers (both pre-reject
  // unparseable input before they reach here) but a footgun for any future
  // caller that compares without that guard. Surface the bad input instead.
  if (!leftParts || !rightParts) {
    throw new Error(`Cannot compare unparseable version: ${JSON.stringify(!leftParts ? left : right)}`);
  }
  for (let index = 0; index < 3; index += 1) {
    const diff = leftParts[index] - rightParts[index];
    if (diff !== 0) return diff;
  }
  return 0;
}

export function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
