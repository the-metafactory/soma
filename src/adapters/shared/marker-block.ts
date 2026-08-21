/**
 * Marker-guarded block location, shared by every adapter that patches a
 * user-owned file with HTML-comment markers (grok AGENTS.md/config, dsh
 * AGENTS.md/cordis.patch.yml). Extracted from identical copies in
 * grok/config-patch.ts and dsh/config-patch.ts so a third adapter cannot
 * grow a third copy.
 */

/** Offsets of `marker` where it starts a line (so an incidental mention of
 * the marker text inside prose or foreign content is ignored). */
export function lineStartOccurrences(content: string, marker: string): number[] {
  const positions: number[] = [];
  let index = content.indexOf(marker);
  while (index !== -1) {
    if (index === 0 || content[index - 1] === "\n") positions.push(index);
    index = content.indexOf(marker, index + marker.length);
  }
  return positions;
}

/**
 * Locate Soma's marker block as the nearest well-formed begin/end pair:
 * a line-anchored begin whose first following end marker has no other
 * begin marker between them. This makes a foreign `…:begin` string
 * preceding the real block fall through to the real (inner) pair instead
 * of excising the foreign bytes between the stray begin and the real end.
 * A begin with no following end is foreign and yields null.
 */
export function findMarkerBlock(content: string, begin: string, end: string): { start: number; bodyEnd: number } | null {
  const beginPositions = lineStartOccurrences(content, begin);
  const endPositions = lineStartOccurrences(content, end);
  for (const start of beginPositions) {
    const endStart = endPositions.find((position) => position >= start + begin.length);
    if (endStart === undefined) continue;
    const nestedBegin = beginPositions.find((position) => position > start && position < endStart);
    if (nestedBegin !== undefined) continue;
    return { start, bodyEnd: endStart + end.length };
  }
  return null;
}
