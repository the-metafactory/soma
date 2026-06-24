import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateVsaStorageDir } from "../src/home-migration";
import { bootstrapSomaHome } from "../src/soma-home";
import { vsaDir } from "../src/vsa";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "soma-home-migration-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

describe("migrateVsaStorageDir (soma#329 slice 3)", () => {
  test("renames legacy isa/ → vsa/, preserves VSA content, snapshots first", async () => {
    await withTempDir(async (somaHome) => {
      await mkdir(join(somaHome, "isa", ".templates"), { recursive: true });
      await writeFile(join(somaHome, "isa", "demo.md"), "# demo VSA\n", "utf8");

      const result = await migrateVsaStorageDir(somaHome);

      expect(result.migrated).toBe(true);
      expect(await isDir(join(somaHome, "vsa"))).toBe(true);
      expect(await isDir(join(somaHome, "isa"))).toBe(false);
      expect(await readFile(join(somaHome, "vsa", "demo.md"), "utf8")).toBe("# demo VSA\n");
      expect(await isDir(join(somaHome, "vsa", ".templates"))).toBe(true);
      // Snapshot-first: a git repo (the reversibility safety net) was created.
      expect(await isDir(join(somaHome, ".git"))).toBe(true);
    });
  });

  test("no-op when vsa/ already exists (idempotent)", async () => {
    await withTempDir(async (somaHome) => {
      await mkdir(join(somaHome, "vsa"), { recursive: true });
      await mkdir(join(somaHome, "isa"), { recursive: true });
      await writeFile(join(somaHome, "isa", "stale.md"), "stale\n", "utf8");

      const result = await migrateVsaStorageDir(somaHome);

      expect(result.migrated).toBe(false);
      // Leaves both untouched — does not clobber an existing vsa/.
      expect(await isDir(join(somaHome, "isa"))).toBe(true);
      expect(await isDir(join(somaHome, "vsa"))).toBe(true);
      expect(await isDir(join(somaHome, ".git"))).toBe(false);
    });
  });

  test("no-op when isa/ absent (fresh home)", async () => {
    await withTempDir(async (somaHome) => {
      await mkdir(somaHome, { recursive: true });
      const result = await migrateVsaStorageDir(somaHome);
      expect(result.migrated).toBe(false);
      expect(await isDir(join(somaHome, ".git"))).toBe(false);
    });
  });

  test("bootstrap on a pre-rename home migrates isa/ → vsa/ before recreating the dir", async () => {
    await withTempDir(async (homeDir) => {
      const somaHome = join(homeDir, ".soma");
      await mkdir(join(somaHome, "isa"), { recursive: true });
      await writeFile(join(somaHome, "isa", "kept.md"), "kept\n", "utf8");

      await bootstrapSomaHome({ homeDir });

      expect(await isDir(join(somaHome, "vsa"))).toBe(true);
      expect(await isDir(join(somaHome, "isa"))).toBe(false);
      // Existing VSA survived the migration (was not stranded by the bootstrap mkdir).
      expect(await readFile(join(somaHome, "vsa", "kept.md"), "utf8")).toBe("kept\n");
    });
  });

  test("vsaDir dual-reads: legacy isa/ when only it exists, vsa/ once present", async () => {
    await withTempDir(async (somaHome) => {
      // Fresh home with neither dir → canonical vsa/ is the default target.
      expect(vsaDir(somaHome)).toBe(join(somaHome, "vsa"));

      // Only legacy isa/ exists → read from it (dual-read).
      await mkdir(join(somaHome, "isa"), { recursive: true });
      expect(vsaDir(somaHome)).toBe(join(somaHome, "isa"));

      // Once vsa/ exists it wins, even if isa/ lingers.
      await mkdir(join(somaHome, "vsa"), { recursive: true });
      expect(vsaDir(somaHome)).toBe(join(somaHome, "vsa"));
    });
  });
});
