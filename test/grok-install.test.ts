import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapSomaHome, installSomaForGrok, planSomaForGrokInstall, projectGrokHome, activeIsaProjectionPath } from "../src/index";
import { smokeTestInstalledGrokHookCommand } from "../src/adapters/grok/hook-smoke";
import { GROK_INSTALL_MANIFEST_SCHEMA, grokInstallManifestPath } from "../src/adapters/grok/install-manifest";
import { allInstallSpecs, installSpecFor } from "../src/install-spec-registry";
import { GROK_HOME_FILES, GROK_HOOK_FILE_MARKERS, GROK_STATIC_PROJECTION_FILES, grokInstallSpec } from "../src/adapters/grok/install";
import { isUnsupportedGrokVersion } from "../src/adapters/grok/version";
import {
  configureGrokAgentsPointer,
  configureGrokConfigPatch,
  GROK_AGENTS_BLOCK_BEGIN,
  GROK_AGENTS_BLOCK_END,
  GROK_CONFIG_BLOCK_BEGIN,
  GROK_CONFIG_BLOCK_END,
} from "../src/adapters/grok/config-patch";
import { writeProjection } from "../src/projection";
import { isSubstrateId, parseSubstrate } from "../src/cli/substrate";
import {
  parseExportArgs,
  parseInstallArgs,
  parseReprojectArgs,
  parseUninstallArgs,
  parseUpgradeArgs,
} from "../src/cli/substrate-lifecycle";
import { portableProjectionInput } from "./fixtures";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("grok is a registered install substrate with adapter-owned facts", () => {
  expect(allInstallSpecs().map((spec) => spec.substrate)).toContain("grok");

  const spec = installSpecFor("grok");
  expect(spec).toBe(grokInstallSpec);
  expect(spec.substrate).toBe("grok");
  expect(spec.defaultHome).toBe(".grok");
  expect(spec.homeFiles.length).toBeGreaterThan(0);
  // ISA skill lands at <substrateHome>/skills/ISA (codex-shaped, no double nesting).
  expect(spec.isaSkillProjection.destinationDir("/tmp/grok-home")).toContain("skills");
  expect(spec.isaSkillProjection.destinationDir("/tmp/grok-home")).toContain("ISA");
  // Verifies real marker-guarded uninstall round-trip.
  expect(spec.uninstall.kind).toBe("implemented");
});

test("grok resolves through substrate-id parsing", () => {
  expect(isSubstrateId("grok")).toBe(true);
  expect(parseSubstrate("grok")).toBe("grok");
});

test("every lifecycle verb accepts grok", () => {
  expect(parseInstallArgs(["install", "grok"]).substrate).toBe("grok");
  expect(parseUninstallArgs(["uninstall", "grok"]).substrate).toBe("grok");
  expect(parseReprojectArgs(["reproject", "grok"]).substrate).toBe("grok");
  expect(parseUpgradeArgs(["upgrade", "grok"]).substrate).toBe("grok");
  expect(parseExportArgs(["export", "grok"]).substrate).toBe("grok");
});

test("workspace grok install targets a .grok home, not the .codex fallback", () => {
  // Regression for workspaceSubstrateHome's silent `.codex` else-branch:
  // an unrecognized substrate would have fallen through to `.codex`.
  const parsed = parseInstallArgs(["install", "grok", "--workspace"]);
  expect(parsed.workspace).toBe(true);
  expect(parsed.options.substrateHome).toBeDefined();
  expect(parsed.options.substrateHome).toContain(".grok");
  expect(parsed.options.substrateHome).not.toContain(".codex");
});

test("activeIsaProjectionPath resolves grok without throwing", () => {
  expect(activeIsaProjectionPath("grok")).toBe("skills/soma/active-isa.md");
});

test("planSomaForGrokInstall produces a dry-run plan rooted at the grok home", () => {
  const plan = planSomaForGrokInstall({ homeDir: "/tmp/soma-grok-plan" });

  expect(plan.substrate).toBe("grok");
  expect(plan.apply).toBe(false);
  expect(plan.substrateHome).toContain(".grok");
  expect(plan.substrateFiles.length).toBeGreaterThan(0);
  expect(plan.substrateFiles.every((path) => path.startsWith("/tmp/soma-grok-plan/.grok"))).toBe(true);
});

