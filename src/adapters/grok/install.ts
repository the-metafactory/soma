import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isEnoent } from "../../fs-errors";
import { isaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import type { SubstrateId } from "../../types";
import {
  GROK_AGENT_MARKER,
  GROK_PERSONA_MARKER,
  GROK_ROLE_MARKER,
  GROK_SOMA_REPO_POINTER_PATH,
  GROK_STARTUP_CONTEXT_PATH,
} from "./projection-constants";
import {
  configureGrokAgentsPointer,
  configureGrokConfigPatch,
  removeAgentsImportBlock,
  removeConfigPatchBlock,
} from "./config-patch";
import { smokeTestInstalledGrokHookCommand } from "./hook-smoke";
import { removeGrokPortableSkillProjection } from "./install-manifest";
import { validateGrokInstallRuntime } from "./version";

const GROK_DEFAULT_HOME = ".grok";

/**
 * Static file set emitted by `projectGrokHome`, relative to `~/.grok` —
 * the grok-install sync test asserts this list against the projection.
 * Dynamic entries (the active-ISA file, portable skill files) are NOT
 * listed, mirroring `CODEX_HOME_FILES`.
 */
export const GROK_STATIC_PROJECTION_FILES = [
  "skills/soma/SKILL.md",
  "skills/soma/context.md",
  "skills/soma/memory-layout.md",
  "skills/soma/skills.md",
  "skills/soma/policy.md",
  "hooks/soma-lifecycle.json",
  "hooks/soma-lifecycle.mjs",
  "hooks/soma-lifecycle.config.json",
  "hooks/grok-hook-entry.mjs",
  // The shell-extraction core precedes its importer so a reproject never
  // has a window where grok-policy-targets.mjs is on disk without it.
  "hooks/shell-policy-core.mjs",
  "hooks/grok-policy-targets.mjs",
  "hooks/grok-hook-verbs.mjs",
  "hooks/policy-marker.mjs",
  "hooks/soma-feedback-capture.mjs",
  "skills/the-algorithm/SKILL.md",
  // native Grok subagent surfaces (shared dirs, like hooks/).
  "personas/soma.toml",
  "roles/soma-algorithm.toml",
  "agents/soma-explore.md",
] as const;

/** Written by the shared lifecycle-projection step, not the bundle. */
export const GROK_LIFECYCLE_FILES = [GROK_STARTUP_CONTEXT_PATH, GROK_SOMA_REPO_POINTER_PATH] as const;

/** User-owned files install patches (marker-guarded), never overwrites. */
export const GROK_PATCH_TARGETS = ["AGENTS.md", "config.toml"] as const;

/**
 * Everything `soma install grok` writes or patches, relative to
 * `~/.grok` — the install plan derives `substrateFiles` from this list,
 * so it is the union of the three sub-lists above (dry-run == apply).
 */
export const GROK_HOME_FILES = [...GROK_STATIC_PROJECTION_FILES, ...GROK_LIFECYCLE_FILES, ...GROK_PATCH_TARGETS] as const;

/**
 * Skill directories the static projection owns under `~/.grok/skills/`,
 * derived from `GROK_HOME_FILES` so uninstall (and the doctor's
 * discovery checks) can never drift from what install writes.
 */
export const GROK_PROJECTED_SKILL_NAMES = GROK_HOME_FILES
  .map((file) => /^skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1])
  .filter((name): name is string => name !== undefined);

/**
 * Soma-ownership markers for the removable directories: uninstall
 * deletes a directory only when its identifying file carries the marker
 * the Soma renderer writes, so a user directory that merely shares the
 * name survives. Marker sources: `renderGrokHomeSkill` (soma),
 * `renderAlgorithmRenderingContract` (the-algorithm), the versioned ISA
 * skill body (ISA), and `renderGrokRulesReadme` (the workspace rules
 * overlay).
 */
const GROK_SKILL_DIR_MARKERS: Record<string, { file: string; marker: string }> = {
  "soma": { file: "SKILL.md", marker: "This projection is generated from Soma." },
  "the-algorithm": { file: "SKILL.md", marker: "Soma Algorithm rendering contract" },
  "ISA": { file: "SKILL.md", marker: "Ideal State Artifact" },
  // The project-scoped rules overlay (written by workspace bundles, never
  // by the home projection) — removed so `soma uninstall grok --workspace`
  // round-trips, harmless at home scope where the dir does not exist.
  "rules-soma": { file: "README.md", marker: "# Soma Grok Projection" },
};

