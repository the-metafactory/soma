import { codexInstallSpec } from "./adapters/codex/install";
import type { InstallSubstrate, SubstrateInstallSpec } from "./install-spec";

const LEGACY_DEFAULT_SUBSTRATE_HOMES: Record<InstallSubstrate, string> = {
  codex: codexInstallSpec.defaultHome,
  "pi-dev": ".pi",
  "claude-code": ".claude",
  cursor: ".",
};

export function installSpecFor(substrate: InstallSubstrate): SubstrateInstallSpec | undefined {
  if (substrate === "codex") return codexInstallSpec;
  return undefined;
}

export function defaultSubstrateHome(substrate: InstallSubstrate): string {
  return installSpecFor(substrate)?.defaultHome ?? LEGACY_DEFAULT_SUBSTRATE_HOMES[substrate];
}