test("GROK_HOME_FILES equals the static projection set plus the lifecycle and patch targets", () => {
  // Locks the sync contract between the install plan and
  // projectGrokHome: a static file added on either side without the
  // other fails here. Dynamic entries (active-isa, portable skills)
  // are excluded from the plan by design; the lifecycle files are
  // written by the shared lifecycle-projection step and the patch
  // targets by the post-projection steps.
  const staticInput = {
    ...portableProjectionInput,
    activeIsa: undefined,
    profile: { ...portableProjectionInput.profile, skills: [] },
  };
  const staticPaths = projectGrokHome(staticInput, "/tmp/soma-home").files.map((file) => file.path);

  expect(
    new Set([...staticPaths, "skills/soma/startup-context.md", "skills/soma/soma-repo.txt", "AGENTS.md", "config.toml"]),
  ).toEqual(new Set(GROK_HOME_FILES));
});

test("grok install records portable-skill files in the install manifest", async () => {
  await withTempDir("soma-grok-manifest-", async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await mkdir(join(somaHome, "skills", "notes"), { recursive: true });
    await writeFile(join(somaHome, "skills", "notes", "SKILL.md"), "---\nname: notes\n---\n\nNote-taking skill.\n", "utf8");

    await installSomaForGrok({ homeDir });

    const manifest = JSON.parse(await readFile(grokInstallManifestPath(somaHome), "utf8"));
    expect(manifest.schema).toBe(GROK_INSTALL_MANIFEST_SCHEMA);
    expect(resolve(manifest.substrateHome)).toBe(resolve(join(homeDir, ".grok")));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["skills/notes/SKILL.md"]);
    // The hash matches the on-disk (rewritten) projection bytes, so
    // uninstall's edited-file guard compares like for like.
    const onDisk = await readFile(join(homeDir, ".grok", "skills", "notes", "SKILL.md"), "utf8");
    expect(manifest.files[0].sha256).toBe(createHash("sha256").update(onDisk, "utf8").digest("hex"));

    // Statics never leak into the manifest: a skill-free reinstall
    // (fresh soma home) records an empty list.
    await rm(join(somaHome, "skills", "notes"), { recursive: true, force: true });
    await installSomaForGrok({ homeDir });
    const rerecorded = JSON.parse(await readFile(grokInstallManifestPath(somaHome), "utf8"));
    expect(rerecorded.files).toEqual([]);
  });
});

test("grok reinstall reconciles portable skills removed from the profile", async () => {
  await withTempDir("soma-grok-reconcile-", async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    for (const [skill, file, body] of [
      ["notes", "SKILL.md", "---\nname: notes\n---\n\nNote-taking skill.\n"],
      ["tasks", "SKILL.md", "---\nname: tasks\n---\n\nTask skill.\n"],
      ["tasks", "reference.md", "Task reference.\n"],
    ] as const) {
      await mkdir(join(somaHome, "skills", skill), { recursive: true });
      await writeFile(join(somaHome, "skills", skill, file), body, "utf8");
    }
    await installSomaForGrok({ homeDir });
    const grokHome = join(homeDir, ".grok");

    // The principal edits one projected file of the soon-removed skill,
    // then drops the skill from the profile and reinstalls.
    await writeFile(join(grokHome, "skills", "tasks", "reference.md"), "My hand-tuned task notes.\n", "utf8");
    await rm(join(somaHome, "skills", "tasks"), { recursive: true, force: true });
    await installSomaForGrok({ homeDir });

    // Stale unedited projection removed; the user edit survives in place;
    // the surviving skill is untouched; the manifest tracks only it.
    const pathGone = (path: string) => stat(path).then(() => false, () => true);
    expect(await pathGone(join(grokHome, "skills", "tasks", "SKILL.md"))).toBe(true);
    expect(await readFile(join(grokHome, "skills", "tasks", "reference.md"), "utf8")).toBe("My hand-tuned task notes.\n");
    expect(await readFile(join(grokHome, "skills", "notes", "SKILL.md"), "utf8")).toContain("Note-taking");
    const manifest = JSON.parse(await readFile(grokInstallManifestPath(somaHome), "utf8"));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["skills/notes/SKILL.md"]);

    // A fully-unedited removed skill leaves nothing behind: drop notes too.
    await rm(join(somaHome, "skills", "notes"), { recursive: true, force: true });
    await installSomaForGrok({ homeDir });
    expect(await pathGone(join(grokHome, "skills", "notes"))).toBe(true);
    expect(JSON.parse(await readFile(grokInstallManifestPath(somaHome), "utf8")).files).toEqual([]);
  });
});

