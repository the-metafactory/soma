export { dshAdapter, isDshSkillProjectionPath, projectDsh, projectDshHome } from "./adapter";
export {
  configureDshAgentsPointer,
  configureDshCordisPatch,
  DSH_AGENTS_BLOCK_BEGIN,
  DSH_AGENTS_BLOCK_END,
  DSH_CORDIS_PATCH_BEGIN,
  DSH_CORDIS_PATCH_END,
  removeDshAgentsBlock,
  removeDshCordisPatchBlock,
  type DshCordisPatchConfig,
} from "./config-patch";
export {
  DSH_HOME_FILES,
  DSH_LIFECYCLE_FILES,
  DSH_PATCH_TARGETS,
  DSH_PROJECTED_SKILL_NAMES,
  DSH_STATIC_PROJECTION_FILES,
  dshInstallSpec,
} from "./install";
export {
  dshHostPluginDestination,
  dshHostPluginSourceRoot,
  DSH_HOST_PLUGIN_ID,
  DSH_HOST_PLUGIN_NAME,
  DSH_PROFILE_NAME,
  installDshHostPlugin,
  type InstallDshHostPluginOptions,
  type InstallDshHostPluginResult,
  type PnpmRunner,
} from "./plugin";
