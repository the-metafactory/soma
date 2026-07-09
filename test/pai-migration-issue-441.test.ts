/**
 * #441 — `soma migrate pai`'s identity importer clobbered a
 * hand-curated `profile/purpose.md` on every rerun. `purpose.md` is
 * the source of truth `src/soma-home.ts` reads to build every
 * substrate's projected Purpose, so a clobber propagates a placeholder
 * mission everywhere on the next reproject.
 *
 * Fix: `profile/purpose.md` is now a reserved identity target. Once it
 * exists on disk, `migrate pai` / `import pai` leave it untouched
 * unless `--overwrite-reserved` is passed. `principal.md` /
 * `assistant.md` stay deterministic distillations and are always
 * (re)written.
 *
 * The manifest body (`MIGRATION.md`) must stay byte-stable across a
 * genuinely idempotent rerun (established invariant — see
 * `renderManifest`'s Sage r1 #28 comment). Reserved-skip is a
 * per-run split of the SAME end-state file set (written vs.
 * skipped-because-already-present), so the identity file *count* and
 * *fingerprint* in the manifest must be computed over the union of
 * `files` + `skippedReserved`, not `files` alone — otherwise the count
 * would drop from run 1 (creates purpose.md) to run 2+ (skips it),
 * breaking the existing idempotency tests. The per-run skip detail
 * lives only in the CLI's ephemeral summary output, matching the
 * memory phase's existing "written N / unchanged M" precedent.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { migratePai } from "../src/pai-migration";
import { runSomaCli } from "../src/cli";
import { withTempHome, writePaiIdentityFixture as writePaiFixture } from "./fixtures/pai-migration-fixtures";

test("#441 migratePai leaves a curated purpose.md untouched on rerun; manifest stays byte-stable", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });

    const first = await migratePai({ homeDir });
    const purposePath = join(homeDir, ".soma/profile/purpose.md");
    const firstManifest = await readFile(first.manifestPath, "utf8");

    // Simulate hand-curation between runs.
    const curated = "# Purpose\n\nHand-curated mission, must survive rerun.\n";
    await writeFile(purposePath, curated, "utf8");

    const second = await migratePai({ homeDir });

    expect(await readFile(purposePath, "utf8")).toBe(curated);
    expect(second.identity.skippedReserved ?? []).toContain(purposePath);
    expect(second.identity.files).not.toContain(purposePath);

    // The manifest's identity file count + fingerprint are end-state
    // facts (written + skipped-reserved), not "what this run wrote" —
    // so a rerun with no real content drift must not change the
    // manifest body byte-for-byte, even though the curated file moved
    // from `files` to `skippedReserved` between the two runs.
    const secondManifest = await readFile(second.manifestPath, "utf8");
    const identityLine = (text: string) => text.split("\n").find((l) => l.trim().startsWith("- identity:"));
    expect(identityLine(secondManifest)).toBe(identityLine(firstManifest));
  });
});

test("#441 migratePai --overwrite-reserved replaces a curated purpose.md", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    await migratePai({ homeDir });

    const purposePath = join(homeDir, ".soma/profile/purpose.md");
    await writeFile(purposePath, "# Purpose\n\nHand-curated, about to be overwritten.\n", "utf8");

    const second = await migratePai({ homeDir, overwriteReserved: true });

    expect(second.identity.files).toContain(purposePath);
    expect(second.identity.skippedReserved ?? []).not.toContain(purposePath);
    await expect(readFile(purposePath, "utf8")).resolves.not.toContain("Hand-curated, about to be overwritten.");
  });
});

test("#441 soma migrate pai --apply reports skipped reserved purpose.md", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    await runSomaCli(["migrate", "pai", "--apply", "--home-dir", homeDir]);

    const purposePath = join(homeDir, ".soma/profile/purpose.md");
    await writeFile(purposePath, "# Purpose\n\nHand-curated via CLI migrate.\n", "utf8");

    const applied = await runSomaCli(["migrate", "pai", "--apply", "--home-dir", homeDir]);
    expect(applied).toContain("skipped reserved");
    expect(applied).toContain("profile/purpose.md");
    expect(applied).toContain("--overwrite-reserved");
    await expect(readFile(purposePath, "utf8")).resolves.toContain("Hand-curated via CLI migrate.");

    const overwritten = await runSomaCli(["migrate", "pai", "--apply", "--home-dir", homeDir, "--overwrite-reserved"]);
    expect(overwritten).not.toContain("skipped reserved");
    await expect(readFile(purposePath, "utf8")).resolves.not.toContain("Hand-curated via CLI migrate.");
  });
});
