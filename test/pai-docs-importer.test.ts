import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { importPaiDocs, planPaiDocsImport } from "../src/pai-docs-importer";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-pai-docs-import-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

interface PaiSourceFixtureOptions {
  versionFile?: string | null;
  releasePath?: string; // e.g. "Releases/v5.0.0/.claude/PAI"
}

async function writePaiSourceFixture(
  baseDir: string,
  options: PaiSourceFixtureOptions = {},
): Promise<string> {
  const releasePath = options.releasePath ?? "Releases/v5.0.0/.claude/PAI";
  const sourceDir = join(baseDir, releasePath);
  await mkdir(join(sourceDir, "DOCUMENTATION/Skills"), { recursive: true });
  await mkdir(join(sourceDir, "DOCUMENTATION/Memory"), { recursive: true });
  await mkdir(join(sourceDir, "TEMPLATES/User"), { recursive: true });
  await mkdir(join(sourceDir, "ALGORITHM"), { recursive: true });

  await writeFile(
    join(sourceDir, "DOCUMENTATION/Skills/SkillSystem.md"),
    "# Skill System\n\nPAI Skill subsystem reference.\n",
    "utf8",
  );
  await writeFile(
    join(sourceDir, "DOCUMENTATION/Memory/MemoryArchitecture.md"),
    "# Memory Architecture\n\nPAI memory layout.\n",
    "utf8",
  );
  await writeFile(
    join(sourceDir, "TEMPLATES/User/PRINCIPAL_IDENTITY.md"),
    "# Principal Identity Template\n",
    "utf8",
  );
  await writeFile(
    join(sourceDir, "ALGORITHM/v6.3.0.md"),
    "# Algorithm v6.3.0\n\nPhases.\n",
    "utf8",
  );
  await writeFile(
    join(sourceDir, "ALGORITHM/LATEST"),
    "v6.3.0\n",
    "utf8",
  );

  if (options.versionFile !== null) {
    if (options.versionFile !== undefined) {
      await writeFile(join(sourceDir, "VERSION"), options.versionFile, "utf8");
    }
  }

  // A few out-of-scope dirs alongside the in-scope ones — verifies we
  // don't pick up MEMORY/, USER/, PULSE/, TOOLS/, bin/, PAI-Install/,
  // statusline-command.sh, PAI_SYSTEM_PROMPT.md.
  await mkdir(join(sourceDir, "MEMORY/WORK"), { recursive: true });
  await writeFile(join(sourceDir, "MEMORY/WORK/note.md"), "out of scope\n", "utf8");
  await mkdir(join(sourceDir, "USER"), { recursive: true });
  await writeFile(join(sourceDir, "USER/PRINCIPAL_IDENTITY.md"), "user state\n", "utf8");
  await writeFile(join(sourceDir, "PAI_SYSTEM_PROMPT.md"), "system prompt\n", "utf8");
  await writeFile(join(sourceDir, "statusline-command.sh"), "#!/bin/sh\n", "utf8");

  return sourceDir;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

test("requires an explicit PAI source dir", async () => {
  await expect(planPaiDocsImport({ homeDir: "/tmp/soma-pai-docs-noop" })).rejects.toThrow(
    "requires --pai-source-dir",
  );
});

test("AC-3 — refuses sources without a DOCUMENTATION/ subdir", async () => {
  await withTempHome(async (homeDir) => {
    const bogus = join(homeDir, "not-pai");
    await mkdir(join(bogus, "TEMPLATES"), { recursive: true });
    await mkdir(join(bogus, "ALGORITHM"), { recursive: true });
    await expect(
      planPaiDocsImport({ homeDir, paiSourceDir: bogus }),
    ).rejects.toThrow(/does not look like a PAI release tree/i);
  });
});

test("AC-1 — dry-run plan lists files without writing", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);
    const plan = await planPaiDocsImport({ homeDir, paiSourceDir: sourceDir });

    expect(plan.apply).toBe(false);
    expect(plan.paiSourceDir).toBe(sourceDir);
    expect(plan.somaHome).toBe(join(homeDir, ".soma"));
    expect(plan.releaseVersion).toBe("v5.0.0");

    const targets = plan.files.map((file) => file.target);
    expect(targets).toContain(join(homeDir, ".soma/PAI/DOCUMENTATION/Skills/SkillSystem.md"));
    expect(targets).toContain(join(homeDir, ".soma/PAI/DOCUMENTATION/Memory/MemoryArchitecture.md"));
    expect(targets).toContain(join(homeDir, ".soma/PAI/TEMPLATES/User/PRINCIPAL_IDENTITY.md"));
    expect(targets).toContain(join(homeDir, ".soma/PAI/ALGORITHM/v6.3.0.md"));
    expect(targets).toContain(join(homeDir, ".soma/PAI/ALGORITHM/LATEST"));

    // Out-of-scope dirs do not appear.
    expect(targets.some((t) => t.includes("/MEMORY/"))).toBe(false);
    expect(targets.some((t) => t.includes("/USER/"))).toBe(false);
    expect(targets.some((t) => t.endsWith("PAI_SYSTEM_PROMPT.md"))).toBe(false);
    expect(targets.some((t) => t.endsWith("statusline-command.sh"))).toBe(false);

    // Dry-run does NOT read+hash every file — SHA is populated on
    // the apply path only (where it is needed for the manifest and
    // idempotency).
    for (const file of plan.files) {
      expect(file.sha256).toBeUndefined();
    }

    // Dry-run did not write the Soma home.
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();
  });
});

