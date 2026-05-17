/**
 * Single source of truth for the Soma version.
 *
 * Read from `package.json` at module load time. Every other module
 * (CLI banner, adapter projections, skill manifests) imports
 * `SOMA_VERSION` from here. Hardcoded version strings are forbidden
 * by lint convention — bump `package.json` and the rest follows.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

export const SOMA_VERSION: string = pkg.version;
