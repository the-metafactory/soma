import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { findMarkerBlock } from "../shared/marker-block";
import { dirname, join } from "node:path";
import { isEnoent } from "../../fs-errors";

/**
 * Marker-guarded patch for the one user-owned file in the DSH home:
 * `~/.dsh/AGENTS.md` (verified auto-loaded by `dsh-agent-instructions` into
 * every session as a `<system-reminder>`). Soma owns only the bytes between
 * its markers; everything outside them is foreign content that install must
 * preserve and uninstall must leave untouched. Markers are HTML comments
 * (invisible to the model), mirroring the grok AGENTS.md contract.
 */
export const DSH_AGENTS_BLOCK_BEGIN = "<!-- soma:dsh:agents:begin -->";
export const DSH_AGENTS_BLOCK_END = "<!-- soma:dsh:agents:end -->";

function renderAgentsPointerBlock(somaHome: string): string {
  // Concise by design: DSH auto-discovers every skill under ~/.dsh/skills, so
  // the `soma` skill is already in the session's catalog; AGENTS.md only points
  // at it for orientation.
  return [
    DSH_AGENTS_BLOCK_BEGIN,
    "## Soma",
    "",
    "Soma projects portable personal assistant context into this DeepSeek Harness home.",
    "",
    "- Primary context: the `soma` skill (`skills/soma/SKILL.md`); read it before acting as the personal assistant.",
    "- Algorithm mode: the `the-algorithm` skill.",
    `- Source of truth: ${somaHome} — this projection is generated; author changes there and rerun \`soma install dsh --apply\`.`,
    DSH_AGENTS_BLOCK_END,
  ].join("\n");
}

/**
 * Replace the existing marker block in place (preserving every byte
 * outside it) or append the block once. Re-running with the same inputs
 * is byte-stable. A begin marker without its end marker is treated as
 * foreign content and left alone (a fresh block is appended).
 */
function upsertMarkerBlock(existing: string, block: string, begin: string, end: string): string {
  const located = findMarkerBlock(existing, begin, end);
  if (located) {
    return `${existing.slice(0, located.start)}${block}${existing.slice(located.bodyEnd)}`;
  }
  if (existing.trim().length === 0) return `${block}\n`;
  return `${existing.trimEnd()}\n\n${block}\n`;
}

async function patchFileWithMarkerBlock(path: string, block: string, begin: string, end: string): Promise<string> {
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return "";
    throw error;
  });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, upsertMarkerBlock(existing, block, begin, end), "utf8");
  return path;
}

/**
 * Excise the Soma marker block, preserving every foreign byte around it.
 * Returns the file path when the file was modified or removed, null when
 * there was nothing to unpatch. A file that contained only the Soma block
 * (install created it) is removed outright. Unused while uninstall stays
 * reserved; exported so the patch/unpatch contract is testable and the
 * future implemented uninstaller has its counterpart ready.
 */
export async function removeDshAgentsBlock(dshHome: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(join(dshHome, "AGENTS.md"), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }

  const located = findMarkerBlock(content, DSH_AGENTS_BLOCK_BEGIN, DSH_AGENTS_BLOCK_END);
  if (!located) return null;

  const before = content.slice(0, located.start).trimEnd();
  const after = content.slice(located.bodyEnd).trimStart();
  const preserved = [before, after.trimEnd()].filter((part) => part.length > 0).join("\n\n");
  const target = join(dshHome, "AGENTS.md");
  if (preserved.length === 0) {
    await rm(target, { force: true });
    return target;
  }
  await writeFile(target, `${preserved}\n`, "utf8");
  return target;
}

export async function configureDshAgentsPointer(dshHome: string, somaHome: string): Promise<string> {
  return patchFileWithMarkerBlock(
    join(dshHome, "AGENTS.md"),
    renderAgentsPointerBlock(somaHome),
    DSH_AGENTS_BLOCK_BEGIN,
    DSH_AGENTS_BLOCK_END,
  );
}

// ── cordis.patch.yml composition row ─────────────────────────────────────────
//
// The host plugin activates only through an `- insert:` row in the profile's
// patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`). That file is
// user-owned YAML, so Soma manages only its marker-guarded block inside it.
// Markers must be YAML comments; the surrounding document must stay a valid
// top-level list, which drives three write shapes below (create / replace
// bare `[]` / append).

export const DSH_CORDIS_PATCH_BEGIN = "# <!-- soma:dsh:cordis-patch:begin -->";
export const DSH_CORDIS_PATCH_END = "# <!-- soma:dsh:cordis-patch:end -->";

/** Composition row config Soma writes for its host plugin. */
export interface DshCordisPatchConfig {
  /** Plugin id inside the entry tree. */
  id: string;
  /** Module specifier resolved from the profile's dependencies. */
  name: string;
  /** Config passed to the plugin's `apply(ctx, config)`. */
  config: Record<string, string | boolean | number>;
}

