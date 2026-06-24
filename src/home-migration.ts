import { rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { createSomaSnapshot } from "./snapshots";

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface VsaStorageMigrationResult {
  migrated: boolean;
}

/**
 * soma#329 slice 3: migrate the Verification compartment storage directory from
 * the pre-rename `isa/` to the canonical `vsa/`.
 *
 * Snapshot-first (so the rename is reversible via `soma rollback`), then rename.
 * Best-effort: if the snapshot fails (e.g. git unavailable in this environment)
 * the legacy `isa/` is left untouched — `vsaDir()` dual-reads it, so correctness
 * never depends on this migration running. Idempotent: a no-op once `vsa/` exists
 * or `isa/` is absent, so it is safe to call on every install/reproject/upgrade.
 */
export async function migrateVsaStorageDir(somaHome: string): Promise<VsaStorageMigrationResult> {
  const legacy = join(somaHome, "isa");
  const canonical = join(somaHome, "vsa");

  if ((await dirExists(canonical)) || !(await dirExists(legacy))) {
    return { migrated: false };
  }

  try {
    await createSomaSnapshot({ somaHome, name: "pre-vsa-storage-migration", trigger: "upgrade" });
  } catch {
    // No safety net was taken → do not rename. Dual-read keeps `isa/` loadable.
    return { migrated: false };
  }

  await rename(legacy, canonical);
  return { migrated: true };
}
