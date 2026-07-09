import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { planSomaInit, diagnoseSomaDoctor } from "../src/onboarding";
import { withProvenance } from "../src/adapters/shared/provenance";
import { runSomaCli } from "../src/cli";
import { DOCTOR_SUPPORTED_SUBSTRATES, isDoctorSubstrate } from "../src/adapters/doctor";
import { bootstrapSomaHome, installSomaForClaudeCode, installSomaForCodex } from "../src/index";
import { expectSomaCliError } from "./fixtures/cli-error";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-onboarding-");

async function writeMinimalPaiInstall(homeDir: string): Promise<void> {
  await mkdir(join(homeDir, ".claude/PAI/USER"), { recursive: true });
  await mkdir(join(homeDir, ".claude/PAI/Algorithm"), { recursive: true });
  await mkdir(join(homeDir, ".claude/skills/Portable"), { recursive: true });
  await mkdir(join(homeDir, ".config/pai/CORE_USER"), { recursive: true });
  await mkdir(join(homeDir, ".claude/PAI/USER/TELOS"), { recursive: true });
  await writeFile(join(homeDir, ".claude/PAI/USER/PRINCIPAL_IDENTITY.md"), "Name: Principal\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/USER/DA_IDENTITY.md"), "Name: Soma\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/USER/TELOS/MISSION.md"), "Mission: Keep context portable.\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/USER/TELOS/GOALS.md"), "- Migrate safely.\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/USER/TELOS/BELIEFS.md"), "- Portability matters.\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/Algorithm/v6.3.0.md"), "# Algorithm\n", "utf8");
  await writeFile(
    join(homeDir, ".claude/skills/Portable/SKILL.md"),
    "---\nname: Portable\ndescription: Portable test skill\n---\n# Portable\n",
    "utf8",
  );
  await writeFile(join(homeDir, ".config/pai/CORE_USER/profile.md"), "core user\n", "utf8");
}

test("planSomaInit orders PAI migrant commands as dry-run copy-paste steps", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);

    const plan = await planSomaInit({ homeDir });

    expect(plan.mode).toBe("dry-run");
    expect(plan.detected.paiInstall).toBe(join(homeDir, ".claude"));
    expect(plan.detected.claudeSkillsDir).toBe(join(homeDir, ".claude/skills"));
    expect(plan.detected.coreUserDir).toBe(join(homeDir, ".config/pai/CORE_USER"));
    expect(plan.soma.starterProfile).toBe(false);
    expect(plan.detected.claudeSkillsStatus).toBe("importable");
    expect(plan.steps.map((step) => step.id)).toEqual([
      "bootstrap-soma-home",
      "migrate-claude-skills",
      "migrate-pai",
      "install-codex",
    ]);
    expect(plan.steps.map((step) => (step.kind === "command" ? step.command : step.action))).toEqual([
      `create Soma home skeleton at ${join(homeDir, ".soma")} (identity, purpose, memory, skills, policy)`,
      `soma migrate claude-skills --from ${join(homeDir, ".claude/skills")} --dry-run --home-dir ${homeDir} --soma-home ${join(homeDir, ".soma")}`,
      `soma migrate pai --pai-install ${join(homeDir, ".claude")} --dry-run --home-dir ${homeDir} --soma-home ${join(homeDir, ".soma")}`,
      `soma install codex --dry-run --home-dir ${homeDir} --soma-home ${join(homeDir, ".soma")}`,
    ]);
    expect(plan.steps.map((step) => step.kind)).toEqual(["builtin", "command", "command", "command"]);
  });
});

test("soma init rejects anthropic-cowork until a verified load primitive exists", async () => {
  await withTempHome(async (homeDir) => {
    await expect(runSomaCli(["init", "--substrate", "anthropic-cowork", "--home-dir", homeDir])).rejects.toThrow(
      "soma init does not support anthropic-cowork yet",
    );
    await expect(planSomaInit({ homeDir, substrate: "anthropic-cowork" as never })).rejects.toThrow(
      "soma init does not support anthropic-cowork yet",
    );
  });
});