test("grok AGENTS.md pointer block is appended once, idempotently, preserving foreign content", async () => {
  await withTempDir("soma-grok-agents-", async (grokHome) => {
    const path = join(grokHome, "AGENTS.md");
    await writeFile(path, "# My Grok rules\n\nKeep responses terse.\n", "utf8");

    await configureGrokAgentsPointer(grokHome, "/tmp/soma-home");
    const first = await readFile(path, "utf8");

    // Foreign lines preserved; Soma block appended exactly once.
    expect(first).toContain("# My Grok rules");
    expect(first).toContain("Keep responses terse.");
    expect(first.split(GROK_AGENTS_BLOCK_BEGIN)).toHaveLength(2);
    expect(first).toContain(GROK_AGENTS_BLOCK_END);
    expect(first).toContain("skills/soma/SKILL.md");
    expect(first).toContain("/tmp/soma-home");

    // Re-patch is byte-identical (no duplicate block).
    await configureGrokAgentsPointer(grokHome, "/tmp/soma-home");
    expect(await readFile(path, "utf8")).toBe(first);

    // A changed soma home rewrites only the marked block.
    await configureGrokAgentsPointer(grokHome, "/tmp/other-soma");
    const repatched = await readFile(path, "utf8");
    expect(repatched).toContain("# My Grok rules");
    expect(repatched).toContain("/tmp/other-soma");
    expect(repatched).not.toContain("/tmp/soma-home");
    expect(repatched.split(GROK_AGENTS_BLOCK_BEGIN)).toHaveLength(2);
  });
});

test("grok AGENTS.md pointer block creates the file when missing", async () => {
  await withTempDir("soma-grok-agents-new-", async (grokHome) => {
    await configureGrokAgentsPointer(grokHome, "/tmp/soma-home");
    const content = await readFile(join(grokHome, "AGENTS.md"), "utf8");
    expect(content.startsWith(GROK_AGENTS_BLOCK_BEGIN)).toBe(true);
    expect(content.trimEnd().endsWith(GROK_AGENTS_BLOCK_END)).toBe(true);
  });
});

test("grok config.toml marker block is appended once, idempotently, preserving foreign content", async () => {
  await withTempDir("soma-grok-config-", async (grokHome) => {
    const path = join(grokHome, "config.toml");
    await writeFile(path, '[ui]\ntheme = "dark"\n', "utf8");

    await configureGrokConfigPatch(grokHome, "/tmp/soma-home");
    const first = await readFile(path, "utf8");

    expect(first).toContain('theme = "dark"');
    expect(first.split(GROK_CONFIG_BLOCK_BEGIN)).toHaveLength(2);
    expect(first).toContain(GROK_CONFIG_BLOCK_END);

    await configureGrokConfigPatch(grokHome, "/tmp/soma-home");
    expect(await readFile(path, "utf8")).toBe(first);
  });
});

test("grok projection rejects path escapes", async () => {
  await withTempDir("soma-grok-escape-", async (root) => {
    const escaping = {
      substrate: "grok" as const,
      instructions: "",
      files: [{ path: "../escape.md", content: "nope" }],
    };
    const absolute = {
      substrate: "grok" as const,
      instructions: "",
      files: [{ path: join(root, "abs.md"), content: "nope" }],
    };

    await expect(writeProjection(escaping, root)).rejects.toThrow("escapes root");
    await expect(writeProjection(absolute, root)).rejects.toThrow("must be relative");
  });
});

// Shell-policy-core extraction: uninstall is marker-guarded per hook file,
// so every marker must actually appear in the rendered asset bytes — a marker
// that drifts out of its file silently bricks that file's removal. The loop
// pins the whole map at once, including `extractWriteTargets` in the shrunken
// grok-policy-targets.mjs and the new core's ownership sentinel.
test("every grok hook file's uninstall marker is present in its rendered asset bytes", async () => {
  await withTempDir("soma-grok-hook-markers-", async (homeDir) => {
    await installSomaForGrok({ homeDir });

    // Every projected hooks/ file is marker-guarded, and vice versa — a
    // hook file missing from the marker map would be unremovable.
    const projectedHookNames = GROK_STATIC_PROJECTION_FILES
      .filter((file) => file.startsWith("hooks/"))
      .map((file) => file.slice("hooks/".length));
    expect(new Set(Object.keys(GROK_HOOK_FILE_MARKERS))).toEqual(new Set(projectedHookNames));

    for (const [file, marker] of Object.entries(GROK_HOOK_FILE_MARKERS)) {
      const rendered = await readFile(join(homeDir, ".grok", "hooks", file), "utf8");
      expect(rendered).toContain(marker);
    }
  });
});

