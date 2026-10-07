import { resolve } from "node:path";

/** Checkout locator; compiled skill readers use embedded content.
 * See docs/design-skill-packaging.md §Skills bundled with Soma for runtime staging.
 */
export function defaultSomaRepoPath(): string {
  return resolve(import.meta.dirname, "..");
}