test("planSomaInit shell-quotes paths in copy-paste commands", async () => {
  await withTempHome(async (root) => {
    const homeDir = join(root, "home with spaces");
    await writeMinimalPaiInstall(homeDir);

    const plan = await planSomaInit({
      homeDir,
      somaHome: join(homeDir, "soma home"),
    });

    const stepText = (index: number): string => {
      const step = plan.steps[index];
      if (!step) return "";
      return step.kind === "command" ? step.command : step.action;
    };
    expect(stepText(0)).toContain(`'${join(homeDir, "soma home")}'`);
    expect(stepText(1)).toContain(`--from '${join(homeDir, ".claude/skills")}'`);
    expect(stepText(1)).toContain(`--home-dir '${homeDir}'`);
    expect(stepText(1)).toContain(`--soma-home '${join(homeDir, "soma home")}'`);
  });
});

test("soma init --apply applies detected migration phases", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);

    const output = await runSomaCli(["init", "--apply", "--home-dir", homeDir]);

    expect(output).toContain("soma init — applied");
    expect(output).toContain("bootstrap-soma-home: applied");
    expect(output).toContain("migrate-claude-skills: applied");
    expect(output).toContain("migrate-pai: applied");
    expect(output).toContain("install-codex: applied");
    await expect(stat(join(homeDir, ".soma/imports/claude-skills/.manifest.json"))).resolves.toBeTruthy();
    await expect(stat(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"))).resolves.toBeTruthy();
    await expect(stat(join(homeDir, ".codex/rules/soma.rules"))).resolves.toBeTruthy();
  });
});

test("soma init --yes still works as a deprecated alias for --apply", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);

    const output = await runSomaCli(["init", "--yes", "--home-dir", homeDir]);

    expect(output).toContain("soma init — applied");
    expect(output).toContain("install-codex: applied");
  });
});

test("soma init on a fresh machine (no Claude install) bootstraps the Soma home", async () => {
  await withTempHome(async (homeDir) => {
    const plan = await planSomaInit({ homeDir });
    expect(plan.detected.paiInstall).toBeNull();
    expect(plan.detected.claudeSkillsDir).toBeNull();
    expect(plan.steps.map((step) => step.id)).toEqual([
      "bootstrap-soma-home",
      "install-codex",
    ]);

    const output = await runSomaCli(["init", "--apply", "--home-dir", homeDir]);
    expect(output).toContain("bootstrap-soma-home: applied");
    expect(output).not.toContain("migrate-claude-skills");
    const principal = await readFile(join(homeDir, ".soma/profile/principal.md"), "utf8");
    expect(principal).toContain("status: starter-profile");
    await expect(stat(join(homeDir, ".soma/profile/purpose.md"))).resolves.toBeTruthy();
    await expect(stat(join(homeDir, ".soma/memory"))).resolves.toBeTruthy();
  });
});

test("soma init skips Claude skills migration when the skills dir is empty", async () => {
  await withTempHome(async (homeDir) => {
    // A fresh Claude Code install ships an EMPTY ~/.claude/skills — init
    // must not plan a migrate step that would refuse (user feedback,
    // 2026-06-12).
    await mkdir(join(homeDir, ".claude/skills"), { recursive: true });

    const plan = await planSomaInit({ homeDir });
    expect(plan.detected.claudeSkillsDir).toBe(join(homeDir, ".claude/skills"));
    expect(plan.detected.claudeSkillsStatus).toBe("empty");
    expect(plan.steps.map((step) => step.id)).toEqual([
      "bootstrap-soma-home",
      "install-codex",
    ]);

    const output = await runSomaCli(["init", "--apply", "--home-dir", homeDir]);
    expect(output).toContain("soma init — applied");
    expect(output).not.toContain("migrate-claude-skills");
    await expect(stat(join(homeDir, ".soma/profile/principal.md"))).resolves.toBeTruthy();
  });
});