test("AC-2/AC-5 — apply writes files, manifest, and is idempotent on re-run", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);

    const result = await importPaiDocs({ homeDir, paiSourceDir: sourceDir });
    expect(result.applied).toBe(true);
    expect(result.releaseVersion).toBe("v5.0.0");

    const skillDoc = await readFile(
      join(homeDir, ".soma/PAI/DOCUMENTATION/Skills/SkillSystem.md"),
      "utf8",
    );
    expect(skillDoc).toContain("Skill System");
    const algo = await readFile(join(homeDir, ".soma/PAI/ALGORITHM/v6.3.0.md"), "utf8");
    expect(algo).toContain("Algorithm v6.3.0");

    // Manifest is recorded.
    const manifestPath = join(homeDir, ".soma/PAI/.import-manifest.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      schema: string;
      paiSourceDir: string;
      releaseVersion: string | null;
      importedAt: string;
      files: { target: string; source: string; sha256: string }[];
    };
    expect(manifest.schema).toBe("soma.pai-docs-import.v1");
    expect(manifest.paiSourceDir).toBe(sourceDir);
    expect(manifest.releaseVersion).toBe("v5.0.0");
    expect(typeof manifest.importedAt).toBe("string");
    expect(new Date(manifest.importedAt).toISOString()).toBe(manifest.importedAt);

    const skillEntry = manifest.files.find((f) => f.target === "DOCUMENTATION/Skills/SkillSystem.md");
    expect(skillEntry).toBeDefined();
    expect(skillEntry!.source).toBe("DOCUMENTATION/Skills/SkillSystem.md");
    expect(skillEntry!.sha256).toBe(sha256(skillDoc));

    // Idempotent: re-run with same source = no files rewritten.
    const second = await importPaiDocs({ homeDir, paiSourceDir: sourceDir });
    expect(second.applied).toBe(true);
    expect(second.unchanged).toBe(true);
    expect(second.writtenCount).toBe(0);
  });
});

test("refuses VERSION file that is itself a symlink", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir, { versionFile: null });
    // Plant a sensitive target outside the source tree, then symlink
    // VERSION at it. detectReleaseVersion must refuse rather than
    // copy its contents into the manifest.
    const sensitive = join(homeDir, "sensitive.txt");
    await writeFile(sensitive, "should-not-be-copied\n", "utf8");
    await symlink(sensitive, join(sourceDir, "VERSION"));

    await expect(
      planPaiDocsImport({ homeDir, paiSourceDir: sourceDir }),
    ).rejects.toThrow(/refused symlink path: VERSION/);
  });
});

test("accepts filenames that start with '..' as long as the realpath stays inside the source", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);
    // A legitimate file whose basename starts with `..` — the prior
    // `rel.startsWith("..")` filter silently dropped this.
    await writeFile(
      join(sourceDir, "DOCUMENTATION/..notes.md"),
      "# notes\nfile starts with dots\n",
      "utf8",
    );
    const plan = await planPaiDocsImport({ homeDir, paiSourceDir: sourceDir });
    const relPaths = plan.files.map((f) => f.relativePath);
    expect(relPaths).toContain("DOCUMENTATION/..notes.md");
  });
});

