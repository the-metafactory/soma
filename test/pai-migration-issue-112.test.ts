/**
 * #112 — `soma migrate pai` plan-mode exit semantics.
 *
 * Pre-#112 (per #97 AC-4 mirror in #102): plan mode shared the apply
 * mode's exit policy — any `refused-other` outcome caused a non-zero
 * CLI exit AFTER printing the full plan body.
 *
 * #112 splits the policy by mode:
 *
 *   | Mode  | refused-other present | Exit |
 *   | ----- | --------------------- | ---- |
 *   | plan  | yes                   | 0    |  (NEW — was 1)
 *   | plan  | no                    | 0    |
 *   | apply | yes                   | 1    |  (unchanged)
 *   | apply | no                    | 0    |
 *
 * Rationale: dry-run on a known-malformed upstream PAI pack adds
 * friction without informing the human. CI scripts that need a hard
 * signal pass `--apply`; that path keeps exit 1 on genuine errors per
 * #97 AC-4. The footer "N pack(s) failed with genuine errors:" line
 * STAYS in both modes — it's the principal signal regardless of exit
 * code.
 *
 * AC-4 of #112: fixture tests cover all 4 cells of the
 * mode × refused-other matrix. This file is those tests.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli, SomaCliError } from "../src/cli";
import {
  withTempHome as withSharedTempHome,
  writePaiIdentityFixture as writeIdentityFixture,
  writePaiPackFixture as writePackFixture,
} from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-112-");

/**
 * A pack missing INSTALL.md is "malformed" by the importer's
 * REQUIRED_PACK_FILES check — the issue's outcome enum classifies it
 * `refused-other`. Mirrors the helper in `pai-migration-issue-97.test.ts`.
 */
async function makeMalformedPack(packsDir: string, packName: string): Promise<void> {
  const packDir = join(packsDir, packName);
  await mkdir(join(packDir, "src"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    `---\nname: ${packName}\ndescription: malformed\n---\n\n# ${packName}\n`,
    "utf8",
  );
  // INSTALL.md intentionally omitted.
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    `---\nname: ${packName}\ndescription: malformed\n---\n\n# ${packName}\n`,
    "utf8",
  );
}

const FOOTER_RE = /\d+ pack\(s\) failed with genuine errors:/;

test("AC-1 — plan mode (no --apply) with refused-other exits 0 + footer line present", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await makeMalformedPack(packsDir, "Broken");
    await writePackFixture(packsDir, "Healthy");
    // Plan mode = no --apply.
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    // No throw → exit 0. Footer still present in the returned text.
    expect(out).toMatch(FOOTER_RE);
    expect(out).toMatch(/refused-other/);
  });
});

test("AC-1 (matrix cell: plan + no refused-other) → exit 0 + no footer", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "Alpha");
    await writePackFixture(packsDir, "Beta");
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    expect(out).not.toMatch(FOOTER_RE);
  });
});

test("AC-2 — apply mode with refused-other exits 1 + footer line present (unchanged from #97 AC-4)", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await makeMalformedPack(packsDir, "Broken");
    await writePackFixture(packsDir, "Healthy");
    let caught: unknown = null;
    try {
      await runSomaCli([
        "migrate",
        "pai",
        "--apply",
        "--home-dir",
        homeDir,
        "--pai-packs-dir",
        packsDir,
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SomaCliError);
    expect((caught as SomaCliError).exitCode).toBe(1);
    // Footer line is in the error message.
    expect((caught as SomaCliError).message).toMatch(FOOTER_RE);
    // Healthy pack still imported despite Broken pack's refusal —
    // log-and-continue from #97.
    await stat(join(homeDir, ".soma/skills/healthy/SKILL.md"));
  });
});

test("AC-2 (matrix cell: apply + no refused-other) → exit 0 + no footer", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "Alpha");
    await writePackFixture(packsDir, "Beta");
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    expect(out).not.toMatch(FOOTER_RE);
    // Both packs landed.
    await stat(join(homeDir, ".soma/skills/alpha/SKILL.md"));
    await stat(join(homeDir, ".soma/skills/beta/SKILL.md"));
  });
});

test("AC-3 — footer line wording matches across both modes (plan + apply)", async () => {
  // The footer line is the principal signal regardless of exit code.
  // The wording must be byte-identical across modes so downstream
  // stdout parsers don't need to branch on mode.
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await makeMalformedPack(packsDir, "Broken");
    await writePackFixture(packsDir, "Healthy");
    const planOut = await runSomaCli([
      "migrate",
      "pai",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    let applyErr: SomaCliError | null = null;
    try {
      await runSomaCli([
        "migrate",
        "pai",
        "--apply",
        "--home-dir",
        homeDir,
        "--pai-packs-dir",
        packsDir,
      ]);
    } catch (err) {
      applyErr = err as SomaCliError;
    }
    expect(applyErr).not.toBeNull();
    // Same footer line in both outputs.
    const planFooter = planOut.match(/\d+ pack\(s\) failed with genuine errors:.*?(?:\n|$)/);
    const applyFooter = applyErr!.message.match(/\d+ pack\(s\) failed with genuine errors:.*?(?:\n|$)/);
    expect(planFooter).not.toBeNull();
    expect(applyFooter).not.toBeNull();
    expect(planFooter![0]).toBe(applyFooter![0]);
  });
});