test("soma init skips a non-flat Claude skills dir yet still populates the home (#318)", async () => {
  await withTempHome(async (homeDir) => {
    // soma#318 (reported on 0.8.5): a ~/.claude/skills that is NOT a flat
    // <Name>/SKILL.md tree must not trigger a migrate step (which refused
    // with "not a flat skills tree"), and init must still fully populate
    // the Soma home. The reporter saw an empty home plus a confusing
    // import warning; fixed by #309. This locks the non-empty/non-flat
    // variant the empty-dir test above does not cover.
    await mkdir(join(homeDir, ".claude/skills"), { recursive: true });
    await writeFile(join(homeDir, ".claude/skills/loose.md"), "not a <Name>/SKILL.md tree\n", "utf8");

    const plan = await planSomaInit({ homeDir });
    expect(plan.detected.claudeSkillsStatus).toBe("not-importable");
    expect(plan.steps.map((step) => step.id)).toEqual([
      "bootstrap-soma-home",
      "install-codex",
    ]);

    const output = await runSomaCli(["init", "--apply", "--home-dir", homeDir]);
    expect(output).toContain("soma init — applied");
    expect(output).not.toContain("migrate-claude-skills");
    expect(output).not.toContain("not a flat skills tree");
    // Home is fully populated — not the empty dir the reporter observed.
    // Assert across every top-level area the bootstrap creates.
    for (const relative of [
      "profile/assistant.md",
      "profile/principal.md",
      "profile/purpose.md",
      "memory/WORK",
      "memory/KNOWLEDGE",
      "skills/README.md",
      "policy/README.md",
      "vsa/INDEX.md",
      "projections/README.md",
    ]) {
      await expect(stat(join(homeDir, ".soma", relative))).resolves.toBeTruthy();
    }
  });
});

test("re-running soma init --apply never overwrites existing Soma home files", async () => {
  await withTempHome(async (homeDir) => {
    // Proves the doc claim in docs/soma-home-layout.md ("existing files are
    // never overwritten") at the init level (sage cycle 3 on #309).
    await runSomaCli(["init", "--apply", "--home-dir", homeDir]);

    const principalPath = join(homeDir, ".soma/profile/principal.md");
    const telosPath = join(homeDir, ".soma/profile/purpose.md");
    const customPrincipal = "# Principal\n\nName: Jens-Christian\n\n## Profile\n\n- status: customized\n";
    const customTelos = "# Purpose\n\nMission: My own mission.\n";
    await writeFile(principalPath, customPrincipal, "utf8");
    await writeFile(telosPath, customTelos, "utf8");

    await runSomaCli(["init", "--apply", "--home-dir", homeDir]);

    expect(await readFile(principalPath, "utf8")).toBe(customPrincipal);
    expect(await readFile(telosPath, "utf8")).toBe(customTelos);
  });
});

test("soma init labels a non-flat skills tree as not importable, never empty", async () => {
  await withTempHome(async (homeDir) => {
    // Children present, but no <Name>/SKILL.md — e.g. a Packs/-style tree.
    // sage review on #309: this must NOT be reported as "empty".
    await mkdir(join(homeDir, ".claude/skills/SomePack/nested"), { recursive: true });

    const plan = await planSomaInit({ homeDir });
    expect(plan.detected.claudeSkillsStatus).toBe("not-importable");
    expect(plan.steps.map((step) => step.id)).toEqual([
      "bootstrap-soma-home",
      "install-codex",
    ]);

    const output = await runSomaCli(["init", "--home-dir", homeDir]);
    expect(output).toContain("not an importable flat skills tree");
    expect(output).not.toContain("empty — nothing to import");
    expect(output).not.toContain("No existing installation to import");
  });
});

test("soma doctor does not suggest skills migration for an empty Claude skills dir", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".claude/skills"), { recursive: true });
    await runSomaCli(["init", "--apply", "--home-dir", homeDir]);

    const diagnosis = await diagnoseSomaDoctor({ homeDir });
    expect(diagnosis.findings.map((finding) => finding.id)).not.toContain("claude-skills-not-migrated");
  });
});