function renderCordisPatchBlock(patch: DshCordisPatchConfig): string {
  const configLines = Object.entries(patch.config).map(
    ([key, value]) => `        ${key}: ${typeof value === "string" ? JSON.stringify(value) : value}`,
  );
  return [
    DSH_CORDIS_PATCH_BEGIN,
    "- insert:",
    `    - id: ${patch.id}`,
    `      name: ${JSON.stringify(patch.name)}`,
    "      config:",
    ...configLines,
    DSH_CORDIS_PATCH_END,
  ].join("\n");
}

/**
 * A top-level `- insert:` list item containing `id: <pluginId>` that sits
 * OUTSIDE Soma's markers — e.g. written by hand before the marker contract
 * existed. Returns the content with such items removed; structural surprises
 * (unexpected indentation) abort the strip by returning null so the caller
 * can leave the file untouched rather than corrupt it.
 */
function stripLegacySomaHostInsertRow(content: string, pluginId: string): string | null {
  const lines = content.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    if (/^-\s+insert:\s*$/.test(line)) {
      // Collect the whole list item: this line plus every following line
      // indented deeper than column 0.
      let end = index + 1;
      while (end < lines.length && /^\s/.test(lines[end])) end += 1;
      const item = lines.slice(index, end);
      if (item.some((entry) => entry.trim() === `id: ${pluginId}` || entry.trim() === `- id: ${pluginId}`)) {
        index = end;
        continue;
      }
      kept.push(...item);
      index = end;
      continue;
    }
    kept.push(line);
    index += 1;
  }
  return kept.join("\n");
}

function nonStructuralContent(content: string): string {
  // Everything that carries no list semantics: blank lines, full-line comments,
  // and the bare `[]` empty-list placeholder install replaces with its block.
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#") && !/^\[\]$/.test(trimmed);
    })
    .join("\n")
    .trim();
}

/**
 * Upsert Soma's `- insert:` row into `profiles/<profile>/cordis.patch.yml`.
 * Idempotent and byte-stable outside the managed block. Handles the three
 * valid document shapes: missing/empty file, bare `[]` placeholder (replaced
 * — a flow-sequence followed by block items would be invalid YAML), and an
 * existing list (block appended). A legacy hand-written `id: soma-host` row
 * outside the markers is stripped first so re-runs cannot double-insert.
 */
export async function configureDshCordisPatch(
  dshHome: string,
  profile: string,
  patch: DshCordisPatchConfig,
): Promise<string> {
  const target = join(dshHome, "profiles", profile, "cordis.patch.yml");
  let existing = await readFile(target, "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return "";
    throw error;
  });

  const located = findMarkerBlock(existing, DSH_CORDIS_PATCH_BEGIN, DSH_CORDIS_PATCH_END);
  if (!located && existing.includes(`id: ${patch.id}`)) {
    const stripped = stripLegacySomaHostInsertRow(existing, patch.id);
    if (stripped === null) {
      // Loud, not silent: an unrecognized structure keeps the duplicate row
      // and the loader would fail on it — surface why instead of degrading.
      console.warn(`[dsh] ${target}: unrecognized structure around legacy id ${patch.id}; leaving file untouched`);
      throw new Error(`refusing to patch ${target}: unrecognized structure around id ${patch.id}`);
    }
    existing = stripped;
  }

  const block = renderCordisPatchBlock(patch);
  let updated: string;
  if (located) {
    updated = `${existing.slice(0, located.start)}${block}${existing.slice(located.bodyEnd)}`;
  } else if (nonStructuralContent(existing).length === 0) {
    // Comments/blank/bare `[]` only: drop the placeholder, keep foreign comments.
    const comments = existing
      .split("\n")
      .filter((line) => line.trim().startsWith("#") && line !== DSH_CORDIS_PATCH_BEGIN && line !== DSH_CORDIS_PATCH_END);
    updated = `${comments.join("\n").trimEnd()}${comments.length ? "\n" : ""}${block}\n`;
  } else {
    updated = `${existing.trimEnd()}\n\n${block}\n`;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, updated, "utf8");
  return target;
}

/**
 * Remove Soma's marker block from `cordis.patch.yml`. If nothing structural
 * remains, restores the `[]` placeholder so the document stays valid YAML.
 * Returns the file path when modified, null when there was no block.
 */
export async function removeDshCordisPatchBlock(dshHome: string, profile: string): Promise<string | null> {
  const target = join(dshHome, "profiles", profile, "cordis.patch.yml");
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }

  const located = findMarkerBlock(content, DSH_CORDIS_PATCH_BEGIN, DSH_CORDIS_PATCH_END);
  if (!located) return null;

  const before = content.slice(0, located.start).replace(/\n+$/, "\n");
  const after = content.slice(located.bodyEnd).replace(/^\n+/, "");
  const preserved = `${before}${after}`.trim();
  await writeFile(target, preserved.length === 0 ? "[]\n" : `${preserved}\n`, "utf8");
  return target;
}
