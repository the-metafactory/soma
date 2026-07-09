// soma#370 acceptance tests: uniform provenance headers stay byte-idempotent
// across a second reproject, and the shared content-compare doctor
// (src/adapters/content-compare-doctor.ts) correctly classifies missing /
// unmanaged / stale drift and maps to the right `soma doctor` exit code.
//
// test/onboarding-doctor.test.ts already exercises codex/claude-code/grok
// through `diagnoseSomaDoctor` at the CLI-integration level (including the
// grok oracle-plus-content-compare composition). This file adds the two
// substrates that had NO prior doctor coverage at all — cursor (with its
// merge-block-aware `.cursorrules` special case) and pi-dev — plus a direct
// cross-substrate byte-idempotency sweep and an explicit 0/1/2 exit-code
// mapping.

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { PROJECTION_LIFECYCLE_SUBSTRATES, type InstallSubstrate } from "../src/cli/substrate-lifecycle";
import { installSomaForCursor, installSomaForPiDev } from "../src/index";
import { diagnoseContentCompareDrift } from "../src/adapters/content-compare-doctor";
import { expectSomaCliError } from "./fixtures/cli-error";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-content-compare-doctor-");

/** Every regular file's bytes under any of `roots` (file or directory), keyed by absolute path. */
async function collectFileBytes(roots: string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(path: string): Promise<void> {
    const info = await stat(path).catch(() => null);
    if (info === null) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await walk(join(path, entry));
      return;
    }
    if (info.isFile()) files[path] = await readFile(path, "utf8").catch(() => "<binary>");
  }
  for (const root of roots) await walk(root);
  return files;
}

// Each substrate's own default home root(s) — cursor is the odd one out
// (`defaultHome: "."`, so its files land directly under homeDir: `.cursor/`
// AND the sibling `.cursorrules` file).
function substrateRoots(homeDir: string, substrate: InstallSubstrate): string[] {
  if (substrate === "cursor") return [join(homeDir, ".cursor"), join(homeDir, ".cursorrules")];
  const dirName = substrate === "pi-dev" ? ".pi" : substrate === "claude-code" ? ".claude" : `.${substrate}`;
  return [join(homeDir, dirName)];
}

test("soma#370: reprojecting every doctor-supported substrate twice is byte-identical, headers included", async () => {
  for (const substrate of PROJECTION_LIFECYCLE_SUBSTRATES) {
    await withTempHome(async (homeDir) => {
      await runSomaCli(["install", substrate, "--apply", "--home-dir", homeDir]);
      const roots = substrateRoots(homeDir, substrate);
      const before = await collectFileBytes(roots);
      expect(Object.keys(before).length).toBeGreaterThan(0);

      await runSomaCli(["reproject", substrate, "--home-dir", homeDir]);
      const after = await collectFileBytes(roots);

      expect(after).toEqual(before);

      // The doctor itself must agree: a substrate that just reprojected
      // cleanly has zero content-compare drift for that substrate. Uses
      // diagnoseContentCompareDrift directly (not the full `soma doctor`
      // CLI text) so this loop is not coupled to unrelated onboarding
      // findings (e.g. `starter-profile`, which every freshly-bootstrapped
      // test home carries and which would otherwise make the CLI exit
      // non-zero for a reason unrelated to this test).
      const findings = await diagnoseContentCompareDrift({
        substrate,
        homeDir,
        somaHome: join(homeDir, ".soma"),
      });
      expect(findings).toEqual([]);
    });
  }
});

test("soma#370: cursor content-compare is clean right after install", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCursor({ homeDir });

    const findings = await diagnoseContentCompareDrift({ substrate: "cursor", homeDir, somaHome: join(homeDir, ".soma") });

    expect(findings).toEqual([]);
  });
});

test("soma#370: content-compare does NOT fail open on an unbootstrapped home — surfaces info not-diagnosable", async () => {
  await withTempHome(async (homeDir) => {
    // No install/bootstrap at all: the Soma home has no profile, so the
    // source projection cannot be built to compare against. Returning `[]`
    // (clean/ok) would claim coverage never performed — instead an `info`
    // not-diagnosable finding is emitted (keeps exit 0, but honest).
    for (const substrate of ["cursor", "pi-dev"] as const) {
      const findings = await diagnoseContentCompareDrift({ substrate, homeDir, somaHome: join(homeDir, ".soma") });
      expect(findings).toHaveLength(1);
      expect(findings[0].id).toBe(`${substrate}-not-diagnosable`);
      expect(findings[0].severity).toBe("info");
      expect(findings[0].action).toBe(`soma install ${substrate}`);
      // Never a bare "missing" (which would falsely claim to know what
      // SHOULD be on disk) and never a clean empty result.
      expect(findings.some((f) => f.id.endsWith("-projection-missing"))).toBe(false);
    }
  });
});

test("soma#370: cursor content-compare flags a missing whole projection as an error", async () => {
  await withTempHome(async (homeDir) => {
    // Soma home bootstrapped (via install then a hard reset of the cursor
    // side) so content-compare can build a fresh comparison, but nothing
    // was ever written under `.cursor` / `.cursorrules`.
    await installSomaForCursor({ homeDir });
    await runSomaCli(["uninstall", "cursor", "--home-dir", homeDir]);

    const findings = await diagnoseContentCompareDrift({ substrate: "cursor", homeDir, somaHome: join(homeDir, ".soma") });

    expect(findings).toContainEqual({
      id: "cursor-projection-missing",
      severity: "error",
      message: "Cursor projection is missing.",
      action: "soma reproject cursor",
    });
  });
});