test("soma doctor reports missing migrations and projection drift actions", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);
    // soma#370: content-compare needs a genuinely loadable Soma profile
    // (unlike the retired profile-mtime heuristic, which only needed a
    // file's mtime) — bootstrapSomaHome gives a complete starter profile
    // (already flagged `status: starter-profile`, feeding the finding
    // below) plus a real codex projection to hand-corrupt.
    await installSomaForCodex({ homeDir });
    await writeFile(join(homeDir, ".codex/rules/soma.rules"), "old projection\n", "utf8");

    const diagnosis = await diagnoseSomaDoctor({ homeDir });
    const caught = await expectSomaCliError(["doctor", "--home-dir", homeDir]);

    expect(diagnosis.status).toBe("drift");
    expect(diagnosis.findings.map((finding) => finding.id)).toEqual([
      "starter-profile",
      "claude-skills-not-migrated",
      "pai-not-migrated",
      "codex-projection-stale",
    ]);
    expect(caught.exitCode).toBe(1);
    expect(caught.message).toContain("soma doctor — drift detected");
    expect(caught.message).toContain("soma migrate claude-skills --from");
    expect(caught.message).toContain("soma migrate pai --pai-install");
    expect(caught.message).toContain(`--home-dir ${homeDir}`);
    expect(caught.message).toContain(`--soma-home ${join(homeDir, ".soma")}`);
    expect(caught.message).toContain("soma reproject codex");
  });
});

test("soma doctor reports a missing Codex projection as an error (soma#370: missing rendered file -> exit 2)", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });

    const diagnosis = await diagnoseSomaDoctor({ homeDir });

    expect(diagnosis.status).toBe("error");
    expect(diagnosis.findings).toContainEqual({
      id: "codex-projection-missing",
      severity: "error",
      message: "Codex projection is missing.",
      action: "soma reproject codex",
    });

    const caught = await expectSomaCliError(["doctor", "--home-dir", homeDir]);
    expect(caught.exitCode).toBe(2);
    expect(caught.message).toContain("soma doctor — errors detected");
    expect(caught.message).toContain("codex-projection-missing");
  });
});

test("soma doctor surfaces broken Soma profile paths", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".soma"), { recursive: true });
    await writeFile(join(homeDir, ".soma/profile"), "not a directory\n", "utf8");

    await expect(diagnoseSomaDoctor({ homeDir })).rejects.toThrow();
  });
});

test("soma init surfaces broken Soma skills paths", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".soma"), { recursive: true });
    await writeFile(join(homeDir, ".soma/skills"), "not a directory\n", "utf8");

    await expect(planSomaInit({ homeDir })).rejects.toThrow();
  });
});

test("soma init --apply fails when Claude skills migration has refused errors", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);
    await mkdir(join(homeDir, ".claude/skills/EmbeddedGit/.git"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude/skills/EmbeddedGit/SKILL.md"),
      "---\nname: EmbeddedGit\ndescription: Bad skill\n---\n# EmbeddedGit\n",
      "utf8",
    );
    await writeFile(join(homeDir, ".claude/skills/EmbeddedGit/.git/config"), "[core]\n", "utf8");

    await expect(runSomaCli(["init", "--apply", "--home-dir", homeDir])).rejects.toThrow(
      "soma init migrate-claude-skills failed",
    );
  });
});

test("soma doctor reports ok after init applies the detected plan", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);

    await runSomaCli(["init", "--apply", "--home-dir", homeDir]);
    const output = await runSomaCli(["doctor", "--home-dir", homeDir]);

    expect(output).toContain("soma doctor — ok");
    expect(output).not.toContain("soma migrate claude-skills --from");
    const migration = await readFile(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"), "utf8");
    expect(migration).toContain("Last migrated at:");
  });
});

