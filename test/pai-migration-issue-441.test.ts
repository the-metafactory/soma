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
 * The manifest body (`MIGRATION.md`) must stay byte-identical across a
 * genuinely idempotent rerun — the existing invariant asserted by
 * `test/pai-migration.test.ts` ("migratePai is idempotent at the file
 * level") and `test/pai-migration-issue-90.test.ts`. Reserved-skip is
 * a per-run split of the SAME end-state file set (written vs.
 * skipped-because-already-present), so the identity file *count* and
 * *fingerprint* in the manifest are computed over the union of `files`
 * + `skippedReserved`, not `files` alone. Without the union, run 1
 * (writes purpose.md → in `files`) and run 2 (skips it → in
 * `skippedReserved`) would report different identity counts /
 * fingerprints and the manifest would drift on an idempotent rerun.
 * The union mirrors the memory phase's `writtenCount + skippedCount`
 * end-state accounting (`renderStableMigrationManifest` /
 * `renderManifest` in `src/pai-migration.ts`). The per-run skip detail
 * lives only in the CLI's ephemeral summary output.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { migratePai } from "../src/pai-migration";
import { runSomaCli } from "../src/cli";
import { withTempHome, writePaiIdentityFixture as writePaiFixture } from "./fixtures/pai-migration-fixtures";

test("#441 migratePai manifest is byte-identical across a genuinely idempotent rerun even though run 2 reserved-skips purpose.md", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });

    // Run 1 creates purpose.md (in `files`). Run 2 sees it already on
    // disk and reserved-skips it (in `skippedReserved`). No mutation
    // between runs → the manifest body must be byte-identical. This is
    // the direct regression guard: computing the identity count /
    // fingerprint over `files` alone (not the union with
    // `skippedReserved`) would drop the count by one and change the
    // fingerprint on run 2, drifting the manifest.
    const first = await migratePai({ homeDir });
    const purposePath = join(homeDir, ".soma/profile/purpose.md");
    const firstManifest = await readFile(first.manifestPath, "utf8");
    // Run 1 wrote purpose.md; nothing was reserved-skipped yet.
    expect(first.identity.files).toContain(purposePath);
    expect(first.identity.skippedReserved ?? []).not.toContain(purposePath);

    const second = await migratePai({ homeDir });
    // Run 2 reserved-skipped the now-present purpose.md instead of writing it.
    expect(second.identity.skippedReserved ?? []).toContain(purposePath);
    expect(second.identity.files).not.toContain(purposePath);

    // The whole manifest body — not just one line — must be byte-for-byte
    // identical across the idempotent rerun (the `Last migrated at:`
    // timestamp is preserved by the importer's idempotency machinery, so
    // a direct full-body comparison is deterministic; same pattern as
    // pai-migration-issue-90's manifest-stability assertion).
    const secondManifest = await readFile(second.manifestPath, "utf8");
    expect(secondManifest).toBe(firstManifest);
  });
});

test("#441 migratePai leaves a hand-curated purpose.md byte-unchanged on rerun", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });

    await migratePai({ homeDir });
    const purposePath = join(homeDir, ".soma/profile/purpose.md");

    // Simulate hand-curation between runs (content diverges from what
    // the importer would generate).
    const curated = "# Purpose\n\nHand-curated mission, must survive rerun.\n";
    await writeFile(purposePath, curated, "utf8");

    const second = await migratePai({ homeDir });

    expect(await readFile(purposePath, "utf8")).toBe(curated);
    expect(second.identity.skippedReserved ?? []).toContain(purposePath);
    expect(second.identity.files).not.toContain(purposePath);
    // principal.md / assistant.md are deterministic distillations and
    // are still (re)written every run.
    expect(second.identity.files).toContain(join(homeDir, ".soma/profile/principal.md"));
    expect(second.identity.files).toContain(join(homeDir, ".soma/profile/assistant.md"));
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
