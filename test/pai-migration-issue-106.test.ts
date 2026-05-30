/**
 * Issue 106 — soma migrate pai: CLI surface for rename + collapse +
 * deprecated alias + footer suggestion.
 *
 * ACs covered here:
 *   - AC-1 (CLI): `--include-substrate-specific` accepted as deprecated
 *           alias; emits stderr warning; behaves identically to
 *           `--include-unrecognized`.
 *   - AC-3 (CLI): Plan output prints per-pack COUNTS, not inline file
 *           lists. Full lists only with `--verbose`.
 *   - AC-3 (manifest): Full per-pack file lists ALWAYS in MIGRATION.md.
 *   - AC-4: Footer suggestion line for unrecognized-layout / reserved.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-issue-106-mig-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeMinimalClaudeHome(claudeHome: string): Promise<void> {
  const userRoot = join(claudeHome, "PAI/USER");
  await mkdir(join(userRoot, "TELOS"), { recursive: true });
  await writeFile(
    join(userRoot, "PRINCIPAL_IDENTITY.md"),
    "# Principal\n\n- **Name:** Test User\n- **Pronunciation:** Test\n- **Location:** Nowhere\n- **Timezone:** UTC\n- **Role:** Tester\n- **Focus:** Testing\n",
    "utf8",
  );
  await writeFile(
    join(userRoot, "DA_IDENTITY.md"),
    "# DA Identity\n\n- **Full Name:** Bot\n- **Name:** Bot\n- **Display Name:** Bot\n- **Color:** #000\n- **Voice ID:** v\n- **Role:** assistant\n- **Operating Environment:** test\n",
    "utf8",
  );
  for (const file of ["MISSION.md", "GOALS.md", "STRATEGIES.md", "BELIEFS.md"]) {
    await writeFile(join(userRoot, "TELOS", file), `# ${file}\n\nFixture\n`, "utf8");
  }
}

async function writePackWithUnrecognizedFile(packDir: string, packName = "DemoUnrec"): Promise<void> {
  await mkdir(join(packDir, "src/Workflows"), { recursive: true });
  await mkdir(join(packDir, "src/Tools"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    [`---`, `name: ${packName}`, `description: Issue 106 mig fixture`, `---`, ``, `# ${packName}`, ``, "doc"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    [`---`, `name: ${packName}`, `description: orig`, `---`, ``, `# ${packName}`].join("\n"),
    "utf8",
  );
  // Plant unrecognized files.
  await writeFile(join(packDir, "src/Foundation.md"), "# Foundation\n", "utf8");
  await writeFile(join(packDir, "src/Extra.md"), "# Extra\n", "utf8");
}

async function writeCleanPack(packDir: string, packName: string): Promise<void> {
  await mkdir(join(packDir, "src/Workflows"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    [`---`, `name: ${packName}`, `description: clean`, `---`, ``, `# ${packName}`].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    [`---`, `name: ${packName}`, `description: orig`, `---`, ``, `# ${packName}`].join("\n"),
    "utf8",
  );
}

/**
 * Capture writes to process.stderr while a CLI invocation runs. The
 * deprecation warning lands on stderr (not on the CLI's returned
 * stdout-bound string).
 */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    const result = await fn();
    return { result, stderr: chunks.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

// ─── AC-1 (CLI): deprecated alias --include-substrate-specific ───────

test("AC-1: --include-substrate-specific is accepted as deprecated alias with stderr warning (migrate pai)", async () => {
  await withTempHome(async (homeDir) => {
    const claudeHome = join(homeDir, ".claude");
    const somaHome = join(homeDir, ".soma");
    await writeMinimalClaudeHome(claudeHome);
    const packsDir = join(homeDir, "PAI/Packs");
    await mkdir(packsDir, { recursive: true });
    await writePackWithUnrecognizedFile(join(packsDir, "DemoUnrec"));

    const { stderr } = await captureStderr(async () =>
      runSomaCli([
        "migrate",
        "pai",
        "--claude-home",
        claudeHome,
        "--soma-home",
        somaHome,
        "--pai-packs-dir",
        packsDir,
        "--include-substrate-specific",
      ]),
    );

    expect(stderr).toMatch(/--include-substrate-specific is deprecated; use --include-unrecognized/i);
  });
});

test("AC-1: --include-unrecognized produces NO deprecation warning", async () => {
  await withTempHome(async (homeDir) => {
    const claudeHome = join(homeDir, ".claude");
    const somaHome = join(homeDir, ".soma");
    await writeMinimalClaudeHome(claudeHome);
    const packsDir = join(homeDir, "PAI/Packs");
    await mkdir(packsDir, { recursive: true });
    await writePackWithUnrecognizedFile(join(packsDir, "DemoUnrec"));

    const { stderr } = await captureStderr(async () =>
      runSomaCli([
        "migrate",
        "pai",
        "--claude-home",
        claudeHome,
        "--soma-home",
        somaHome,
        "--pai-packs-dir",
        packsDir,
        "--include-unrecognized",
      ]),
    );

    expect(stderr).not.toMatch(/deprecated/i);
  });
});

test("AC-1: import pai-pack also accepts --include-substrate-specific as deprecated alias", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writePackWithUnrecognizedFile(packDir, "Demo");
    const somaHome = join(homeDir, ".soma");

    const { stderr } = await captureStderr(async () =>
      runSomaCli([
        "import",
        "pai-pack",
        "--apply",
        "--home-dir",
        homeDir,
        "--pai-pack-dir",
        packDir,
        "--soma-home",
        somaHome,
        "--include-substrate-specific",
      ]),
    );

    expect(stderr).toMatch(/--include-substrate-specific is deprecated; use --include-unrecognized/i);
  });
});

