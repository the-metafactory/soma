/**
 * Issue 114 — plan-resolve-apply flow for PAI pack name collisions.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { migratePai, planPaiMigration } from "../src/pai-migration";
import { runSomaCli } from "../src/cli";
import {
  withTempHome as withSharedTempHome,
  writePaiIdentityFixture as writeIdentityFixture,
} from "./fixtures/pai-migration-fixtures";
import { writeFlatPack, writeNestedPackShell, writeNestedSkill } from "./fixtures/pai-pack-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-114-");

async function writeNestedPack(packsDir: string, packName: string, skills: string[]): Promise<string> {
  const packDir = join(packsDir, packName);
  await mkdir(packDir, { recursive: true });
  await writeNestedPackShell(packDir, packName);
  for (const skill of skills) {
    await writeNestedSkill(packDir, skill);
  }
  return packDir;
}

async function withCollisionFixture<T>(
  fn: (ctx: { homeDir: string; packsDir: string; browserPack: string; utilitiesPack: string }) => Promise<T>,
): Promise<T> {
  return withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    const browserPack = join(packsDir, "Browser");
    await writeFlatPack(browserPack, "Browser");
    const utilitiesPack = await writeNestedPack(packsDir, "Utilities", ["Browser"]);
    return fn({ homeDir, packsDir, browserPack, utilitiesPack });
  });
}

async function rewriteResolutionPick(resolution: string, pick: string | null): Promise<void> {
  let body = await readFile(resolution, "utf8");
  body = body.replace(/^    pick: .+$/m, pick === null ? "    pick: null" : `    pick: "${pick}"`);
  await writeFile(resolution, body, "utf8");
}

test("#114 AC-1: --emit-resolution writes collision metadata", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir, browserPack, utilitiesPack }) => {
    const resolution = join(homeDir, "migration-resolve.yaml");

    await planPaiMigration({
      homeDir,
      paiPacksDir: packsDir,
      skipMemory: true,
      emitResolutionPath: resolution,
    });

    const body = await readFile(resolution, "utf8");
    expect(body).toContain("collisions:");
    expect(body).toContain("\"browser\":");
    expect(body).toContain(`pick: "${browserPack}"`);
    expect(body).toContain(`source: "${browserPack}"`);
    expect(body).toContain(`source: "${utilitiesPack}"`);
    expect(body).toContain("workflows:");
    expect(body).toContain("sizeBytes:");
  });
});

test("#114 AC-2: --resolution pick selects the later collision winner", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir, utilitiesPack }) => {
    const resolution = join(homeDir, "migration-resolve.yaml");
    await planPaiMigration({ homeDir, paiPacksDir: packsDir, skipMemory: true, emitResolutionPath: resolution });
    await rewriteResolutionPick(resolution, utilitiesPack);

    const result = await migratePai({
      homeDir,
      paiPacksDir: packsDir,
      skipMemory: true,
      resolutionPath: resolution,
    });

    const importedBrowser = result.packOutcomes.find((outcome) =>
      outcome.outcome === "imported" && outcome.skillName === "browser"
    );
    expect(importedBrowser?.paiPackDir).toBe(utilitiesPack);
    expect(result.packOutcomes.some((outcome) =>
      outcome.outcome === "refused-name-collision" &&
      outcome.skillName === "browser" &&
      outcome.reason?.includes("Resolution file picked")
    )).toBe(true);
  });
});

test("#114 AC-3: pick null skips every collision option", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir }) => {
    const resolution = join(homeDir, "migration-resolve.yaml");
    await planPaiMigration({ homeDir, paiPacksDir: packsDir, skipMemory: true, emitResolutionPath: resolution });
    await rewriteResolutionPick(resolution, null);

    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution });

    expect(result.packs.some((pack) => pack.skillName === "browser")).toBe(false);
    expect(result.packOutcomes.filter((outcome) =>
      outcome.outcome === "refused-name-collision" && outcome.skillName === "browser"
    )).toHaveLength(2);
  });
});

test("#114 AC-4: unknown resolution collisions refuse loud", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir }) => {
    const resolution = join(homeDir, "bad-resolution.yaml");
    await writeFile(resolution, "collisions:\n  not-current:\n    pick: null\n", "utf8");

    await expect(migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution }))
      .rejects.toThrow("unknown collision 'not-current'");
  });
});

test("#114 review: invalid resolution collision keys refuse loud", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir }) => {
    const resolution = join(homeDir, "bad-resolution.yaml");
    await writeFile(resolution, "collisions:\n  browser_v2:\n    pick: null\n", "utf8");

    await expect(migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution }))
      .rejects.toThrow("invalid collision key 'browser_v2'");
  });
});

test("#114 review: preamble metadata before collisions is ignored", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir, utilitiesPack }) => {
    const resolution = join(homeDir, "migration-resolve.yaml");
    await planPaiMigration({ homeDir, paiPacksDir: packsDir, skipMemory: true, emitResolutionPath: resolution });
    await rewriteResolutionPick(resolution, utilitiesPack);
    const body = await readFile(resolution, "utf8");
    await writeFile(resolution, `  metadata:\n    pick: null\n${body}`, "utf8");

    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution });
    const importedBrowser = result.packOutcomes.find((outcome) =>
      outcome.outcome === "imported" && outcome.skillName === "browser"
    );
    expect(importedBrowser?.paiPackDir).toBe(utilitiesPack);
  });
});

test("#114 review: non-empty resolution without collisions block refuses loud", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir }) => {
    const resolution = join(homeDir, "bad-resolution.yaml");
    await writeFile(resolution, "metadata:\n  generatedBy: test\n", "utf8");

    await expect(migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution }))
      .rejects.toThrow("missing a collisions block");
  });
});

test("#114 review: empty resolution files refuse loud", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir }) => {
    const resolution = join(homeDir, "empty-resolution.yaml");
    await writeFile(resolution, "", "utf8");

    await expect(migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution }))
      .rejects.toThrow("missing a collisions block");
  });
});

test("#114 AC-5: no resolution preserves first-wins behavior", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir, browserPack }) => {
    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true });

    const importedBrowser = result.packOutcomes.find((outcome) =>
      outcome.outcome === "imported" && outcome.skillName === "browser"
    );
    expect(importedBrowser?.paiPackDir).toBe(browserPack);
    expect(result.packOutcomes.some((outcome) =>
      outcome.outcome === "refused-name-collision" && outcome.skillName === "browser"
    )).toBe(true);
  });
});

test("#114 AC-6: CLI emits and consumes resolution files", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir, utilitiesPack }) => {
    const resolution = join(homeDir, "migration-resolve.yaml");
    await runSomaCli([
      "migrate",
      "pai",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
      "--skip-memory",
      "--emit-resolution",
      resolution,
    ]);
    await rewriteResolutionPick(resolution, utilitiesPack);

    const output = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
      "--skip-memory",
      "--resolution",
      resolution,
    ]);

    expect(output).toContain("soma migrate pai — applied");
    expect(output).toContain("Resolution file picked");
  });
});

test("#114 review: emit and consume refuse the same resolution path", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir, utilitiesPack }) => {
    const resolution = join(homeDir, "migration-resolve.yaml");
    await planPaiMigration({ homeDir, paiPacksDir: packsDir, skipMemory: true, emitResolutionPath: resolution });
    await rewriteResolutionPick(resolution, utilitiesPack);

    await expect(migratePai({
      homeDir,
      paiPacksDir: packsDir,
      skipMemory: true,
      emitResolutionPath: resolution,
      resolutionPath: resolution,
    })).rejects.toThrow("--emit-resolution and --resolution must use different files");

    expect(await readFile(resolution, "utf8")).toContain(`pick: "${utilitiesPack}"`);
  });
});

test("#114 review: emitted quoted paths preserve hash-looking text", async () => {
  await withSharedTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    const browserPack = join(packsDir, "Browser");
    await writeFlatPack(browserPack, "Browser");
    const utilitiesPack = await writeNestedPack(packsDir, "Utilities", ["Browser"]);
    const resolution = join(homeDir, "migration-resolve.yaml");

    await planPaiMigration({ homeDir, paiPacksDir: packsDir, skipMemory: true, emitResolutionPath: resolution });
    await rewriteResolutionPick(resolution, utilitiesPack);

    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution });
    const importedBrowser = result.packOutcomes.find((outcome) =>
      outcome.outcome === "imported" && outcome.skillName === "browser"
    );
    expect(importedBrowser?.paiPackDir).toBe(utilitiesPack);
  }, "soma-114- # hash-path-");
});

test("#114 review: single-quoted YAML picks preserve doubled apostrophes", async () => {
  await withSharedTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    const browserPack = join(packsDir, "Browser");
    await writeFlatPack(browserPack, "Browser");
    const utilitiesPack = await writeNestedPack(packsDir, "Utilities", ["Browser"]);
    const resolution = join(homeDir, "migration-resolve.yaml");

    await planPaiMigration({ homeDir, paiPacksDir: packsDir, skipMemory: true, emitResolutionPath: resolution });
    let body = await readFile(resolution, "utf8");
    body = body.replace(/^    pick: .+$/m, `    pick: '${utilitiesPack.replaceAll("'", "''")}'`);
    await writeFile(resolution, body, "utf8");

    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution });
    const importedBrowser = result.packOutcomes.find((outcome) =>
      outcome.outcome === "imported" && outcome.skillName === "browser"
    );
    expect(importedBrowser?.paiPackDir).toBe(utilitiesPack);
  }, "soma-114-John's-path-");
});

test("#114 review: quoted picks allow comments and reject trailing tokens", async () => {
  await withCollisionFixture(async ({ homeDir, packsDir, utilitiesPack }) => {
    const resolution = join(homeDir, "migration-resolve.yaml");
    await planPaiMigration({ homeDir, paiPacksDir: packsDir, skipMemory: true, emitResolutionPath: resolution });
    let body = await readFile(resolution, "utf8");
    body = body.replace(/^    pick: .+$/m, `    pick: "${utilitiesPack}" # choose nested`);
    await writeFile(resolution, body, "utf8");
    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution });
    const importedBrowser = result.packOutcomes.find((outcome) =>
      outcome.outcome === "imported" && outcome.skillName === "browser"
    );
    expect(importedBrowser?.paiPackDir).toBe(utilitiesPack);

    body = body.replace(" # choose nested", " unexpected");
    await writeFile(resolution, body, "utf8");
    await expect(migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true, resolutionPath: resolution }))
      .rejects.toThrow("invalid quoted scalar trailing content");
  });
});
