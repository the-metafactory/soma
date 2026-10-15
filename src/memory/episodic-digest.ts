import { sanitizeNoteText } from "./memory-corpus";
import type { SomaMemoryNote } from "./types";

/**
 * First non-empty body line, sanitized + truncated — the digest pointer text.
 * This is a display summary only; the note id is the durable parse target.
 * Sanitization (#410) is the shared `sanitizeNoteText` that also guards recall
 * and the INDEX — a digest is a rendered artifact too, so the same strong
 * escape-sequence strip applies here rather than a third, weaker copy.
 */
function digestPointerText(note: SomaMemoryNote): string {
  const line = note.body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return sanitizeNoteText(line, { oneLine: true }).slice(0, 120);
}

/** Escape the id segment so the first unescaped colon remains the grammar boundary. */
function escapeDigestPointerId(id: string): string {
  return id.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function unescapeDigestPointerId(id: string): string {
  let out = "";
  let escaping = false;
  for (const ch of id) {
    if (escaping) {
      out += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    out += ch;
  }
  if (escaping) out += "\\";
  return out;
}

function parseDigestPointerId(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- ")) return undefined;

  const body = trimmed.slice(2);
  let escaping = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (ch === ":") {
      const id = body.slice(0, i).trim();
      if (id.length === 0) return undefined;
      return unescapeDigestPointerId(id);
    }
  }
  return undefined;
}

/** Render one monthly episodic digest pointer line. */
export function renderDigestPointer(note: SomaMemoryNote): string {
  return `- ${escapeDigestPointerId(note.id)}: ${digestPointerText(note)}`;
}

/** Parse all note ids from monthly episodic digest pointer lines. */
export function parseDigestPointerIds(content: string): string[] {
  const ids: string[] = [];
  for (const line of content.split("\n")) {
    const id = parseDigestPointerId(line);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}