test("installSomaForGrok applies the plan exactly, idempotently, and preserves user-authored skills", async () => {
  await withTempDir("soma-grok-install-", async (homeDir) => {
    // A user-authored skill that shares the skills/ surface must survive.
    const foreignSkill = join(homeDir, ".grok", "skills", "mine", "SKILL.md");
    await mkdir(join(homeDir, ".grok", "skills", "mine"), { recursive: true });
    await writeFile(foreignSkill, "---\nname: mine\n---\n\nUser-owned.\n", "utf8");

    const plan = planSomaForGrokInstall({ homeDir });
    const result = await installSomaForGrok({ homeDir });

    // Dry-run == apply: the plan's substrate file set matches what the
    // installer wrote (fresh soma home -> no active ISA, no portable
    // skills, so the dynamic entries are absent on both sides). The
    // plan renders with forward slashes while the installer resolves
    // native paths, so compare separator-normalized.
    const normalize = (path: string) => path.replace(/\\/g, "/");
    expect(new Set(result.substrateHome.files.map(normalize))).toEqual(new Set(plan.substrateFiles.map(normalize)));

    const skillPath = join(homeDir, ".grok", "skills", "soma", "SKILL.md");
    const agentsPath = join(homeDir, ".grok", "AGENTS.md");
    const firstSkill = await readFile(skillPath, "utf8");
    const firstAgents = await readFile(agentsPath, "utf8");
    expect(firstSkill).toContain("name: soma");
    expect(firstAgents.split(GROK_AGENTS_BLOCK_BEGIN)).toHaveLength(2);

    // Second install: byte-identical projection, no duplicated AGENTS.md
    // block, foreign skill untouched.
    await installSomaForGrok({ homeDir });
    expect(await readFile(skillPath, "utf8")).toBe(firstSkill);
    expect(await readFile(agentsPath, "utf8")).toBe(firstAgents);
    expect(await readFile(foreignSkill, "utf8")).toContain("User-owned.");
  });
});

// Install-time version validator: Grok reports its version in
// `~/.grok/version.json` ({version, stable_version, checked_at}). The
// validator reads that manifest (no live grok exec) and refuses
// an unsupported runtime with upgrade guidance, mirroring pi-dev.

test("grok install passes on a supported runtime version", async () => {
  await withTempDir("soma-grok-ver-ok-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    await mkdir(grokHome, { recursive: true });
    await writeFile(join(grokHome, "version.json"), JSON.stringify({ version: "0.2.39", stable_version: "0.2.39" }), "utf8");

    // Resolves without throwing (the projection runs).
    const result = await installSomaForGrok({ homeDir });
    expect(result.substrateHome.files.length).toBeGreaterThan(0);
    expect(result.substrateHome.files.some((path) => path.replace(/\\/g, "/").includes(".grok/skills/soma/SKILL.md"))).toBe(true);
  });
});

test("grok install refuses a runtime below the minimum with upgrade guidance", async () => {
  await withTempDir("soma-grok-ver-old-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    await mkdir(grokHome, { recursive: true });
    await writeFile(join(grokHome, "version.json"), JSON.stringify({ version: "0.2.10" }), "utf8");

    await expect(installSomaForGrok({ homeDir })).rejects.toThrow("Unsupported grok version 0.2.10");
    await expect(installSomaForGrok({ homeDir })).rejects.toThrow("0.2.38");
  });
});

test("grok install refuses a prerelease runtime", async () => {
  await withTempDir("soma-grok-ver-pre-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    await mkdir(grokHome, { recursive: true });
    await writeFile(join(grokHome, "version.json"), JSON.stringify({ version: "0.2.40-rc.1" }), "utf8");

    await expect(installSomaForGrok({ homeDir })).rejects.toThrow("Unsupported grok version 0.2.40-rc.1");
  });
});

