import { codexInstallSpec } from "./adapters/codex/install";
import { claudeCodeInstallSpec } from "./adapters/claude-code/install";
import { cursorInstallSpec } from "./adapters/cursor/install";
import { piDevInstallSpec } from "./adapters/pi-dev/install";
import type { InstallSubstrate, SubstrateInstallSpec } from "./install-spec";

const INSTALL_SPECS = {
  codex: codexInstallSpec,
  "pi-dev": piDevInstallSpec,
  "claude-code": claudeCodeInstallSpec,
  cursor: cursorInstallSpec,
} satisfies Record<InstallSubstrate, SubstrateInstallSpec>;

export function installSpecFor<S extends InstallSubstrate>(substrate: S): SubstrateInstallSpec<S> {
  return INSTALL_SPECS[substrate] as SubstrateInstallSpec<S>;
}

export function allInstallSpecs(): readonly SubstrateInstallSpec[] {
  return Object.values(INSTALL_SPECS);
}

export function isRegisteredInstallSubstrate(value: string | undefined): value is InstallSubstrate {
  return value !== undefined && Object.prototype.hasOwnProperty.call(INSTALL_SPECS, value);
}

export function defaultSubstrateHome(substrate: InstallSubstrate): string {
  return installSpecFor(substrate).defaultHome;
}
