/**
 * Single-source kebab transform for skill names (Sage r1 #108: one
 * leaf module, so no caller carries its own copy of the pipeline).
 *
 * Pipeline:
 *   1. `([A-Z]+)([A-Z][a-z])` → `$1-$2`  — splits ALL-CAPS prefix
 *      from a following Capital+lowercase (`PAIUpgrade` → `PAI-Upgrade`,
 *      `HTMLParser` → `HTML-Parser`).
 *   2. `([a-z0-9])([A-Z])` → `$1-$2`     — standard CamelCase split
 *      (`ExtractWisdom` → `Extract-Wisdom`).
 *   3. lowercase → all-non-alnum to `-` → trim leading/trailing `-`.
 *
 * Order matters: rule 1 runs first so `PAIUpgrade` matches the
 * ALL-CAPS prefix branch before rule 2 sees `IU` (no lower-upper
 * boundary there).
 */
export function kebabSlug(value: string): string {
  return value
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