test("grok install refuses malformed version metadata", async () => {
  await withTempDir("soma-grok-ver-bad-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    await mkdir(grokHome, { recursive: true });
    await writeFile(join(grokHome, "version.json"), JSON.stringify({ version: "banana" }), "utf8");

    await expect(installSomaForGrok({ homeDir })).rejects.toThrow("Unable to read grok version");
  });
});

test("grok install passes silently when no version manifest exists (unknown dev runtime)", async () => {
  await withTempDir("soma-grok-ver-missing-", async (homeDir) => {
    // No ~/.grok/version.json — install must NOT block (mirrors pi-dev's
    // missing-manifest tolerance; the dev/source runtime is unversioned).
    const result = await installSomaForGrok({ homeDir });
    expect(result.substrateHome.files.length).toBeGreaterThan(0);
    expect(result.substrateHome.files.some((path) => path.replace(/\\/g, "/").includes(".grok/skills/soma/SKILL.md"))).toBe(true);
  });
});

test("isUnsupportedGrokVersion classifies floor, prerelease, and supported", () => {
  expect(isUnsupportedGrokVersion("0.2.38")).toBe(false);
  expect(isUnsupportedGrokVersion("0.2.39")).toBe(false);
  expect(isUnsupportedGrokVersion("1.0.0")).toBe(false);
  expect(isUnsupportedGrokVersion("0.2.37")).toBe(true);
  expect(isUnsupportedGrokVersion("0.1.99")).toBe(true);
  expect(isUnsupportedGrokVersion("0.2.38-rc.1")).toBe(true);
});

// Native Grok subagent surfaces — a Soma persona
// (`personas/soma.toml`), an Algorithm role (`roles/soma-algorithm.toml`),
// and a Soma-aware exploration agent (`agents/soma-explore.md`). Schema is
// limited to fields verified in `~/.grok/bundled/`; the unconfirmed
// `skills:` agent key is never emitted.

function grokHomeFile(path: string): string {
  const file = projectGrokHome(portableProjectionInput, "/tmp/soma-home").files.find((entry) => entry.path === path);
  if (!file) throw new Error(`projectGrokHome did not emit ${path}`);
  return file.content;
}

test("projectGrokHome emits the persona, role, and agent subagent surfaces", () => {
  const paths = projectGrokHome(portableProjectionInput, "/tmp/soma-home").files.map((file) => file.path);
  for (const expected of ["personas/soma.toml", "roles/soma-algorithm.toml", "agents/soma-explore.md"]) {
    expect(paths).toContain(expected);
  }
});

test("the Soma persona parses as TOML with description + instructions and no unknown top-level keys", () => {
  const parsed = Bun.TOML.parse(grokHomeFile("personas/soma.toml")) as Record<string, unknown>;
  expect(typeof parsed.description).toBe("string");
  expect((parsed.description as string).length).toBeGreaterThan(0);
  expect(typeof parsed.instructions).toBe("string");
  expect(parsed.instructions as string).toContain("Soma");
  // Only fields observed in the bundled personas.
  expect(new Set(Object.keys(parsed))).toEqual(new Set(["description", "instructions", "reasoning_effort"]));
});

test("the Soma Algorithm role carries a valid capability mode and no unknown keys", () => {
  const parsed = Bun.TOML.parse(grokHomeFile("roles/soma-algorithm.toml")) as Record<string, unknown>;
  // Enum values observed across the bundled roles.
  expect(["all", "read-only", "edit"]).toContain(parsed.default_capability_mode as string);
  expect(typeof parsed.description).toBe("string");
  expect(new Set(Object.keys(parsed))).toEqual(new Set(["description", "default_capability_mode", "reasoning_effort"]));
});

test("the Soma agent frontmatter uses only confirmed keys (no skills) and the body points at the memory layout + Algorithm", () => {
  const agent = grokHomeFile("agents/soma-explore.md");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(agent)?.[1] ?? "";
  expect(frontmatter).toContain("name: soma-explore");
  // Confirmed keys only; the unconfirmed skills: key is never emitted.
  expect(frontmatter).not.toMatch(/^\s*skills\s*:/m);
  for (const key of ["name", "description", "prompt_mode", "permission_mode", "agents_md"]) {
    expect(frontmatter).toContain(`${key}:`);
  }
  // Body references the projected memory layout and the Algorithm skill.
  expect(agent).toContain("skills/soma/memory-layout.md");
  expect(agent).toContain("the-algorithm");
});

