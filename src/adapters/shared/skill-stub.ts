import { PROVENANCE_MARKER } from "./provenance";

/**
 * soma#542 — the frontmatter-only skill stub projected into an *eager* skill
 * loader.
 *
 * A substrate whose loader reads every projected `SKILL.md` at session start
 * (`skillsLoading: "eager"`) cannot be handed the real body by symlink: N links
 * cost N bodies of context before the first turn (~200K tokens across the
 * current 114-skill home). It gets this instead — the skill's own frontmatter,
 * so the loader can still list and route the skill, plus a pointer to the body
 * under the Soma registry for the substrate to read once the skill is actually
 * selected.
 *
 * The provenance comment sits AFTER the frontmatter, not before it. YAML
 * frontmatter is only frontmatter when it is the first thing in the file, so the
 * usual leading `withProvenance` header would make the stub unparseable by the
 * very loader it is written for.
 *
 * No timestamp, same as {@link provenanceHeader}: reprojecting twice with
 * unchanged sources must produce byte-identical output, which is also what lets
 * `ensureSkillStub` report `unchanged` instead of rewriting every stub on every
 * install.
 */

/**
 * Identifies a Soma-generated stub. Reprojection may replace a directory
 * carrying this marker in place; a directory without it is user data and is
 * guarded by `force`, exactly as a non-symlink is in `ensureSymlink`.
 */
export const SKILL_STUB_MARKER = "soma:skill-stub";

export interface SkillStubOptions {
  /** Verbatim frontmatter of the source SKILL.md, without its `---` fences. */
  frontmatter: string;
  /** Absolute path to the real SKILL.md under the Soma skill registry. */
  bodyPath: string;
  /** Substrate this stub is projected for; named in the provenance line. */
  substrate: string;
}

export function renderSkillStub(options: SkillStubOptions): string {
  return [
    "---",
    options.frontmatter,
    "---",
    "",
    `<!-- ${PROVENANCE_MARKER} (${SKILL_STUB_MARKER}, soma install ${options.substrate}). ` +
      "Source of truth: ~/.soma. Do not edit by hand. -->",
    "",
    "## Body not loaded",
    "",
    `Full instructions: \`${options.bodyPath}\``,
    "",
    "Read that file before acting on this skill. This projection carries",
    "frontmatter only, so the loader can list and route the skill without",
    "holding its body in context (soma#542).",
    "",
  ].join("\n");
}

/** True when `content` is a Soma-generated skill stub. */
export function isSkillStub(content: string): boolean {
  return content.includes(SKILL_STUB_MARKER);
}