test("idempotency-skip refuses a target replaced by a symlink even when bytes match", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);
    const somaHome = join(homeDir, ".soma");
    const first = await importPaiDocs({ homeDir, paiSourceDir: sourceDir, somaHome });
    expect(first.writtenCount).toBeGreaterThan(0);

    // Replace one imported file with a symlink whose target contents
    // match the source bytes. Without a symlink check on the
    // idempotency-skip path, this would be silently accepted as
    // "unchanged".
    const target = join(somaHome, "PAI/DOCUMENTATION/Skills/SkillSystem.md");
    const masquerade = join(homeDir, "masquerade.md");
    const sourceBytes = await readFile(join(sourceDir, "DOCUMENTATION/Skills/SkillSystem.md"), "utf8");
    await writeFile(masquerade, sourceBytes, "utf8");
    await rm(target);
    await symlink(masquerade, target);

    await expect(
      importPaiDocs({ homeDir, paiSourceDir: sourceDir, somaHome }),
    ).rejects.toThrow(/refused.*symlink/i);
  });
});

test("AC-2 — idempotency repairs target drift even when source SHA is unchanged", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);

    const first = await importPaiDocs({ homeDir, paiSourceDir: sourceDir });
    expect(first.writtenCount).toBeGreaterThan(0);

    // User edits the imported file (or it is corrupted). With the
    // source unchanged, the importer must re-copy rather than trust
    // the manifest and leave the target stale.
    const target = join(homeDir, ".soma/PAI/DOCUMENTATION/Skills/SkillSystem.md");
    await writeFile(target, "TAMPERED — should be repaired on next import\n", "utf8");

    const second = await importPaiDocs({ homeDir, paiSourceDir: sourceDir });
    expect(second.writtenCount).toBe(1);

    const repaired = await readFile(target, "utf8");
    expect(repaired).toContain("Skill System");
    expect(repaired).not.toContain("TAMPERED");
  });
});

test("AC-5 — VERSION file overrides release version inferred from path", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir, { versionFile: "5.0.1\n" });
    const plan = await planPaiDocsImport({ homeDir, paiSourceDir: sourceDir });
    expect(plan.releaseVersion).toBe("5.0.1");
  });
});

test("AC-5 — release version is null when neither VERSION file nor path hint exists", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir, {
      versionFile: null,
      releasePath: "custom/PAI",
    });
    const plan = await planPaiDocsImport({ homeDir, paiSourceDir: sourceDir });
    expect(plan.releaseVersion).toBeNull();
  });
});

test("AC-4 — refuses symlink inside the source tree (escape rejection)", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);
    // Plant a symlink inside the in-scope DOCUMENTATION/ that points outside the tree.
    const outsideTarget = join(homeDir, "outside-target.md");
    await writeFile(outsideTarget, "ESCAPE\n", "utf8");
    await symlink(outsideTarget, join(sourceDir, "DOCUMENTATION/escape.md"));

    await expect(
      planPaiDocsImport({ homeDir, paiSourceDir: sourceDir }),
    ).rejects.toThrow(/refused symlink/i);
  });
});

test("AC-4 — refuses optional subtree root that is itself a symlink", async () => {
  // Source-side trust boundary: collectFiles lstat-checks every child
  // entry but never its own root. Without the per-subdir guard, a PAI
  // source tree with TEMPLATES/ or ALGORITHM/ planted as a symlink
  // would be followed and imported. Verify the guard at the subtree
  // boundary refuses each in-scope subdir when it is a symlink.
  for (const planted of ["TEMPLATES", "ALGORITHM"]) {
    await withTempHome(async (homeDir) => {
      const sourceDir = await writePaiSourceFixture(homeDir);
      // Remove the real dir and replace with a symlink to a separate
      // tree the source dir does not own.
      await rm(join(sourceDir, planted), { recursive: true });
      const elsewhere = join(homeDir, `${planted}-elsewhere`);
      await mkdir(elsewhere, { recursive: true });
      await writeFile(join(elsewhere, "smuggled.md"), "should not be imported\n", "utf8");
      await symlink(elsewhere, join(sourceDir, planted));

      await expect(
        planPaiDocsImport({ homeDir, paiSourceDir: sourceDir }),
      ).rejects.toThrow(new RegExp(`refused symlink path: ${planted}/`));
    });
  }
});

test("AC-3 — refuses required DOCUMENTATION subdir that is itself a symlink", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);
    await rm(join(sourceDir, "DOCUMENTATION"), { recursive: true });
    const elsewhere = join(homeDir, "doc-elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(sourceDir, "DOCUMENTATION"));

    await expect(
      planPaiDocsImport({ homeDir, paiSourceDir: sourceDir }),
    ).rejects.toThrow(/refused symlink path: DOCUMENTATION\/?/);
  });
});

