/**
 * Single source of truth for the Soma version.
 *
 * Imported statically from `package.json` so the value is inlined at bundle
 * time. A runtime `readFileSync` of `../package.json` breaks under
 * `bun build --compile`: inside the single-file bundle `import.meta.url`
 * resolves to `/$bunfs/`, where no package.json exists (soma#531). Every
 * other module (CLI banner, adapter projections, skill manifests) imports
 * `SOMA_VERSION` from here. Hardcoded version strings stay forbidden — bump
 * `package.json` and the rest follows.
 */
import packageJson from "../package.json";

export const SOMA_VERSION: string = (packageJson as { version: string }).version;