// ─── AC-3 (CLI): plan output collapses inline lists into counts ──────
//
// #109 — unrecognized files no longer refuse the pack. The collapsed
// count form and the verbose-file-list form are now only reachable in
// real life when an outdated SDK consumer throws
// `PaiPackUnrecognizedLayoutRefusal` themselves; the importer no longer
// does. We retain the rendering tests at the formatter level by
// constructing the outcome row directly (rather than through the
// importer pipeline that no longer produces it).

test("AC-3 (#109): packs with unrecognized files now plan as imported (partial-import)", async () => {
  await withTempHome(async (homeDir) => {
    const claudeHome = join(homeDir, ".claude");
    const somaHome = join(homeDir, ".soma");
    await writeMinimalClaudeHome(claudeHome);
    const packsDir = join(homeDir, "PAI/Packs");
    await mkdir(packsDir, { recursive: true });
    await writePackWithUnrecognizedFile(join(packsDir, "DemoUnrec"));

    const output = await runSomaCli([
      "migrate",
      "pai",
      "--dry-run",
      "--claude-home",
      claudeHome,
      "--soma-home",
      somaHome,
      "--pai-packs-dir",
      packsDir,
    ]);

    // Pack imports successfully; no refused-unrecognized-layout row.
    expect(output).toContain("imported");
    expect(output).not.toContain("refused-unrecognized-layout");
  });
});

test("AC-3 --verbose (#109): packs with unrecognized files plan as imported, verbose still works", async () => {
  await withTempHome(async (homeDir) => {
    const claudeHome = join(homeDir, ".claude");
    const somaHome = join(homeDir, ".soma");
    await writeMinimalClaudeHome(claudeHome);
    const packsDir = join(homeDir, "PAI/Packs");
    await mkdir(packsDir, { recursive: true });
    await writePackWithUnrecognizedFile(join(packsDir, "DemoUnrec"));

    const output = await runSomaCli([
      "migrate",
      "pai",
      "--dry-run",
      "--verbose",
      "--claude-home",
      claudeHome,
      "--soma-home",
      somaHome,
      "--pai-packs-dir",
      packsDir,
    ]);

    // Plan completes without throwing; pack is imported.
    expect(output).toContain("imported");
  });
});

// ─── AC-3 (manifest): full lists always in MIGRATION.md ─────────────

test("AC-3 manifest (#109): pack with unrecognized files imports; manifest records the import", async () => {
  await withTempHome(async (homeDir) => {
    const claudeHome = join(homeDir, ".claude");
    const somaHome = join(homeDir, ".soma");
    await writeMinimalClaudeHome(claudeHome);
    const packsDir = join(homeDir, "PAI/Packs");
    await mkdir(packsDir, { recursive: true });
    await writePackWithUnrecognizedFile(join(packsDir, "DemoUnrec"));

    await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--claude-home",
      claudeHome,
      "--soma-home",
      somaHome,
      "--pai-packs-dir",
      packsDir,
    ]);

    const manifest = await readFile(join(somaHome, "profile/imports/claude/MIGRATION.md"), "utf8");
    expect(manifest).toContain("imported");
  });
});

// ─── AC-4: footer suggestion lines ───────────────────────────────────

test("AC-4 (#109): footer no longer suggests --include-unrecognized when packs import cleanly", async () => {
  await withTempHome(async (homeDir) => {
    const claudeHome = join(homeDir, ".claude");
    const somaHome = join(homeDir, ".soma");
    await writeMinimalClaudeHome(claudeHome);
    const packsDir = join(homeDir, "PAI/Packs");
    await mkdir(packsDir, { recursive: true });
    await writePackWithUnrecognizedFile(join(packsDir, "DemoUnrec"));
    await writeCleanPack(join(packsDir, "Clean"), "Clean");

    const output = await runSomaCli([
      "migrate",
      "pai",
      "--dry-run",
      "--claude-home",
      claudeHome,
      "--soma-home",
      somaHome,
      "--pai-packs-dir",
      packsDir,
    ]);

    // Both packs imported; no footer suggestion since there are no
    // refused-unrecognized-layout rows.
    expect(output).toContain("imported");
    expect(output).not.toMatch(/refused-unrecognized-layout — re-run with --include-unrecognized/);
  });
});

test("AC-4: footer does NOT print suggestion when no unrecognized-layout outcomes", async () => {
  await withTempHome(async (homeDir) => {
    const claudeHome = join(homeDir, ".claude");
    const somaHome = join(homeDir, ".soma");
    await writeMinimalClaudeHome(claudeHome);
    const packsDir = join(homeDir, "PAI/Packs");
    await mkdir(packsDir, { recursive: true });
    await writeCleanPack(join(packsDir, "Clean"), "Clean");

    const output = await runSomaCli([
      "migrate",
      "pai",
      "--dry-run",
      "--claude-home",
      claudeHome,
      "--soma-home",
      somaHome,
      "--pai-packs-dir",
      packsDir,
    ]);

    expect(output).not.toMatch(/re-run with --include-unrecognized/);
  });
});