/**
 * Hook files live in the SHARED `~/.grok/hooks/` directory alongside any
 * user hooks, so uninstall removes the individual Soma files — never the
 * directory — and each removal is marker-guarded against a user file
 * that merely shares the name. Markers are strings the renderers always
 * emit into the respective file. Exported so the marker-validity
 * test can iterate the whole map against the rendered asset bytes.
 */
export const GROK_HOOK_FILE_MARKERS: Record<string, string> = {
  "soma-lifecycle.json": "soma-lifecycle.mjs",
  "soma-lifecycle.mjs": "soma-lifecycle.config.json",
  "soma-lifecycle.config.json": '"somaHome"',
  "grok-hook-entry.mjs": "runGrokHook",
  "grok-policy-targets.mjs": "extractWriteTargets",
  "shell-policy-core.mjs": "soma:grok:shell-policy-core",
  "grok-hook-verbs.mjs": "GROK_PRE_TOOL_USE_VERB",
  "policy-marker.mjs": "hasSomaPolicyPrivateMarker",
  "soma-feedback-capture.mjs": "runSomaFeedbackCapture",
};

/**
 * Native subagent surfaces live in SHARED dirs (`personas/`, `roles/`,
 * `agents/`) alongside any user-authored files, so uninstall removes the
 * individual marker-guarded Soma file and never the directory — the same
 * model as `hooks/`. Markers are strings the renderers always emit into
 * the respective file.
 */
const GROK_SUBAGENT_SURFACE_DIRS = new Set(["personas", "roles", "agents"]);
const GROK_SUBAGENT_FILE_MARKERS: Record<string, string> = {
  "soma.toml": GROK_PERSONA_MARKER,
  "soma-algorithm.toml": GROK_ROLE_MARKER,
  "soma-explore.md": GROK_AGENT_MARKER,
};

