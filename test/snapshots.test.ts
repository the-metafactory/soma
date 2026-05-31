import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import {
  bootstrapSomaHome,
  createSomaSnapshot,
  listSomaSnapshots,
  rollbackSomaSnapshot,
} from "../src/index";
import { writePaiIdentityFixture } from "./fixtures/pai-migration-fixtures";

async function withSnapshotHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const tmpRoot = join(import.meta.dir, "..", ".tmp-tests");
  await mkdir(tmpRoot, { recursive: true });
  const homeDir = await mkdtemp(join(tmpRoot, "soma-snapshot-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("snapshots restore tracked files and clean post-snapshot additions", async () => {
  await withSnapshotHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const principalPath = join(somaHome, "profile/principal.md");
    await writeFile(principalPath, "baseline\n", "utf8");
    const baseline = await createSomaSnapshot({ homeDir, name: "baseline", trigger: "test" });

    await writeFile(principalPath, "changed\n", "utf8");
    await mkdir(join(somaHome, "memory/STATE"), { recursive: true });
    await writeFile(join(somaHome, "memory/STATE/transient.md"), "temporary\n", "utf8");

    const rollback = await rollbackSomaSnapshot({ homeDir, snapshot: baseline.id });

    expect(rollback.name).toBe("baseline");
    await expect(readFile(principalPath, "utf8")).resolves.toBe("baseline\n");
    await expect(stat(join(somaHome, "memory/STATE/transient.md"))).rejects.toThrow();
  });
});

test("snapshots exclude common secret-bearing files from Git history", async () => {
  await withSnapshotHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const envPath = join(somaHome, ".env");
    await writeFile(envPath, "TOKEN=secret\n", "utf8");

    const snapshot = await createSomaSnapshot({ homeDir, name: "with-env", trigger: "test" });

    expect(snapshot.name).toBe("with-env");
    const history = await runSomaCli(["history", "--home-dir", homeDir]);
    expect(history).toContain("with-env");
    await rm(envPath, { force: true });
    await rollbackSomaSnapshot({ homeDir, snapshot: snapshot.id });
    await expect(stat(envPath)).rejects.toThrow();
  });
});

test("rollback preserves ignored files that existed before the snapshot", async () => {
  await withSnapshotHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const envPath = join(somaHome, ".env");
    await writeFile(envPath, "TOKEN=secret\n", "utf8");
    const snapshot = await createSomaSnapshot({ homeDir, name: "with-env", trigger: "test" });

    await writeFile(envPath, "TOKEN=changed\n", "utf8");
    await rollbackSomaSnapshot({ homeDir, snapshot: snapshot.id });

    await expect(readFile(envPath, "utf8")).resolves.toBe("TOKEN=changed\n");
  });
});

test("rollback removes ignored nested additions as well as untracked files", async () => {
  await withSnapshotHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const snapshot = await createSomaSnapshot({ homeDir, name: "baseline", trigger: "test" });

    await mkdir(join(somaHome, "secrets/nested"), { recursive: true });
    await writeFile(join(somaHome, "secrets/nested/api.key"), "secret\n", "utf8");

    await rollbackSomaSnapshot({ homeDir, snapshot: snapshot.id });

    await expect(stat(join(somaHome, "secrets/nested/api.key"))).rejects.toThrow();
  });
});

test("snapshot history lists named snapshots newest first", async () => {
  await withSnapshotHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });

    await createSomaSnapshot({ homeDir, name: "first", trigger: "test" });
    await createSomaSnapshot({ homeDir, name: "second", trigger: "test" });

    const snapshots = await listSomaSnapshots({ homeDir });

    expect(snapshots.map((snapshot) => snapshot.name).slice(0, 2)).toEqual(["second", "first"]);
    expect(snapshots[0]?.subject).toBe("soma snapshot: second");
  });
});

test("snapshot, history, and rollback are available through the CLI", async () => {
  await withSnapshotHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const principalPath = join(somaHome, "profile/principal.md");
    await writeFile(principalPath, "cli baseline\n", "utf8");

    const snapshotOutput = await runSomaCli([
      "snapshot",
      "--name",
      "cli-baseline",
      "--home-dir",
      homeDir,
    ]);
    expect(snapshotOutput).toContain("soma snapshot");
    expect(snapshotOutput).toContain("cli-baseline");

    const [snapshot] = await listSomaSnapshots({ homeDir });
    expect(snapshot).toBeDefined();
    if (!snapshot) throw new Error("expected snapshot");
    await writeFile(principalPath, "cli changed\n", "utf8");

    const historyOutput = await runSomaCli(["history", "--home-dir", homeDir]);
    expect(historyOutput).toContain("cli-baseline");

    const rollbackOutput = await runSomaCli(["rollback", snapshot.id.slice(0, 12), "--home-dir", homeDir]);
    expect(rollbackOutput).toContain("soma rollback");
    expect(rollbackOutput).toContain("cli-baseline");
    await expect(readFile(principalPath, "utf8")).resolves.toBe("cli baseline\n");
  });
});

test("migrate pai --apply records a pre-apply snapshot", async () => {
  await withSnapshotHome(async (homeDir) => {
    await writePaiIdentityFixture(homeDir, { withAlgorithm: true });

    const output = await runSomaCli(["migrate", "pai", "--apply", "--home-dir", homeDir]);
    const snapshots = await listSomaSnapshots({ homeDir });

    expect(output).toContain("soma migrate pai");
    expect(snapshots[0]?.name).toBe("before-migrate-pai");
  });
});