async function writeSomaProfile(homeDir: string): Promise<void> {
  // soma#370: content-compare needs a genuinely loadable Soma profile (the
  // retired profile-mtime heuristic only needed a file's mtime, so a bare
  // principal.md used to be enough) — bootstrapSomaHome gives the complete
  // starter profile every content-compare test below relies on.
  await bootstrapSomaHome({ homeDir });
}

test("soma doctor --substrate claude-code reports a fully missing projection as an error", async () => {
  await withTempHome(async (homeDir) => {
    await writeSomaProfile(homeDir);

    const diagnosis = await diagnoseSomaDoctor({ homeDir, substrate: "claude-code" });

    expect(diagnosis.status).toBe("error");
    const ids = diagnosis.findings.map((finding) => finding.id);
    expect(ids).toContain("claude-code-projection-missing");
    expect(ids).toContain("claude-code-hook-missing");
    expect(ids).toContain("claude-code-settings-missing");
    expect(diagnosis.findings).toContainEqual({
      id: "claude-code-projection-missing",
      severity: "error",
      message: "Claude Code projection is missing.",
      action: "soma reproject claude-code",
    });

    const caught = await expectSomaCliError(["doctor", "--substrate", "claude-code", "--home-dir", homeDir]);
    expect(caught.exitCode).toBe(2);
    expect(caught.message).toContain("soma doctor — errors detected");
  });
});

test("soma doctor --substrate claude-code reports a stale projection", async () => {
  await withTempHome(async (homeDir) => {
    // A real install first, so every OTHER rules/soma file matches a fresh
    // render — only the hand-corrupted CONTEXT.md below should read as drift.
    await installSomaForClaudeCode({ homeDir });
    await writeFile(
      join(homeDir, ".claude/rules/soma/CONTEXT.md"),
      withProvenance("claude-code", "# Soma Claude Code Context\n\nstale body — the Soma source moved on.\n"),
      "utf8",
    );

    const diagnosis = await diagnoseSomaDoctor({ homeDir, substrate: "claude-code" });

    expect(diagnosis.findings).toContainEqual({
      id: "claude-code-projection-stale",
      severity: "warning",
      message:
        "Claude Code projection file(s) are out of date — the Soma source changed since the last reproject: rules/soma/CONTEXT.md.",
      action: "soma reproject claude-code",
    });
  });
});

test("soma doctor --substrate claude-code is clean when the projection is current", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });

    const diagnosis = await diagnoseSomaDoctor({ homeDir, substrate: "claude-code" });

    // Scoped to claude-code-prefixed findings (not overall status): a fresh
    // claude-code install also projects its portable skills into the SHARED
    // `.claude/skills/` dir, which — unrelated to this doctor content-compare
    // check — the onboarding "claude skills not migrated" heuristic can flag
    // as an importable pre-existing Claude Code install (a pre-existing
    // detection quirk, out of scope for soma#370). What THIS test verifies is
    // that content-compare itself reports zero drift for a genuinely fresh,
    // untouched projection.
    const claudeFindings = diagnosis.findings.filter((finding) => finding.id.startsWith("claude-code-"));
    expect(claudeFindings).toEqual([]);
  });
});

