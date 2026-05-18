/**
 * Single-source kebab transform for PAI pack / nested skill names.
 *
 * Sage r1 #108 Maintainability — previously the same regex pipeline
 * lived in both `pai-pack-importer.ts:slugifySkillName` and
 * `pai-pack-routing.ts:kebabNestedName`, with a comment warning that
 * "Any change to either function MUST land in both." Extracting it
 * to this leaf module removes the trap: both modules import from
 * here, no duplication, no circular import.
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
