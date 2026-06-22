import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isEnoent } from "../../fs-errors";

/**
 * Marker-guarded patches for the two user-owned files in the Grok home:
 * `~/.grok/AGENTS.md` (verified auto-loaded) and
 * `~/.grok/config.toml`. Soma owns only the bytes between its markers;
 * everything outside them is foreign content that install must preserve
 * and uninstall must leave untouched. AGENTS.md markers are HTML
 * comments (invisible to the model); config.toml markers are TOML
 * comments.
 */
export const GROK_AGENTS_BLOCK_BEGIN = "<!-- soma:grok:agents:begin -->";
export const GROK_AGENTS_BLOCK_END = "<!-- soma:grok:agents:end -->";
export const GROK_CONFIG_BLOCK_BEGIN = "# soma:grok:config:begin";
export const GROK_CONFIG_BLOCK_END = "# soma:grok:config:end";

function renderAgentsPointerBlock(somaHome: string): string {
  // Concise by design: the bulk of the projected context lives in the
  // auto-loaded `soma` skill; AGENTS.md only points at it.
  return [
    GROK_AGENTS_BLOCK_BEGIN,
    "## Soma",
    "",
    "Soma projects portable personal assistant context into this Grok home.",
    "",
    "- Primary context: the `soma` skill (`skills/soma/SKILL.md`); read it before acting as the personal assistant.",
    "- Algorithm mode: the `the-algorithm` skill.",
    `- Source of truth: ${somaHome} — this projection is generated; author changes there and rerun \`soma install grok --apply\`.`,
    GROK_AGENTS_BLOCK_END,
  ].join("\n");
}

function renderConfigPatchBlock(somaHome: string): string {
  // Comment-only at this stage: no Grok config behavior is written here
  // yet. The block exists so install/uninstall own a marked region from
  // day one; lifecycle-hook and policy settings land inside it in later
  // releases without changing the patch/unpatch contract.
  return [
    GROK_CONFIG_BLOCK_BEGIN,
    "# Soma projection marker. Soma-owned Grok settings are added here by",
    "# later Soma versions; uninstall removes only this marked block.",
    `# Source of truth: ${somaHome}`,
    GROK_CONFIG_BLOCK_END,
  ].join("\n");
}

/** Offsets of `marker` where it starts a line (so an incidental mention of
 * the marker text inside prose or foreign content is ignored). */
function lineStartOccurrences(content: string, marker: string): number[] {
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
function findMarkerBlock(content: string, begin: string, end: string): { start: number; bodyEnd: number } | null {
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
 * Returns the file path when the file was modified or
 * removed, null when there was nothing to unpatch. Mirrors the upsert's
 * contract in reverse: a begin marker without its end marker is foreign
 * content and is left alone, and a file that contained only the Soma
 * block (install created it) is removed outright.
 */
async function unpatchFileMarkerBlock(path: string, begin: string, end: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }

  const located = findMarkerBlock(content, begin, end);
  if (!located) return null;

  const before = content.slice(0, located.start).trimEnd();
  const after = content.slice(located.bodyEnd).trimStart();
  const preserved = [before, after.trimEnd()].filter((part) => part.length > 0).join("\n\n");
  if (preserved.length === 0) {
    await rm(path, { force: true });
    return path;
  }
  await writeFile(path, `${preserved}\n`, "utf8");
  return path;
}

export async function removeAgentsImportBlock(grokHome: string): Promise<string | null> {
  return unpatchFileMarkerBlock(join(grokHome, "AGENTS.md"), GROK_AGENTS_BLOCK_BEGIN, GROK_AGENTS_BLOCK_END);
}

export async function removeConfigPatchBlock(grokHome: string): Promise<string | null> {
  return unpatchFileMarkerBlock(join(grokHome, "config.toml"), GROK_CONFIG_BLOCK_BEGIN, GROK_CONFIG_BLOCK_END);
}

export async function configureGrokAgentsPointer(grokHome: string, somaHome: string): Promise<string> {
  return patchFileWithMarkerBlock(
    join(grokHome, "AGENTS.md"),
    renderAgentsPointerBlock(somaHome),
    GROK_AGENTS_BLOCK_BEGIN,
    GROK_AGENTS_BLOCK_END,
  );
}

export async function configureGrokConfigPatch(grokHome: string, somaHome: string): Promise<string> {
  return patchFileWithMarkerBlock(
    join(grokHome, "config.toml"),
    renderConfigPatchBlock(somaHome),
    GROK_CONFIG_BLOCK_BEGIN,
    GROK_CONFIG_BLOCK_END,
  );
}
