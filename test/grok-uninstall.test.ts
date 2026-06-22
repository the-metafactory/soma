import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapSomaHome, installSomaForGrok, uninstallSomaForGrok, projectGrok } from "../src/index";
import { GROK_INSTALL_MANIFEST_SCHEMA, grokInstallManifestPath } from "../src/adapters/grok/install-manifest";
import {
  GROK_AGENTS_BLOCK_BEGIN,
  GROK_AGENTS_BLOCK_END,
  GROK_CONFIG_BLOCK_BEGIN,
  GROK_CONFIG_BLOCK_END,
  configureGrokConfigPatch,
  removeConfigPatchBlock,
} from "../src/adapters/grok/config-patch";
import { writeProjection } from "../src/projection";
import { runSomaCli } from "../src/cli";
import { portableProjectionInput } from "./fixtures";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const pathGone = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
};

const normalize = (path: string) => path.replace(/\\/g, "/");

test("grok uninstall round-trips a real install", async () => {
  await withTempDir("soma-grok-uninstall-", async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const grokHome = join(homeDir, ".grok");

    const result = await uninstallSomaForGrok({ homeDir });

    const removed = result.removed.map(normalize);
    for (const expected of [
      "skills/soma",
      "skills/the-algorithm",
      "skills/ISA",
      "AGENTS.md",
      "config.toml",
      "hooks/soma-lifecycle.json",
      "hooks/soma-lifecycle.mjs",
      "hooks/soma-lifecycle.config.json",
      "hooks/grok-hook-entry.mjs",
      "hooks/shell-policy-core.mjs",
      "hooks/soma-feedback-capture.mjs",
      // native subagent surfaces (shared dirs, marker-guarded files).
      "personas/soma.toml",
      "roles/soma-algorithm.toml",
      "agents/soma-explore.md",
    ]) {
      expect(removed).toContain(normalize(join(grokHome, expected)));
    }
    for (const path of [
      "skills/soma",
      "skills/the-algorithm",
      "skills/ISA",
      "hooks/soma-lifecycle.json",
      "hooks/soma-lifecycle.mjs",
      "hooks/shell-policy-core.mjs",
      "personas/soma.toml",
      "roles/soma-algorithm.toml",
      "agents/soma-explore.md",
    ]) {
      expect(await pathGone(join(grokHome, path))).toBe(true);
    }
    // Install created AGENTS.md/config.toml with only the Soma block, so
    // unpatching leaves nothing to preserve and removes the files.
    expect(await pathGone(join(grokHome, "AGENTS.md"))).toBe(true);
    expect(await pathGone(join(grokHome, "config.toml"))).toBe(true);
  });
});

test("grok uninstall preserves foreign content and user-authored skills", async () => {
  await withTempDir("soma-grok-uninstall-foreign-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    await mkdir(join(grokHome, "skills", "mine"), { recursive: true });
    await writeFile(join(grokHome, "skills", "mine", "SKILL.md"), "---\nname: mine\n---\n\nUser-owned.\n", "utf8");
    await writeFile(join(grokHome, "AGENTS.md"), "# My Grok rules\n\nKeep responses terse.\n", "utf8");
    await writeFile(join(grokHome, "config.toml"), '[ui]\ntheme = "dark"\n', "utf8");
    // A user hook in the shared hooks/ dir must survive — only
    // the marker-guarded Soma hook files are removed, never the directory.
    await mkdir(join(grokHome, "hooks"), { recursive: true });
    await writeFile(join(grokHome, "hooks", "my-hook.json"), '{"hooks":{}}\n', "utf8");

    await installSomaForGrok({ homeDir });
    await uninstallSomaForGrok({ homeDir });

    // Foreign bytes survive; only the Soma blocks are excised.
    const agents = await readFile(join(grokHome, "AGENTS.md"), "utf8");
    expect(agents).toContain("# My Grok rules");
    expect(agents).toContain("Keep responses terse.");
    expect(agents).not.toContain(GROK_AGENTS_BLOCK_BEGIN);
    expect(agents).not.toContain(GROK_AGENTS_BLOCK_END);

    const config = await readFile(join(grokHome, "config.toml"), "utf8");
    expect(config).toContain('theme = "dark"');
    expect(config).not.toContain(GROK_CONFIG_BLOCK_BEGIN);
    expect(config).not.toContain(GROK_CONFIG_BLOCK_END);

    expect(await readFile(join(grokHome, "skills", "mine", "SKILL.md"), "utf8")).toContain("User-owned.");
    expect(await readFile(join(grokHome, "hooks", "my-hook.json"), "utf8")).toBe('{"hooks":{}}\n');
    expect(await pathGone(join(grokHome, "hooks", "soma-lifecycle.json"))).toBe(true);
  });
});

