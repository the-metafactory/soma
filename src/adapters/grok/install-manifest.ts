import {
  portableSkillManifestPath,
  portableSkillManifestSchema,
  readPortableSkillManifest,
  reconcilePortableSkillProjection,
  removePortableSkillProjection,
  writePortableSkillManifest,
  type PortableSkillManifest,
} from "../shared/portable-skill-manifest";

/**
 * Grok's portable-skill install manifest is the shared
 * `portable-skill-manifest` mechanism bound to the `grok` substrate: schema
 * `soma-grok-install-manifest-v1`, stored at `<somaHome>/projections/grok/
 * <substrateHomeHash>/` (soma#438: keyed per substrate home so two `.grok`
 * homes installed from one soma home don't share a manifest). These thin
 * wrappers preserve the grok-named API its adapter/doctor/tests
 * already import; the byte output is identical to the shared helper with
 * `substrate: "grok"`. See `../shared/portable-skill-manifest.ts` for the
 * full contract (SHARED skills dir → manifest-tracked round-trip).
 */
export const GROK_INSTALL_MANIFEST_SCHEMA = portableSkillManifestSchema("grok");

export type GrokInstallManifest = PortableSkillManifest;

export function grokInstallManifestPath(somaHome: string, substrateHome: string): string {
  return portableSkillManifestPath(somaHome, "grok", substrateHome);
}

export function writeGrokInstallManifest(options: {
  somaHome: string;
  substrateHome: string;
  files: readonly { path: string; content: string }[];
}): Promise<string> {
  return writePortableSkillManifest({ ...options, substrate: "grok" });
}

export function readGrokInstallManifest(somaHome: string, substrateHome: string): Promise<GrokInstallManifest | null> {
  return readPortableSkillManifest(somaHome, "grok", substrateHome);
}

export function reconcileGrokPortableSkillProjection(options: {
  somaHome: string;
  substrateHome: string;
  currentPaths: readonly string[];
}): Promise<string[]> {
  return reconcilePortableSkillProjection({ ...options, substrate: "grok" });
}

export function removeGrokPortableSkillProjection(options: {
  somaHome: string;
  substrateHome: string;
}): Promise<string[]> {
  return removePortableSkillProjection({ ...options, substrate: "grok" });
}