test("soma doctor --substrate claude-code flags a settings.json that omits the Soma hook", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    // Overwrite the projected settings.json with vanilla Claude Code settings
    // that do NOT register the Soma hook — presence alone must not pass.
    await writeFile(join(homeDir, ".claude/settings.json"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`, "utf8");

    const diagnosis = await diagnoseSomaDoctor({ homeDir, substrate: "claude-code" });

    expect(diagnosis.findings).toContainEqual({
      id: "claude-code-settings-missing",
      severity: "warning",
      message: "Claude Code settings.json does not register the Soma hook.",
      action: "soma install claude-code --apply",
    });
    // The projection itself is current and the hook files exist, so the only
    // claude-code finding should be the unwired settings.
    const claudeIds = diagnosis.findings.filter((finding) => finding.id.startsWith("claude-code-")).map((finding) => finding.id);
    expect(claudeIds).toEqual(["claude-code-settings-missing"]);
  });
});

test("soma#370: soma doctor --substrate claude-code flags a hand-edited projection (missing provenance header)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    // Simulate a hand edit that dropped the provenance header.
    await writeFile(
      join(homeDir, ".claude/rules/soma/CONTEXT.md"),
      "# Soma Claude Code Context\n\nhand edited, no header\n",
      "utf8",
    );

    const diagnosis = await diagnoseSomaDoctor({ homeDir, substrate: "claude-code" });
    const claudeIds = diagnosis.findings.filter((finding) => finding.id.startsWith("claude-code-")).map((finding) => finding.id);
    expect(claudeIds).toContain("claude-code-projection-unmanaged-edit");
    expect(claudeIds).not.toContain("claude-code-projection-stale");
  });
});

test("soma#377: unmanaged-edit check covers non-CONTEXT skeleton files (e.g. SKILLS.md)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir }); // CONTEXT.md is header-managed
    // A hand-replaced SKILLS.md with no header must be caught even though
    // CONTEXT.md is healthy.
    await writeFile(join(homeDir, ".claude/rules/soma/SKILLS.md"), "# Skills\n\nhand replaced\n", "utf8");

    const diagnosis = await diagnoseSomaDoctor({ homeDir, substrate: "claude-code" });
    const unmanaged = diagnosis.findings.find((f) => f.id === "claude-code-projection-unmanaged-edit");
    expect(unmanaged).toBeDefined();
    expect(unmanaged?.message).toContain("SKILLS.md");
  });
});

// soma#370: content-compare drift is substrate-agnostic, so cursor and
// pi-dev — which had NO drift diagnosis at all before — are now doctor-
// supported, same as the grok oracle-check parity test above.
test("soma doctor --substrate cursor and pi-dev are no longer rejected as unsupported, and surface not-diagnosable on an unbootstrapped home", async () => {
  await withTempHome(async (homeDir) => {
    for (const substrate of ["cursor", "pi-dev"] as const) {
      // Empty temp home: never bootstrapped, so content-compare cannot build
      // a source projection to compare against. It must NOT fail open (a bare
      // "ok" that claims coverage it never performed) NOR hard-fail CI — it
      // surfaces an `info` not-diagnosable finding that keeps exit 0 while
      // saying plainly the substrate was not diagnosed (sage#450 r2).
      const diagnosis = await diagnoseSomaDoctor({ homeDir, substrate });
      expect(diagnosis.status).toBe("ok"); // info keeps exit 0, non-fatal
      const finding = diagnosis.findings.find((f) => f.id === `${substrate}-not-diagnosable`);
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe("info");

      // CLI resolves (proves "not rejected as unsupported") and the
      // not-diagnosable note is visible — never a bare, silent "ok".
      const output = await runSomaCli(["doctor", "--substrate", substrate, "--home-dir", homeDir]);
      expect(output).toContain(`${substrate}-not-diagnosable`);
      expect(output).toContain("Cannot diagnose");
    }
  });
});

test("DOCTOR_SUPPORTED_SUBSTRATES / isDoctorSubstrate still gate a genuinely unknown substrate", () => {
  // Every SomaOnboardingSubstrate (codex/pi-dev/claude-code/cursor/grok) is
  // now doctor-supported, so `--substrate` can no longer surface
  // DOCTOR_UNSUPPORTED_SUBSTRATE_MESSAGE through the CLI parser (it rejects
  // anthropic-cowork and any other bogus value earlier, with a different
  // message) — this pins the underlying guard directly so the rejection
  // path itself stays covered.
  expect(DOCTOR_SUPPORTED_SUBSTRATES).toEqual(["codex", "claude-code", "cursor", "grok", "pi-dev"]);
  expect(isDoctorSubstrate("anthropic-cowork")).toBe(false);
  expect(isDoctorSubstrate("bogus")).toBe(false);
});