test("grok uninstall leaves a user directory that merely shares a Soma name", async () => {
  await withTempDir("soma-grok-uninstall-shared-name-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    // User-authored dirs named like Soma's, with no Soma markers.
    for (const name of ["soma", "the-algorithm", "ISA"]) {
      await mkdir(join(grokHome, "skills", name), { recursive: true });
      await writeFile(join(grokHome, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n\nHand-written.\n`, "utf8");
    }
    // User hook files that merely share the Soma names, without markers.
    await mkdir(join(grokHome, "hooks"), { recursive: true });
    await writeFile(join(grokHome, "hooks", "soma-lifecycle.json"), '{"hooks":{"Stop":[]}}\n', "utf8");
    await writeFile(join(grokHome, "hooks", "grok-hook-entry.mjs"), "// hand-written\n", "utf8");
    // user persona/role/agent files sharing Soma names, no markers.
    await mkdir(join(grokHome, "personas"), { recursive: true });
    await writeFile(join(grokHome, "personas", "soma.toml"), 'description = "mine"\n', "utf8");
    await mkdir(join(grokHome, "roles"), { recursive: true });
    await writeFile(join(grokHome, "roles", "soma-algorithm.toml"), 'description = "mine"\n', "utf8");
    await mkdir(join(grokHome, "agents"), { recursive: true });
    await writeFile(join(grokHome, "agents", "soma-explore.md"), "---\nname: soma-explore\n---\n\nMine.\n", "utf8");

    const result = await uninstallSomaForGrok({ homeDir });

    expect(result.removed).toEqual([]);
    for (const name of ["soma", "the-algorithm", "ISA"]) {
      expect(await readFile(join(grokHome, "skills", name, "SKILL.md"), "utf8")).toContain("Hand-written.");
    }
    expect(await readFile(join(grokHome, "hooks", "soma-lifecycle.json"), "utf8")).toContain('"Stop"');
    expect(await readFile(join(grokHome, "hooks", "grok-hook-entry.mjs"), "utf8")).toContain("hand-written");
    // The unmarked subagent files survive (marker-guarded removal).
    expect(await readFile(join(grokHome, "personas", "soma.toml"), "utf8")).toContain('"mine"');
    expect(await readFile(join(grokHome, "roles", "soma-algorithm.toml"), "utf8")).toContain('"mine"');
    expect(await readFile(join(grokHome, "agents", "soma-explore.md"), "utf8")).toContain("Mine.");
  });
});

test("grok uninstall round-trips portable skills via the install manifest", async () => {
  await withTempDir("soma-grok-uninstall-portable-", async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    for (const [skill, file, body] of [
      ["notes", "SKILL.md", "---\nname: notes\n---\n\nNote-taking skill.\n"],
      ["notes", "reference.md", "Reference material.\n"],
      ["tasks", "SKILL.md", "---\nname: tasks\n---\n\nTask skill.\n"],
    ] as const) {
      await mkdir(join(somaHome, "skills", skill), { recursive: true });
      await writeFile(join(somaHome, "skills", skill, file), body, "utf8");
    }

    await installSomaForGrok({ homeDir });
    const grokHome = join(homeDir, ".grok");
    expect(await readFile(join(grokHome, "skills", "notes", "SKILL.md"), "utf8")).toContain("Note-taking");
    expect(await readFile(join(grokHome, "skills", "tasks", "SKILL.md"), "utf8")).toContain("Task skill");

    // A user edit to a projected file and a user-added file must survive.
    await writeFile(join(grokHome, "skills", "notes", "reference.md"), "My hand-tuned reference.\n", "utf8");
    await writeFile(join(grokHome, "skills", "notes", "extra.md"), "User-added.\n", "utf8");

    const result = await uninstallSomaForGrok({ homeDir });
    const removed = result.removed.map(normalize);

    expect(removed).toContain(normalize(join(grokHome, "skills/notes/SKILL.md")));
    expect(removed).toContain(normalize(join(grokHome, "skills/tasks/SKILL.md")));
    expect(removed).toContain(normalize(grokInstallManifestPath(somaHome)));
    // tasks emptied out and was pruned; notes kept the user content.
    expect(await pathGone(join(grokHome, "skills", "tasks"))).toBe(true);
    expect(await pathGone(join(grokHome, "skills", "notes", "SKILL.md"))).toBe(true);
    expect(await readFile(join(grokHome, "skills", "notes", "reference.md"), "utf8")).toBe("My hand-tuned reference.\n");
    expect(await readFile(join(grokHome, "skills", "notes", "extra.md"), "utf8")).toBe("User-added.\n");
    expect(await pathGone(grokInstallManifestPath(somaHome))).toBe(true);
  });
});

test("grok uninstall ignores a manifest recorded for a different substrate home", async () => {
  await withTempDir("soma-grok-uninstall-manifest-mismatch-", async (homeDir) => {
    const somaHome = join(homeDir, ".soma");
    const grokHome = join(homeDir, ".grok");
    await mkdir(join(grokHome, "skills", "notes"), { recursive: true });
    await writeFile(join(grokHome, "skills", "notes", "SKILL.md"), "User skill.\n", "utf8");
    const manifestPath = grokInstallManifestPath(somaHome);
    await mkdir(join(somaHome, "projections", "grok"), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schema: GROK_INSTALL_MANIFEST_SCHEMA,
        substrateHome: join(homeDir, "somewhere-else", ".grok"),
        files: [{ path: "skills/notes/SKILL.md", sha256: "0".repeat(64) }],
      })}\n`,
      "utf8",
    );

    const result = await uninstallSomaForGrok({ homeDir });

    expect(result.removed).toEqual([]);
    expect(await readFile(join(grokHome, "skills", "notes", "SKILL.md"), "utf8")).toBe("User skill.\n");
    // The foreign-home manifest is NOT consumed.
    expect(await pathGone(manifestPath)).toBe(false);
  });
});

test("grok uninstall skips manifest paths that escape the substrate home", async () => {
  await withTempDir("soma-grok-uninstall-manifest-escape-", async (homeDir) => {
    const somaHome = join(homeDir, ".soma");
    const grokHome = join(homeDir, ".grok");
    await mkdir(grokHome, { recursive: true });
    const outside = join(homeDir, "outside.md");
    await writeFile(outside, "Do not touch.\n", "utf8");
    await mkdir(join(somaHome, "projections", "grok"), { recursive: true });
    await writeFile(
      grokInstallManifestPath(somaHome),
      `${JSON.stringify({
        schema: GROK_INSTALL_MANIFEST_SCHEMA,
        substrateHome: resolve(grokHome),
        files: [{ path: "../outside.md", sha256: "0".repeat(64) }],
      })}\n`,
      "utf8",
    );

    const result = await uninstallSomaForGrok({ homeDir });

    expect(await readFile(outside, "utf8")).toBe("Do not touch.\n");
    // The matching-home manifest is consumed even though its entries were rejected.
    expect(result.removed.map(normalize)).toContain(normalize(grokInstallManifestPath(somaHome)));
  });
});

test("grok uninstall is an idempotent no-op the second time", async () => {
  await withTempDir("soma-grok-uninstall-idempotent-", async (homeDir) => {
    await installSomaForGrok({ homeDir });

    const first = await uninstallSomaForGrok({ homeDir });
    const second = await uninstallSomaForGrok({ homeDir });

    expect(first.removed.length).toBeGreaterThan(0);
    expect(second.removed).toEqual([]);
  });
});

test("grok uninstall removes the workspace rules overlay, marker-guarded", async () => {
  await withTempDir("soma-grok-uninstall-workspace-", async (workspaceRoot) => {
    // Workspace bundle: <repo>/.grok/rules/soma/ written by projectGrok.
    await writeProjection(projectGrok(portableProjectionInput), workspaceRoot);
    const workspaceGrokHome = join(workspaceRoot, ".grok");
    // A neighboring foreign rules dir must survive.
    await mkdir(join(workspaceGrokHome, "rules", "mine"), { recursive: true });
    await writeFile(join(workspaceGrokHome, "rules", "mine", "rules.md"), "User rules.\n", "utf8");

    const result = await uninstallSomaForGrok({ substrateHome: workspaceGrokHome });

    expect(result.removed.map(normalize)).toContain(normalize(join(workspaceGrokHome, "rules/soma")));
    expect(await pathGone(join(workspaceGrokHome, "rules", "soma"))).toBe(true);
    expect(await readFile(join(workspaceGrokHome, "rules", "mine", "rules.md"), "utf8")).toBe("User rules.\n");
  });
});

test("grok uninstall leaves a rules/soma dir without the Soma README marker", async () => {
  await withTempDir("soma-grok-uninstall-foreign-rules-", async (workspaceRoot) => {
    const workspaceGrokHome = join(workspaceRoot, ".grok");
    await mkdir(join(workspaceGrokHome, "rules", "soma"), { recursive: true });
    await writeFile(join(workspaceGrokHome, "rules", "soma", "README.md"), "# My own soma notes\n", "utf8");

    const result = await uninstallSomaForGrok({ substrateHome: workspaceGrokHome });

    expect(result.removed).toEqual([]);
    expect(await readFile(join(workspaceGrokHome, "rules", "soma", "README.md"), "utf8")).toContain("My own soma notes");
  });
});

test("grok uninstall leaves an unterminated marker block alone (foreign content)", async () => {
  await withTempDir("soma-grok-uninstall-unterminated-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    await mkdir(grokHome, { recursive: true });
    // Begin marker without end: the upsert treats this as foreign, so the
    // unpatch must too.
    const content = `# Mine\n\n${GROK_AGENTS_BLOCK_BEGIN}\nuser kept this around\n`;
    await writeFile(join(grokHome, "AGENTS.md"), content, "utf8");

    const result = await uninstallSomaForGrok({ homeDir });

    expect(result.removed).toEqual([]);
    expect(await readFile(join(grokHome, "AGENTS.md"), "utf8")).toBe(content);
  });
});

