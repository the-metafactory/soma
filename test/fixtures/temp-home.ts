/**
 * Shared temp-home lifecycle for tests. Test-only; not part of the public
 * package surface.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run a callback inside a freshly-minted temp home dir; clean up
 * unconditionally even on test failure. Sage r3 #95 Maintainability:
 * single-source the temp-home lifecycle so prefix / cleanup / failure
 * diagnostic changes propagate to every test at once.
 */
export async function withTempHome<T>(
  fn: (homeDir: string) => Promise<T>,
  prefix = "soma-test-",
): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}
