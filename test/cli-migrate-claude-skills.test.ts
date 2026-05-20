/**
 * #115 — `soma migrate claude-skills` CLI surface tests.
 *
 * Validates dry-run / --apply / --status / --include-claude-specific
 * and unknown-flag behavior against a synthetic flat skills tree.
 *
 * Mirrors `cli-migrate.test.ts` (the PAI path) so the two surfaces
 * stay in formatter parity — same totals line, same per-row shape,
 * same --status empty-state hint.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-cli-115-");

// #120 — substrate-cap-aware fixtures. Every SKILL.md body is prepended
// with a minimal valid frontmatter so the description-limit classifier
// classifies these as `ok` and the existing CLI tests continue to
// exercise the original totals + dispositions.
const FM = "---\nname: TestSkill\ndescription: \"short test description\"\n---\n\n";

async function writeFixture(home: string): Promise<string> {
  const fromDir = join(home, "skills");
  await mkdir(join(fromDir, "Portable"), { recursive: true });
  await writeFile(
    join(fromDir, "Portable", "SKILL.md"),
    FM + "# Portable\n\nclean.\n",
    "utf8",
  );
  await mkdir(join(fromDir, "NeedsAdapt"), { recursive: true });
  await writeFile(
    join(fromDir, "NeedsAdapt", "SKILL.md"),
    FM + "# NeedsAdapt\n\nsee ~/.claude/PAI/DOCUMENTATION/X.md\n",
    "utf8",
  );
  await mkdir(join(fromDir, "ClaudeSpecific"), { recursive: true });
  await writeFile(
    join(fromDir, "ClaudeSpecific", "SKILL.md"),
    FM + "# ClaudeSpecific\n\nStop: cleanup hook\n",
    "utf8",
  );
  return fromDir;
}

test("soma migrate claude-skills --from <dir> → plan", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      join(home, "soma"),
    ]);
    expect(output).toContain("plan (dry-run");
    // #124 — grouped output by disposition
    expect(output).toContain("### Imported (2)");
    expect(output).toContain("Portable (1):");
    expect(output).toContain("  - portable");
    expect(output).toContain("Needs-adapt (1):");
    expect(output).toContain("  - needs-adapt (1 refs)");
    expect(output).toContain("### Skipped — claude-specific (1)");
    expect(output).toContain("  - claude-specific");
    expect(output).toContain("Totals: 2 imported, 0 skipped-idempotent, 1 skipped-claude-specific");
    // No writes — soma home shouldn't have a manifest yet.
    await expect(
      stat(join(home, "soma/imports/claude-skills/.manifest.json")),
    ).rejects.toThrow();
  });
});

test("soma migrate claude-skills --apply writes manifest + report + payloads", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    expect(output).toContain("applied");
    expect(output).toContain("Totals: 2 written, 0 skipped-idempotent, 1 skipped-claude-specific");
    await stat(join(somaHome, "imports/claude-skills/.manifest.json"));
    await stat(join(somaHome, "imports/claude-skills/.portability-report.md"));
    await stat(join(somaHome, "skills/portable/SKILL.md"));
    await stat(join(somaHome, "skills/needs-adapt/SKILL.md"));
    // claude-specific must NOT have landed.
    await expect(
      stat(join(somaHome, "skills/claude-specific/SKILL.md")),
    ).rejects.toThrow();
  });
});

test("soma migrate claude-skills --apply --include-claude-specific lands the skipped set", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
      "--include-claude-specific",
    ]);
    expect(output).toContain("Totals: 3 written, 0 skipped-idempotent, 0 skipped-claude-specific");
    await stat(join(somaHome, "skills/claude-specific/SKILL.md"));
    // Report carries the override.
    const report = await readFile(
      join(somaHome, "imports/claude-skills/.portability-report.md"),
      "utf8",
    );
    expect(report).toContain("Include claude-specific: yes");
  });
});

test("soma migrate claude-skills --status (no prior apply) reports absence", async () => {
  await withTempHome(async (home) => {
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--status",
      "--soma-home",
      join(home, "soma"),
    ]);
    expect(output).toContain("no migration manifest found");
  });
});

test("soma migrate claude-skills --status (after apply) prints summary", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    const status = await runSomaCli([
      "migrate",
      "claude-skills",
      "--status",
      "--soma-home",
      somaHome,
    ]);
    expect(status).toContain("soma migrate claude-skills — status");
    expect(status).toContain("portable [portable]");
    expect(status).toContain("needs-adapt [needs-adapt]");
  });
});

test("soma migrate claude-skills --status shows refused outcomes from the latest apply", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    await mkdir(join(fromDir, "EmbeddedGit", ".git"), { recursive: true });
    await writeFile(
      join(fromDir, "EmbeddedGit", "SKILL.md"),
      FM + "# EmbeddedGit\n\ncontains vcs metadata.\n",
      "utf8",
    );
    const somaHome = join(home, "soma");

    await expect(
      runSomaCli([
        "migrate",
        "claude-skills",
        "--from",
        fromDir,
        "--soma-home",
        somaHome,
        "--apply",
      ]),
    ).rejects.toThrow(/EmbeddedGit/);

    const status = await runSomaCli([
      "migrate",
      "claude-skills",
      "--status",
      "--soma-home",
      somaHome,
    ]);
    expect(status).toContain("latest outcomes:");
    expect(status).toContain("refused-other: 1");
    expect(status).toContain("embedded-git [refused-other]");
    expect(status).toContain("remove or move embedded VCS metadata");
    expect(status).toContain("claude-specific [skipped-claude-specific]");
  });
});

test("soma migrate claude-skills --help surfaces usage", async () => {
  const output = await runSomaCli(["migrate", "claude-skills", "--help"]);
  expect(output).toContain("Usage: soma migrate claude-skills");
  expect(output).toContain("[--verbose]");
});

// #125 — progress + timing + --quiet.

test("soma migrate claude-skills --apply stdout summary contains Timing block", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    // The Timing block lands on stdout (returned by runSomaCli),
    // BELOW the existing totals line. Stable shape regardless of
    // whether stderr progress is on or off.
    expect(output).toContain("Timing:");
    expect(output).toContain("total");
    expect(output).toContain("read + classify");
    expect(output).toContain("apply write");
    expect(output).toContain("description rewrites");
    // Smoke not requested → (not requested) tag.
    expect(output).toContain("smoke verify: (not requested)");
  });
});

test("soma migrate claude-skills --apply --quiet still emits Timing block on stdout", async () => {
  // --quiet only suppresses stderr progress (per AC-3). The Timing
  // block belongs to the stdout summary and stays.
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
      "--quiet",
    ]);
    expect(output).toContain("Timing:");
    // The totals line is still byte-stable so existing parsers work.
    expect(output).toContain("Totals: 2 written, 0 skipped-idempotent, 1 skipped-claude-specific");
  });
});

test("soma migrate claude-skills --apply plan mode also returns a stdout summary unchanged", async () => {
  // Plan mode returns its formatted plan string. Confirms stdout
  // stays byte-stable for the totals/grouping lines.
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
    ]);
    // Plan mode (#124 grouped output) — no Timing block by design
    // (plan-mode is read-only; no apply work to time).
    expect(output).toContain("Totals: 2 imported, 0 skipped-idempotent, 1 skipped-claude-specific");
    expect(output).not.toContain("Timing:");
  });
});

test("soma migrate claude-skills --apply --quiet --unknown-flag still rejects", async () => {
  // --quiet doesn't change the parser's strict mode.
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    await expect(
      runSomaCli([
        "migrate",
        "claude-skills",
        "--from",
        fromDir,
        "--soma-home",
        join(home, "soma"),
        "--apply",
        "--quiet",
        "--bogus-flag",
      ]),
    ).rejects.toThrow(/Unknown option: --bogus-flag/);
  });
});

test("soma migrate claude-skills --apply --unknown-flag errors", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    await expect(
      runSomaCli([
        "migrate",
        "claude-skills",
        "--from",
        fromDir,
        "--apply",
        "--bogus",
        "--soma-home",
        join(home, "soma"),
      ]),
    ).rejects.toThrow("Unknown option");
  });
});

test("soma migrate claude-skills (no --from on plan) errors with usage", async () => {
  await expect(runSomaCli(["migrate", "claude-skills"])).rejects.toThrow();
});

test("soma migrate claude-skills --apply is idempotent", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const first = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    expect(first).toContain("Totals: 2 written, 0 skipped-idempotent");
    const second = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    expect(second).toContain("Totals: 0 written, 2 skipped-idempotent");
  });
});

// #115 Phase 2 — `--smoke <substrate>` CLI surface tests.
test("soma migrate claude-skills --apply --smoke codex prints per-substrate summary", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
      "--smoke",
      "codex",
    ]);
    expect(output).toContain("smoke-substrates: codex");
    expect(output).toContain("Smoke codex:");
    // Both imported skills survive the static-shape check on a
    // clean fixture; the needs-adapt skill leaves a ~/.soma/UNMAPPED
    // ref behind which trips the dangling-warning rule, so totals
    // include warnings.
  });
});

test("soma migrate claude-skills --apply --smoke pi-dev surfaces totals", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
      "--smoke",
      "pi-dev",
    ]);
    expect(output).toContain("smoke-substrates: pi-dev");
    expect(output).toContain("Smoke pi-dev:");
  });
});

test("soma migrate claude-skills --apply --smoke codex --smoke pi-dev surfaces both", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
      "--smoke",
      "codex",
      "--smoke",
      "pi-dev",
    ]);
    expect(output).toContain("smoke-substrates: codex, pi-dev");
    expect(output).toContain("Smoke codex:");
    expect(output).toContain("Smoke pi-dev:");
  });
});

test("soma migrate claude-skills --smoke all expands to codex + pi-dev", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
      "--smoke",
      "all",
    ]);
    expect(output).toContain("smoke-substrates: codex, pi-dev");
    expect(output).toContain("Smoke codex:");
    expect(output).toContain("Smoke pi-dev:");
  });
});

test("soma migrate claude-skills --smoke unknown substrate rejects loud", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    await expect(
      runSomaCli([
        "migrate",
        "claude-skills",
        "--from",
        fromDir,
        "--soma-home",
        join(home, "soma"),
        "--apply",
        "--smoke",
        "claude-code",
      ]),
    ).rejects.toThrow(/Unknown --smoke substrate/);
  });
});

test("soma migrate claude-skills --smoke (no value) errors with readOption", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    await expect(
      runSomaCli([
        "migrate",
        "claude-skills",
        "--from",
        fromDir,
        "--soma-home",
        join(home, "soma"),
        "--apply",
        "--smoke",
      ]),
    ).rejects.toThrow();
  });
});

test("soma migrate claude-skills --smoke codex without --apply runs plan with smoke set", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--smoke",
      "codex",
    ]);
    expect(output).toContain("plan (dry-run");
    expect(output).toContain("smoke-substrates: codex");
  });
});

test("soma migrate claude-skills --help surfaces --smoke", async () => {
  const output = await runSomaCli(["migrate", "claude-skills", "--help"]);
  expect(output).toContain("--smoke");
});

// ---------------------------------------------------------------------
// #120 — --rewrite-descriptions LLM rewrite CLI surface.
// ---------------------------------------------------------------------

// Build a fixture with one oversize-description skill so the
// --rewrite-descriptions flag has something to compress. The skill
// content is fixed-length filler so the test stays deterministic.
async function writeOversizeFixture(home: string): Promise<string> {
  const fromDir = join(home, "skills");
  await mkdir(join(fromDir, "OversizeSkill"), { recursive: true });
  // 1200-char description (> 1024 substrate cap; triggers
  // refused-description-limit without the flag).
  const desc = "USE WHEN test " + "x".repeat(1186);
  await writeFile(
    join(fromDir, "OversizeSkill", "SKILL.md"),
    `---\nname: OversizeSkill\ndescription: "${desc}"\n---\n\n# OversizeSkill\n\nbody.\n`,
    "utf8",
  );
  return fromDir;
}

test("soma migrate claude-skills --rewrite-descriptions: unknown agent → error", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    await expect(
      runSomaCli([
        "migrate",
        "claude-skills",
        "--from",
        fromDir,
        "--soma-home",
        join(home, "soma"),
        "--rewrite-descriptions",
        "bogus-agent",
      ]),
    ).rejects.toThrow(/Unknown --rewrite-descriptions agent/);
  });
});

test("soma migrate claude-skills --rewrite-descriptions accepts claude|codex|pi|none", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    for (const agent of ["claude", "codex", "pi", "none"]) {
      // We only validate parser-acceptance here; the apply path with
      // each agent is exercised in the migrator integration tests with
      // a stubbed dispatcher. `claude`/`codex`/`pi` would invoke real
      // subprocesses in dry-run only too, but `plan` mode doesn't run
      // the dispatcher — it just classifies outcomes.
      const output = await runSomaCli([
        "migrate",
        "claude-skills",
        "--from",
        fromDir,
        "--soma-home",
        join(home, "soma"),
        "--rewrite-descriptions",
        agent,
      ]);
      expect(output).toContain("plan (dry-run");
      if (agent !== "none") {
        expect(output).toContain(`rewrite-descriptions: ${agent}`);
      } else {
        // `none` is the default → no header line emitted.
        expect(output).not.toContain("rewrite-descriptions: ");
      }
    }
  });
});

test("soma migrate claude-skills --rewrite-descriptions (no value) errors with readOption", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    await expect(
      runSomaCli([
        "migrate",
        "claude-skills",
        "--from",
        fromDir,
        "--soma-home",
        join(home, "soma"),
        "--rewrite-descriptions",
      ]),
    ).rejects.toThrow();
  });
});

test("soma migrate claude-skills plan with oversize + no agent → refused-description-limit + footer suggestion", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeOversizeFixture(home);
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      join(home, "soma"),
    ]);
    expect(output).toContain("refused-description-limit");
    expect(output).toContain("--rewrite-descriptions claude");
  });
});

test("soma migrate claude-skills --help surfaces --rewrite-descriptions", async () => {
  const output = await runSomaCli(["migrate", "claude-skills", "--help"]);
  expect(output).toContain("--rewrite-descriptions");
});

// ---------------------------------------------------------------------
// #124 — Grouped disposition output tests.
// ---------------------------------------------------------------------

async function writeMixedFixture(home: string): Promise<string> {
  const fromDir = join(home, "skills");
  // Portable
  await mkdir(join(fromDir, "AlphaPortable"), { recursive: true });
  await writeFile(
    join(fromDir, "AlphaPortable", "SKILL.md"),
    FM + "# AlphaPortable\n\nclean.\n",
    "utf8",
  );
  await mkdir(join(fromDir, "BetaPortable"), { recursive: true });
  await writeFile(
    join(fromDir, "BetaPortable", "SKILL.md"),
    FM + "# BetaPortable\n\nclean.\n",
    "utf8",
  );
  // Needs-adapt
  await mkdir(join(fromDir, "GammaAdapt"), { recursive: true });
  await writeFile(
    join(fromDir, "GammaAdapt", "SKILL.md"),
    FM + "# GammaAdapt\n\nsee ~/.claude/PAI/X.md and ~/.claude/PAI/Y.md\n",
    "utf8",
  );
  // Claude-specific — hook binding
  await mkdir(join(fromDir, "DeltaHook"), { recursive: true });
  await writeFile(
    join(fromDir, "DeltaHook", "SKILL.md"),
    FM + "# DeltaHook\n\nStop: cleanup hook\n",
    "utf8",
  );
  // Claude-specific — slash-command
  await mkdir(join(fromDir, "EpsilonSlash"), { recursive: true });
  await writeFile(
    join(fromDir, "EpsilonSlash", "SKILL.md"),
    FM + "# EpsilonSlash\n\nuse /plan to design\n",
    "utf8",
  );
  // Oversize description (refused-description-limit)
  const desc = "USE WHEN test " + "x".repeat(1186);
  await mkdir(join(fromDir, "ZetaOversize"), { recursive: true });
  await writeFile(
    join(fromDir, "ZetaOversize", "SKILL.md"),
    `---\nname: ZetaOversize\ndescription: "${desc}"\n---\n\n# ZetaOversize\n\nbody.\n`,
    "utf8",
  );
  return fromDir;
}

test("#124: plan output groups by disposition with correct section headers", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeMixedFixture(home);
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      join(home, "soma"),
    ]);
    // Imported group with sub-groups
    expect(output).toContain("### Imported (3)");
    expect(output).toContain("Portable (2):");
    expect(output).toContain("  - alpha-portable");
    expect(output).toContain("  - beta-portable");
    expect(output).toContain("Needs-adapt (1):");
    expect(output).toContain("  - gamma-adapt (2 refs)");

    // Claude-specific group with sub-groups
    expect(output).toContain("### Skipped — claude-specific (2)");
    expect(output).toContain("Slash-command refs (1):");
    expect(output).toContain("  - epsilon-slash");
    expect(output).toContain("Hook bindings (1):");
    expect(output).toContain("  - delta-hook");

    // Refused group
    expect(output).toContain("### Refused — description-limit (1)");
    expect(output).toContain("  - zeta-oversize");

    // Empty groups omitted
    expect(output).not.toContain("### Skipped — idempotent");
    expect(output).not.toContain("### Refused — other");

    // Totals line preserved
    expect(output).toContain("Totals: 3 imported");
    expect(output).toContain("2 skipped-claude-specific");
    expect(output).toContain("1 refused-description-limit");

    // Footer suggestion preserved
    expect(output).toContain("--include-claude-specific");
    expect(output).toContain("--rewrite-descriptions claude");
  });
});

test("#124: apply output groups by disposition", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeMixedFixture(home);
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      join(home, "soma"),
      "--apply",
    ]);
    expect(output).toContain("### Imported (3)");
    expect(output).toContain("Portable (2):");
    expect(output).toContain("Needs-adapt (1):");
    expect(output).toContain("### Skipped — claude-specific (2)");
    expect(output).toContain("Totals: 3 written");
  });
});

test("#124: idempotent re-run shows Skipped — idempotent group", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    const second = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    expect(second).toContain("### Skipped — idempotent (2)");
    expect(second).toContain("  - portable");
    expect(second).toContain("  - needs-adapt");
    expect(second).not.toContain("### Imported");
  });
});
