/**
 * Shared YAML-ish frontmatter helpers for `claude-skills-migrator.ts` +
 * `claude-skills-substrate-verify.ts`. Both modules previously had
 * near-identical `stripQuotes` + description-extraction logic; one
 * bugfix could land in one and miss the other. Holly r1 #117 finding
 * S2 surfaced the duplication.
 *
 * **Scope.** Minimal frontmatter parsing for the claude-skills
 * migration path. Supports single-line `key: value` fields plus
 * `description: |` / `description: >` block scalars. This is not a
 * general YAML parser; anchors, tags, and nested objects stay out of
 * scope.
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

export function leadingWhitespaceLength(value: string): number {
  return value.length - value.trimStart().length;
}

export function isFrontmatterBlockScalarMarker(value: string): boolean {
  return /^[|>][+-]?\d*$/.test(value);
}

export function findFrontmatterBlockScalarEndIndex(lines: string[], startIndex: number, parentIndent: number): number {
  let endIndex = startIndex;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    if (raw.trim().length > 0 && leadingWhitespaceLength(raw) <= parentIndent) {
      break;
    }
    endIndex = i;
  }
  return endIndex;
}

function parseDescriptionBlockScalar(lines: string[], startIndex: number, marker: string, parentIndent: number): string {
  const blockLines: string[] = [];
  const endIndex = findFrontmatterBlockScalarEndIndex(lines, startIndex, parentIndent);
  for (let i = startIndex + 1; i <= endIndex; i += 1) {
    blockLines.push(lines[i] ?? "");
  }

  const contentIndent = blockLines
    .filter((line) => line.trim().length > 0)
    .reduce<number | null>((min, line) => {
      const indent = leadingWhitespaceLength(line);
      return min === null ? indent : Math.min(min, indent);
    }, null);
  const dedented = blockLines.map((line) => {
    if (line.trim().length === 0) return "";
    return line.slice(contentIndent ?? 0);
  });

  if (marker.startsWith("|")) {
    return dedented.join("\n").trimEnd();
  }

  return dedented
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split(/\n/).map((line) => line.trim()).filter(Boolean).join(" "))
    .join("\n")
    .trimEnd();
}

/**
 * Extract the `description:` field from a frontmatter block, with
 * single-pair outer-quote stripping for single-line values. Returns
 * `undefined` if no frontmatter or no `description:` line.
 */
export function parseDescriptionFromFrontmatter(skillMdContent: string): string | undefined {
  const match = FRONTMATTER_RE.exec(skillMdContent);
  if (!match) return undefined;
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const line = raw.trimEnd();
    if (line.startsWith("description:")) {
      const value = line.slice("description:".length).trim();
      if (isFrontmatterBlockScalarMarker(value)) {
        return parseDescriptionBlockScalar(lines, i, value, leadingWhitespaceLength(raw));
      }
      return stripQuotes(value);
    }
  }
  return undefined;
}
