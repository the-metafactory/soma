/**
 * Shared YAML-ish frontmatter helpers for `claude-skills-migrator.ts` +
 * `claude-skills-substrate-verify.ts`. Both modules previously had
 * near-identical `stripQuotes` + description-extraction logic; one
 * bugfix could land in one and miss the other. Holly r1 #117 finding
 * S2 surfaced the duplication.
 *
 * **Scope.** Single-line `key: value` frontmatter only — substrate
 * projection skill bodies follow that convention. No support for
 * folded scalars, block scalars, or anchors.
 *
 * **Reach.** The functions here are also safe to use from new code in
 * the same family (Phase 3 verifiers, etc.). Don't reach for these
 * from the pai-pack-normalizer — that module has its own structured
 * frontmatter rewriter with different semantics.
 */
export const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

/**
 * Strip a SINGLE pair of matching outer quotes from a frontmatter
 * value. Leaves unbalanced or unquoted values intact.
 */
export function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Extract the `description:` field from a frontmatter block, with
 * single-pair outer-quote stripping. Returns `undefined` if no
 * frontmatter or no `description:` line.
 */
export function parseDescriptionFromFrontmatter(skillMdContent: string): string | undefined {
  const match = FRONTMATTER_RE.exec(skillMdContent);
  if (!match) return undefined;
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("description:")) {
      return stripQuotes(line.slice("description:".length).trim());
    }
  }
  return undefined;
}
