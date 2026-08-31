import { skillsLoaderUnder, vsaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import { DSH_DEFAULT_HOME } from "../private-roots";
import { configureDshAgentsPointer } from "./config-patch";
import { DSH_HOST_PLUGIN_ID, installDshHostPlugin } from "./plugin";
import { isDshSkillProjectionPath, projectDshHome } from "./adapter";

/**
 * Static file set emitted by `projectDshHome`, relative to `~/.dsh` — the
 * dsh-install sync test asserts this list against the projection. Dynamic
 * entries are NOT listed, mirroring `CODEX_HOME_FILES` /
 * `GROK_STATIC_PROJECTION_FILES`:
 *
 * - `skills/soma/communication.md` — omitted when the Soma home has no
 *   communication contract (a bootstrapped home always ships the starter,
 *   so like grok it stays in the declared set).
 * - `skills/soma/memory-index.md` — OMITTED from the declared set entirely
 *   (codex precedent): it projects only when a durable memory INDEX exists,
 *   so declaring it would promise a file a greenfield apply never writes.
 *   The owned-subtree reconcile still tracks it via the bundle when present.
 *
 * Portable skills are NOT in this list and NOT emitted by the projection at
 * all: DSH is a `loader` substrate, so install links the curated
 * `~/.soma/skills` registry into `<home>/skills` as symlinks (claude-code
 * precedent, soma#638). Same reason there is no static `the-algorithm`
 * override — the symlink occupies that slot.
 */
export const DSH_STATIC_PROJECTION_FILES = [
  "skills/soma/SKILL.md",
  "skills/soma/memory-layout.md",
  "skills/soma/policy.md",
  "skills/soma/lifecycle.md",
  // Conditional: omitted when the home has no `profile/communication.md`.
  "skills/soma/communication.md",
] as const;

/** Written by the shared lifecycle-projection step, not the bundle. */
export const DSH_LIFECYCLE_FILES = ["skills/soma/startup-context.md", "skills/soma/soma-repo.txt"] as const;

/** User-owned files install patches (marker-guarded), never overwrites. */
export const DSH_PATCH_TARGETS = ["AGENTS.md"] as const;

/**
 * Everything `soma install dsh` writes or patches, relative to `~/.dsh` —
 * the install plan derives `substrateFiles` from this list, so it is the
 * union of the three sub-lists above (dry-run == apply).
 */
export const DSH_HOME_FILES = [...DSH_STATIC_PROJECTION_FILES, ...DSH_LIFECYCLE_FILES, ...DSH_PATCH_TARGETS] as const;

/**
 * Skill directories the static projection owns under `~/.dsh/skills/`,
 * derived from `DSH_HOME_FILES` so uninstall (and the doctor's discovery
 * checks) can never drift from what install writes.
 */
export const DSH_PROJECTED_SKILL_NAMES = DSH_HOME_FILES
  .map((file) => /^skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1])
  .filter((name): name is string => name !== undefined);

export const dshInstallSpec: SubstrateInstallSpec<"dsh"> = {
  substrate: "dsh",
  defaultHome: DSH_DEFAULT_HOME,
  homeFiles: DSH_HOME_FILES,
  homeProjection: {
    build: (input, context) => projectDshHome(input, context.somaHome, context.homeDir, context.somaRepoPath),
    isSkillProjectionPath: isDshSkillProjectionPath,
  },
  // Soma-exclusive dir under the DSH home. `skills/` itself is SHARED (the
  // loader holds registry symlinks + the principal's own skills), so only the
  // soma skill dir is owned — the reconcile prunes it to the projected set
  // without ever touching sibling entries.
  ownedSubtrees: ["skills/soma"],
  skillsLoaderDir: skillsLoaderUnder(),
  skillsLoading: "on-demand",
  // dsh-skill-filesystem advertises its own catalog (name + description per
  // discovered SKILL.md), so Soma emits none — soma#638 loader mode.
  skillsDiscovery: "loader",
  vsaSkillProjection: {
    destinationDir: vsaSkillUnder(),
  },
  lifecycleProjection: {
    startupContextPath: "skills/soma/startup-context.md",
    somaRepoPathPath: "skills/soma/soma-repo.txt",
  },
  postProjection: [
    {
      name: "dsh-agents-pointer",
      run: async (context) => [await configureDshAgentsPointer(context.substrateHome, context.somaHome)],
    },
    {
      // Installer-managed host-plugin activation (see plugin.ts): copy the
      // plugin from the running soma installation into the soma home, add it
      // to the composed profile via pnpm, then upsert the marker-guarded
      // cordis.patch.yml row. Conditional by nature — skipped without a
      // composed profile — so it is deliberately NOT part of DSH_HOME_FILES.
      name: "dsh-host-plugin",
      run: async (context) => {
        const result = await installDshHostPlugin({ dshHome: context.substrateHome, somaHome: context.somaHome });
        for (const note of result.notes) console.log(`[dsh] ${note}`);
        return result.files;
      },
    },
  ],
  uninstall: {
    kind: "reserved",
    reason:
      "Removing Soma from a DSH home means unpatching the marker-guarded AGENTS.md block and cordis.patch.yml row, pruning skills/soma, removing registry symlinks, the copied integrations/dsh/soma-host under the soma home, and the profile's file: dependency. Patch counterparts exist (removeDshAgentsBlock, removeDshCordisPatchBlock) but the full uninstaller has not landed yet.",
  },
};
