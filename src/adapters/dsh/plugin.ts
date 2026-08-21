import { execFile } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureDshCordisPatch, type DshCordisPatchConfig } from "./config-patch";

/**
 * Installer-managed DSH host-plugin wiring. `soma install dsh --apply` owns
 * the whole activation chain — the manual `dsh plugin add` + hand-edited
 * cordis.patch.yml dance is gone:
 *
 * 1. copy the plugin package from the RUNNING soma installation (resolved
 *    relative to this module, so a deployed soma copies its own bytes, never
 *    a development checkout) into `<somaHome>/integrations/dsh/soma-host`;
 * 2. add it to the profile as a `file:` dependency via pnpm (the same
 *    forwarder `dsh plugin add` uses — note the `-w`: the profile directory
 *    is a workspace root);
 * 3. only then upsert the marker-guarded `- insert:` row into the profile's
 *    `cordis.patch.yml`. The row references a dependency that exists, so a
 *    failed step must NOT patch — an insert row without the dependency
 *    crashes every subsequent `dsh web` boot.
 */

export const DSH_PROFILE_NAME = "web";
export const DSH_HOST_PLUGIN_ID = "soma-host";
export const DSH_HOST_PLUGIN_NAME = "@metafactory/soma-dsh-host";

/** Directory of THIS module's compiled file — the running soma package root. */
function somaPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Source of truth for the plugin bytes inside any soma installation. */
export function dshHostPluginSourceRoot(): string {
  return join(somaPackageRoot(), "integrations", "dsh", "soma-host");
}

/** Where install materialises the plugin under Soma's own home. */
export function dshHostPluginDestination(somaHome: string): string {
  return join(somaHome, "integrations", "dsh", "soma-host");
}

export function dshProfileDir(dshHome: string): string {
  return join(dshHome, "profiles", DSH_PROFILE_NAME);
}

/** Minimal spawn seam so tests can stub the package-manager call. */
export type PnpmRunner = (args: string[], cwd: string) => Promise<{ exitCode: number; stderr: string }>;

const defaultRunPnpm: PnpmRunner = (args, cwd) =>
  new Promise((resolvePromise) => {
    execFile("pnpm", args, { cwd, timeout: 120_000 }, (error, _stdout, stderr) => {
      if (error) {
        const code = typeof error.code === "number" ? error.code : 1;
        resolvePromise({ exitCode: code, stderr: String(stderr ?? error.message) });
        return;
      }
      resolvePromise({ exitCode: 0, stderr: String(stderr ?? "") });
    });
  });

export interface InstallDshHostPluginOptions {
  dshHome: string;
  somaHome: string;
  /** soma binary recorded in the composition row; defaults to PATH lookup. */
  somaBin?: string;
  runPnpm?: PnpmRunner;
}

export interface InstallDshHostPluginResult {
  /** Human-readable decision trail for apply output. */
  notes: string[];
  /**
   * Landed file paths for the install layer's reported-files contract
   * (postProjection returns are treated as projected files). Only the
   * composition row qualifies; skips and failures land nothing.
   */
  files: string[];
}

/**
 * Run the full wiring chain. Best-effort by design: a missing profile or
 * failed pnpm call skips the patch and reports instead of failing the install.
 */
export async function installDshHostPlugin(options: InstallDshHostPluginOptions): Promise<InstallDshHostPluginResult> {
  const { dshHome, somaHome } = options;
  const notes: string[] = [];
  const profilePackageJson = join(dshProfileDir(dshHome), "package.json");

  if (!existsSync(profilePackageJson)) {
    return {
      notes: [`skipped ${DSH_HOST_PLUGIN_ID}: no composed profile at profiles/${DSH_PROFILE_NAME} (no package.json)`],
      files: [],
    };
  }

  // 1. Refresh the plugin copy under the soma home from the running install.
  const source = dshHostPluginSourceRoot();
  const destination = dshHostPluginDestination(somaHome);
  if (!existsSync(join(source, "package.json"))) {
    return { notes: [`skipped ${DSH_HOST_PLUGIN_ID}: plugin source not found at ${source}`], files: [] };
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
  notes.push(`copied ${DSH_HOST_PLUGIN_NAME} → ${destination}`);

  // 2. Wire it into the profile as a file: dependency.
  const runner = options.runPnpm ?? defaultRunPnpm;
  const outcome = await runner(["add", "-w", `file:${destination}`], dshProfileDir(dshHome));
  if (outcome.exitCode !== 0) {
    notes.push(
      `WARNING ${DSH_HOST_PLUGIN_ID} not activated: pnpm add failed (exit ${outcome.exitCode}). ` +
        `cordis.patch.yml left untouched; fix pnpm and rerun \`soma install dsh --apply\`.` +
        (outcome.stderr.trim() ? ` stderr: ${outcome.stderr.trim().slice(0, 300)}` : ""),
    );
    return { notes, files: [] };
  }
  notes.push(`added ${DSH_HOST_PLUGIN_NAME} to profiles/${DSH_PROFILE_NAME} via pnpm`);

  // 3. Composition row — safe to write only after the dependency landed.
  const somaPath = options.somaBin ?? Bun.which("soma") ?? "soma";
  const patch: DshCordisPatchConfig = {
    id: DSH_HOST_PLUGIN_ID,
    name: DSH_HOST_PLUGIN_NAME,
    config: { writeDigests: true, somaPath },
  };
  const patched = await configureDshCordisPatch(dshHome, DSH_PROFILE_NAME, patch);
  notes.push(`patched ${patched}`);
  return { notes, files: [patched] };
}