test("subagent surfaces re-project byte-for-byte (idempotent)", () => {
  for (const path of ["personas/soma.toml", "roles/soma-algorithm.toml", "agents/soma-explore.md"]) {
    expect(grokHomeFile(path)).toBe(grokHomeFile(path));
  }
});

// Space-in-path hardening: the bare-exec hook command is space-joined, so
// a space in the grok home (or bun path) would split into bogus argv tokens
// and fail open. The invariant is that a spaced path NEVER yields a
// whitespace-containing command: on an 8.3-enabled volume install resolves
// the spaced home to a short (SOMAGR~1) path and succeeds with a clean
// 3-token command; where 8.3 is unavailable (incl. all POSIX CI) it fails
// loudly. Both outcomes are safe — what must never happen is a
// silently-broken, fail-open spaced command.
// Every apply-path install must end by spawning the EXACT frozen PreToolUse
// command and seeing it allow a benign call — an unlaunchable command is
// fail-open on grok, so "install succeeded" must mean "the gate
// demonstrably fires". The dry-run plan is pure and never smokes.
test("install spec wires the grok-hook-smoke post-projection step", () => {
  const names = (grokInstallSpec.postProjection ?? []).map((step) => step.name);
  expect(names).toContain("grok-hook-smoke");
  // Last: hook files and patches are all on disk before the probe.
  expect(names.at(-1)).toBe("grok-hook-smoke");
});

test("smoke passes against a real install; a sabotaged interpreter fails loudly; dry-run never smokes", async () => {
  await withTempDir("soma-grok-smoke-", async (homeDir) => {
    // The install itself already ran the smoke (apply path) — success
    // here is the positive leg. Re-running standalone pins the contract.
    await installSomaForGrok({ homeDir });
    await smokeTestInstalledGrokHookCommand(join(homeDir, ".grok"));

    // Sabotage the frozen command's interpreter token — the exact
    // incident class (a path no native spawn can resolve).
    const registrationPath = join(homeDir, ".grok", "hooks", "soma-lifecycle.json");
    const registration = JSON.parse(await readFile(registrationPath, "utf8"));
    const hook = registration.hooks.PreToolUse[0].hooks[0];
    const tokens = (hook.command as string).split(" ");
    tokens[0] = join(homeDir, "definitely-missing-bun").replace(/\s/g, "_");
    hook.command = tokens.join(" ");
    await writeFile(registrationPath, JSON.stringify(registration, null, 2), "utf8");

    let failure: unknown;
    await smokeTestInstalledGrokHookCommand(join(homeDir, ".grok")).catch((error: unknown) => {
      failure = error;
    });
    expect(String(failure)).toMatch(/post-install smoke/);
    expect(String(failure)).toMatch(/fail-open/);
    expect(String(failure)).toContain("definitely-missing-bun");

    // Dry-run over the sabotaged home: pure plan, no smoke, no throw.
    const plan = planSomaForGrokInstall({ homeDir });
    expect(plan.apply).toBe(false);
    expect(plan.substrateFiles.length).toBeGreaterThan(0);
  });
});

test("grok install never emits a whitespace hook command for a spaced home (8.3 short-name fallback)", async () => {
  await withTempDir("soma grok space ", async (homeDir) => {
    expect(homeDir).toContain(" ");

    let installed = true;
    try {
      await installSomaForGrok({ homeDir });
    } catch (err) {
      installed = false;
      expect(String(err)).toMatch(/whitespace in the (grok hooks path|bun path)/i);
    }

    if (installed) {
      const hooksJson = JSON.parse(await readFile(join(homeDir, ".grok", "hooks", "soma-lifecycle.json"), "utf8"));
      const commands: string[] = [];
      for (const entries of Object.values(hooksJson.hooks) as { hooks: { command: string }[] }[][]) {
        for (const entry of entries) for (const h of entry.hooks) commands.push(h.command);
      }
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        // Exactly `<bun> <module>.mjs <verb>` — three whitespace-free tokens.
        // A spaced home that installed proves the 8.3 short name was applied.
        expect(command.split(" ")).toHaveLength(3);
        expect(command).toContain(".mjs");
      }
    }
  });
});