test("soma#370: cursor .cursorrules — hand-stripped Soma block reads as unmanaged, corrupted block body reads as stale", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCursor({ homeDir });
    const cursorRulesPath = join(homeDir, ".cursorrules");

    // Strip the Soma block markers entirely (simulate hand-replacing the
    // whole file) — no markers at all means "not currently managed", not
    // merely "stale".
    await writeFile(cursorRulesPath, "# My own rules\n\nKeep this.\n", "utf8");
    const unmanaged = await diagnoseContentCompareDrift({ substrate: "cursor", homeDir, somaHome: join(homeDir, ".soma") });
    const unmanagedFinding = unmanaged.find((f) => f.id === "cursor-projection-unmanaged-edit");
    expect(unmanagedFinding).toBeDefined();
    expect(unmanagedFinding?.message).toContain(".cursorrules");

    // Now corrupt the BODY inside the still-present markers — this is a
    // managed block whose content merely lags a fresh render.
    await installSomaForCursor({ homeDir }); // restore a clean, marker-bearing file
    const clean = await readFile(cursorRulesPath, "utf8");
    const corrupted = clean.replace(/Do not edit this file by hand[^\n]*/, "Do not edit this file by hand (CORRUPTED)");
    expect(corrupted).not.toBe(clean);
    await writeFile(cursorRulesPath, corrupted, "utf8");

    const stale = await diagnoseContentCompareDrift({ substrate: "cursor", homeDir, somaHome: join(homeDir, ".soma") });
    const staleFinding = stale.find((f) => f.id === "cursor-projection-stale");
    expect(staleFinding).toBeDefined();
    expect(staleFinding?.message).toContain(".cursorrules");
    expect(stale.find((f) => f.id === "cursor-projection-unmanaged-edit")).toBeUndefined();
  });
});

test("soma#370: pi-dev content-compare is clean right after install, and flags a hand-edited projected file", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForPiDev({ homeDir });

    const clean = await diagnoseContentCompareDrift({ substrate: "pi-dev", homeDir, somaHome: join(homeDir, ".soma") });
    expect(clean).toEqual([]);

    // Overwrite a header-eligible projected file with content that has NO
    // provenance header. Because the fresh projection of tools.md carries the
    // header and the on-disk copy no longer does, this reads as UNMANAGED
    // (hand-replaced), not stale — the doctor sees the managed-projection
    // signal (the header) is gone.
    await writeFile(join(homeDir, ".pi/agent/soma/tools.md"), "not the real tools doc\n", "utf8");
    const drifted = await diagnoseContentCompareDrift({ substrate: "pi-dev", homeDir, somaHome: join(homeDir, ".soma") });
    const finding = drifted.find((f) => f.id === "pi-dev-projection-unmanaged-edit");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("agent/soma/tools.md");
    expect(drifted.find((f) => f.id === "pi-dev-projection-stale")).toBeUndefined();
  });
});

test("soma#370: soma doctor exit codes map 0 (clean) / 1 (drift) / 2 (missing file)", async () => {
  await withTempHome(async (homeDir) => {
    // A non-starter principal.md so the ONLY thing under test is content-
    // compare drift — bootstrapSomaHome (called inside installSomaForPiDev)
    // never overwrites an existing profile file, so this survives install
    // and keeps the baseline genuinely `soma doctor — ok`, not drift from
    // an unrelated `starter-profile` finding.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(homeDir, ".soma/profile"), { recursive: true });
    await writeFile(join(homeDir, ".soma/profile/principal.md"), "# Principal\n\nName: Test Principal\n", "utf8");
    await installSomaForPiDev({ homeDir });

    // 0 — clean.
    const cleanOutput = await runSomaCli(["doctor", "--substrate", "pi-dev", "--home-dir", homeDir]);
    expect(cleanOutput).toContain("soma doctor — ok");

    // 1 — drift (a rendered file present but stale).
    await writeFile(join(homeDir, ".pi/agent/soma/tools.md"), "stale body\n", "utf8");
    const driftError = await expectSomaCliError(["doctor", "--substrate", "pi-dev", "--home-dir", homeDir]);
    expect(driftError.exitCode).toBe(1);
    expect(driftError.message).toContain("soma doctor — drift detected");

    // 2 — error (a rendered file missing entirely).
    await runSomaCli(["uninstall", "pi-dev", "--home-dir", homeDir]).catch(() => {
      // pi-dev uninstall is reserved/unimplemented (see src/adapters/pi-dev/install.ts) —
      // fall back to deleting the directory tree by hand so "missing" is genuine.
    });
    const { rm } = await import("node:fs/promises");
    await rm(join(homeDir, ".pi"), { recursive: true, force: true });
    const missingError = await expectSomaCliError(["doctor", "--substrate", "pi-dev", "--home-dir", homeDir]);
    expect(missingError.exitCode).toBe(2);
    expect(missingError.message).toContain("soma doctor — errors detected");
    expect(missingError.message).toContain("pi-dev-projection-missing");
  });
});