async function shouldRemoveGrokTarget(target: string): Promise<boolean> {
  try {
    const parent = basename(dirname(target));
    if (parent === "hooks") {
      const marker = GROK_HOOK_FILE_MARKERS[basename(target)];
      return marker !== undefined && (await readFile(target, "utf8")).includes(marker);
    }
    if (GROK_SUBAGENT_SURFACE_DIRS.has(parent)) {
      const marker = GROK_SUBAGENT_FILE_MARKERS[basename(target)];
      return marker !== undefined && (await readFile(target, "utf8")).includes(marker);
    }
    // `rules/` only ever holds the workspace `rules/soma` overlay, so a
    // parent of `rules` maps to the rules-soma marker. At HOME scope Soma
    // never writes `~/.grok/rules/` (only the workspace projection writes
    // `.grok/rules/soma/`), so a foreign `~/.grok/rules/<dir>` has no matching
    // README marker and is intentionally left untouched — the marker guard,
    // not the path, decides removal.
    const guard = GROK_SKILL_DIR_MARKERS[parent === "rules" ? "rules-soma" : basename(target)];
    if (!guard) return false;
    return (await readFile(join(target, guard.file), "utf8")).includes(guard.marker);
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

/**
 * Portable Soma skills land under dynamic `skills/<name>/` paths the
 * static remove list cannot know. This predicate identifies them in a
 * projection bundle so install can record them in the install manifest.
 * Companion files of a portable `the-algorithm` skill
 * are excluded on purpose: that whole directory is statically removed,
 * marker-guarded on the rendering-contract SKILL.md.
 */
export function isGrokPortableSkillProjectionPath(path: string): boolean {
  const name = /^skills\/([^/]+)\//.exec(path)?.[1];
  return name !== undefined && name !== "ISA" && !(GROK_PROJECTED_SKILL_NAMES as readonly string[]).includes(name);
}

export function grokProjectionPrivateRoots(options: { homeDir?: string; substrate?: SubstrateId } = {}): string[] {
  if (options.substrate !== undefined && options.substrate !== "grok") return [];
  const home = resolve(options.homeDir ?? homedir());
  // The projected identity/context surface (Soma never writes into
  // ~/.grok/memory/, so there is no separate memory private root).
  return [join(home, GROK_DEFAULT_HOME, "skills", "soma")].map((path) => resolve(path));
}

export const grokInstallSpec: SubstrateInstallSpec<"grok"> = {
  substrate: "grok",
  defaultHome: GROK_DEFAULT_HOME,
  homeFiles: GROK_HOME_FILES,
  // refuse to install against an unsupported Grok runtime —
  // the whole adapter is a set of version-pinned assumptions (doctor
  // inspect shape, hook event set, enumerated tool names). Reads
  // `~/.grok/version.json`; a missing manifest is an unversioned dev
  // runtime and does not block.
  validator: validateGrokInstallRuntime,
  isaSkillProjection: {
    // Lands the versioned ISA skill at `~/.grok/skills/ISA` (same shape
    // as Codex's `isaSkillUnder()` → `~/.codex/skills/ISA`).
    destinationDir: isaSkillUnder(),
  },
  lifecycleProjection: {
    startupContextPath: GROK_STARTUP_CONTEXT_PATH,
    somaRepoPathPath: GROK_SOMA_REPO_POINTER_PATH,
  },
  privateRoots: {
    projection: grokProjectionPrivateRoots,
  },
  postProjection: [
    {
      // Marker-guarded pointer block in the user-owned ~/.grok/AGENTS.md
      // (verified auto-loaded home surface).
      name: "grok-agents-pointer",
      run: async ({ substrateHome, somaHome }) => [await configureGrokAgentsPointer(substrateHome, somaHome)],
    },
    {
      // Marker-guarded block in the user-owned ~/.grok/config.toml.
      name: "grok-config",
      run: async ({ substrateHome, somaHome }) => [await configureGrokConfigPatch(substrateHome, somaHome)],
    },
    {
      // Prove the EXACT frozen hook command spawns and allows a benign
      // call before the install reports success — an unlaunchable command
      // is fail-open on grok, so success must mean the gate demonstrably
      // fires. Apply paths only: the dry-run plan never runs
      // post-projection steps.
      name: "grok-hook-smoke",
      run: async ({ substrateHome }) => {
        await smokeTestInstalledGrokHookCommand(substrateHome);
        return [];
      },
    },
  ],
  uninstall: {
    // Real marker-guarded round-trip — remove the Soma-owned directories,
    // unpatch only the Soma blocks from the user-owned
    // AGENTS.md/config.toml, preserve every foreign byte.
    // Portable skills imported from the Soma home project under dynamic
    // `skills/<name>/` paths are removed via the install manifest in
    // postRemove (the static `remove` list cannot name their dynamic
    // paths; the manifest records them at install time).
    kind: "implemented",
    remove: [
      ...GROK_PROJECTED_SKILL_NAMES.map((name) => `skills/${name}`),
      "skills/ISA",
      "rules/soma",
      // Individual hook files derived from the static projection list —
      // the shared hooks/ dir itself stays (it may hold user hooks).
      ...GROK_STATIC_PROJECTION_FILES.filter((file) => file.startsWith("hooks/")),
      // native subagent surfaces in shared dirs — individual files,
      // marker-guarded; the personas/roles/agents dirs themselves stay.
      ...GROK_STATIC_PROJECTION_FILES.filter(
        (file) => file.startsWith("personas/") || file.startsWith("roles/") || file.startsWith("agents/"),
      ),
    ],
    shouldRemove: (target) => shouldRemoveGrokTarget(target),
    postRemove: async ({ homeDir, somaHome, substrateHome }) => {
      const removed: string[] = [
        // Portable skills round-trip through the install manifest (the
        // static removals above cannot name their dynamic paths).
        ...(await removeGrokPortableSkillProjection({
          somaHome: somaHome ?? resolve(homeDir ?? homedir(), ".soma"),
          substrateHome,
        })),
      ];
      for (const unpatch of [removeAgentsImportBlock, removeConfigPatchBlock]) {
        const path = await unpatch(substrateHome);
        if (path !== null) removed.push(path);
      }
      return removed;
    },
  },
};