test("grok uninstall rethrows non-ENOENT errors", async () => {
  await withTempDir("soma-grok-uninstall-error-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    // AGENTS.md as a directory: readFile fails with EISDIR, not ENOENT.
    await mkdir(join(grokHome, "AGENTS.md"), { recursive: true });

    await expect(uninstallSomaForGrok({ homeDir })).rejects.toThrow();
  });
});

test("soma uninstall grok CLI reports removed paths and a clean no-op", async () => {
  await withTempDir("soma-grok-uninstall-cli-", async (homeDir) => {
    await installSomaForGrok({ homeDir });

    const output = await runSomaCli(["uninstall", "grok", "--home-dir", homeDir]);
    expect(output).toContain("soma uninstall grok");
    expect(output).toContain("Removed:");
    expect(normalize(output)).toContain("skills/soma");

    const second = await runSomaCli(["uninstall", "grok", "--home-dir", homeDir]);
    expect(second).toContain("Nothing to remove");
  });
});

// a stray foreign `# soma:grok:config:begin` line preceding the real block
// must not let unpatch excise the foreign bytes between the stray begin and
// the real end. The nearest-pair, line-anchored matching targets only the
// real (inner) begin/end pair.
test("config unpatch preserves a foreign begin-marker that precedes the real block", async () => {
  await withTempDir("soma-grok-f7-", async (grokHome) => {
    const configPath = join(grokHome, "config.toml");
    const foreign = `[tool]\nnote = "x"\n${GROK_CONFIG_BLOCK_BEGIN}\nFOREIGN_KEEP = true\n`;
    await mkdir(grokHome, { recursive: true });
    await writeFile(configPath, foreign, "utf8");

    // The stray begin has no end, so the real block is appended (not nested
    // into the foreign marker).
    await configureGrokConfigPatch(grokHome, "/some/.soma");
    const afterInstall = await readFile(configPath, "utf8");
    expect(afterInstall).toContain("FOREIGN_KEEP = true");
    expect(afterInstall).toContain(GROK_CONFIG_BLOCK_END);

    // Uninstall excises ONLY the real inner pair; the foreign begin marker
    // and the bytes after it survive.
    await removeConfigPatchBlock(grokHome);
    const afterRemove = await readFile(configPath, "utf8");
    expect(afterRemove).toContain("FOREIGN_KEEP = true");
    expect(afterRemove).toContain(GROK_CONFIG_BLOCK_BEGIN); // the foreign marker
    expect(afterRemove).not.toContain(GROK_CONFIG_BLOCK_END); // real block gone
    expect(afterRemove).not.toContain("Source of truth"); // real block body gone
  });
});