test("AC-4 — refuses to overwrite a pre-existing symlink at the final target path", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);
    const somaHome = join(homeDir, ".soma");
    // Pre-create the full target tree, then plant a symlink at one
    // of the expected output files. All parent-side realpath checks
    // would otherwise pass; the importer must refuse the write
    // because the final entry itself is a symlink.
    await mkdir(join(somaHome, "PAI/DOCUMENTATION/Skills"), { recursive: true });
    const outside = join(homeDir, "outside.md");
    await writeFile(outside, "OUTSIDE — must not be overwritten\n", "utf8");
    await symlink(outside, join(somaHome, "PAI/DOCUMENTATION/Skills/SkillSystem.md"));

    await expect(
      importPaiDocs({ homeDir, paiSourceDir: sourceDir, somaHome }),
    ).rejects.toThrow(/refused.*symlink/i);

    // The outside file must still hold its original bytes — no
    // overwrite through the symlink occurred.
    const after = await readFile(outside, "utf8");
    expect(after).toContain("OUTSIDE — must not be overwritten");
  });
});

test("refuses a dangling optional subtree symlink (no silent skip)", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);
    // Plant a dangling symlink at TEMPLATES. `pathExists` (which
    // uses `access`) reports it as absent because it follows the
    // link; lstat reveals it.
    await rm(join(sourceDir, "TEMPLATES"), { recursive: true });
    await symlink(join(homeDir, "does-not-exist"), join(sourceDir, "TEMPLATES"));

    await expect(
      planPaiDocsImport({ homeDir, paiSourceDir: sourceDir }),
    ).rejects.toThrow(/refused symlink path: TEMPLATES\/?/);
  });
});

test("AC-4 — refuses target escape via existing symlink inside Soma home, before any mkdir or write", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);
    // Set up a real soma home, then plant an existing symlink at one
    // of the target subtree paths. The importer must refuse the
    // entire run before creating any subdirectories under the escape
    // target — not merely refuse the final write.
    const realSoma = join(homeDir, "real-soma");
    await mkdir(join(realSoma, "PAI"), { recursive: true });
    const escape = join(homeDir, "escape-root");
    await mkdir(escape, { recursive: true });
    await symlink(escape, join(realSoma, "PAI/DOCUMENTATION"));

    await expect(
      importPaiDocs({ homeDir, paiSourceDir: sourceDir, somaHome: realSoma }),
    ).rejects.toThrow(/refused to follow a symlink that escapes/i);

    // The escape root must remain empty — no files OR directories
    // were created through the symlink.
    await expect(
      stat(join(escape, "Skills/SkillSystem.md")),
    ).rejects.toThrow();
    await expect(stat(join(escape, "Skills"))).rejects.toThrow();
    await expect(stat(join(escape, "Memory"))).rejects.toThrow();
  });
});

test("AC-1/AC-2 — CLI dispatches dry-run by default and --apply writes", async () => {
  await withTempHome(async (homeDir) => {
    const sourceDir = await writePaiSourceFixture(homeDir);
    const somaHome = join(homeDir, ".soma");

    const planOut = await runSomaCli([
      "import",
      "pai-docs",
      "--pai-source-dir",
      sourceDir,
      "--home-dir",
      homeDir,
      "--soma-home",
      somaHome,
    ]);
    expect(planOut).toContain("Soma PAI docs import plan");
    expect(planOut).toContain("mode: dry-run");
    expect(planOut).toContain("DOCUMENTATION/Skills/SkillSystem.md");
    await expect(stat(somaHome)).rejects.toThrow();

    const applyOut = await runSomaCli([
      "import",
      "pai-docs",
      "--pai-source-dir",
      sourceDir,
      "--home-dir",
      homeDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    expect(applyOut).toContain("Soma PAI docs import applied");
    expect(applyOut).toContain("releaseVersion: v5.0.0");
    await expect(stat(join(somaHome, "PAI/DOCUMENTATION/Skills/SkillSystem.md"))).resolves.toMatchObject({});
    await expect(stat(join(somaHome, "PAI/.import-manifest.json"))).resolves.toMatchObject({});
  });
});

test("CLI rejects unknown options for pai-docs source", async () => {
  await expect(
    runSomaCli(["import", "pai-docs", "--skill-name", "anything"]),
  ).rejects.toThrow(/--skill-name is only valid/);
});
