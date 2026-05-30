/**
 * #115 Phase 2 — per-skill substrate static-shape verifier for
 * `soma migrate claude-skills --smoke <substrate>`.
 *
 * Contract:
 *   - Given an imported skill (already written under `<somaHome>/
 *     skills/<kebab>/`), project it into the target substrate's
 *     skill surface using the existing adapter machinery.
 *   - Run a fixed set of STATIC shape checks against the projection
 *     bytes. No substrate process is spawned. No execution.
 *   - Return a `ClaudeSkillSubstrateVerifyResult` carrying status
 *     (verified / verified-with-warnings / failed) and the full
 *     issue list.
 *
 * Reuse vs rebuild (Phase-2 hard rule):
 *   - Codex projection: mirrors `projectCodexHome`'s per-skill flat
 *     `skills/<name>/<rel>` layout. We call into a thin re-use helper
 *     that maps each `SomaSkill` file to `skills/<id>/<rel>`. We do
 *     NOT re-implement the layout; the helper is exported from
 *     `./adapters/codex/skill-projection`.
 *   - Pi.dev projection: calls into `buildPiDevPortableSkillFiles`
 *     directly. Same byte-for-byte projection as the live installer.
 *
 * Shape checks (deterministic, ordered):
 *   1. The projection didn't throw (e.g. `buildPiDevPortableSkillFiles`
 *      throws on id collisions; we treat that as `failed`).
 *   2. The projection produced at least one file (non-empty).
 *   3. No projected file is unreasonably large (sanity threshold
 *      configurable; default 5 MiB per file).
 *   4. The projected SKILL.md (per-substrate equivalent) parses as
 *      Markdown with YAML frontmatter when the source had one. The
 *      parser is intentionally lenient — it accepts missing
 *      frontmatter on prose files but flags a malformed delimiter
 *      pair.
 *   5. Required metadata: when source SKILL.md has frontmatter, the
 *      projected SKILL.md must keep the same `name`/`description`
 *      fields. A missing or mismatched `description` is an error;
 *      `name` mismatch is also error (substrate-id rewrite is fine
 *      as long as the field is present).
 *   6. No dangling internal refs: `~/.claude/` or `~/.soma/` path
 *      fragments that don't resolve under the imported subtree are
 *      flagged. We only check refs that POINT INTO THE SKILL
 *      ITSELF — references to global Soma roots (`~/.soma/memory/`,
 *      `~/.soma/profile/`) are accepted, since the projection
 *      isn't expected to embed those into the skill payload.
 *   7. Substrate-only primitives: hook bindings or slash-command
 *      refs that survive the rewriter and would be meaningless in
 *      the target substrate (Codex has no `Stop:` surface; Pi.dev
 *      has no `/<slash>` user-facing surface). These are errors
 *      because the projection is what the substrate would consume.
 *   8. Long-body warning: a `SKILL.md` body exceeding 80 KB in the
 *      projection trips a `long-body` warning (not error). Substrates
 *      accept it but interaction with model context windows degrades.
 *
 * Severity → status mapping:
 *   - any `error` → `failed`
 *   - else any `warning` → `verified-with-warnings`
 *   - else → `verified`
 *
 * Idempotency:
 *   - Pure function of `(SomaSkill, substrate)`. No filesystem state.
 *   - The migrator caller threads idempotency via prior-manifest
 *     `substrates[substrate].status === "verified"` → skip
 *     re-verify. `verified-with-warnings` and `failed` are always
 *     re-run.
 */
import type {
  ClaudeSkillSubstrateVerifyIssue,
  ClaudeSkillSubstrateVerifyResult,
  ClaudeSkillsSmokeSubstrate,
  SomaSkill,
} from "./types";
import { buildPiDevPortableSkillFiles } from "./adapters/pi-dev";

// Shared frontmatter regex + quote-stripping — single source of truth
// across migrator + verifier.
import { FRONTMATTER_RE, stripQuotes } from "./claude-skills-frontmatter";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB sanity per file.
const LONG_BODY_BYTES = 80 * 1024; // 80 KiB SKILL.md body warning.

interface ProjectedFile {
  path: string;
  content: string;
}

/**
 * Codex per-skill projection mirror. The Codex adapter projects
 * portable skills as `skills/<rawName>/<relPath>` files (see
 * `projectCodexHome`). For verify we project ONE skill at a time so
 * the issue lines can pin a substrate file path back to a single
 * skill name without searching the projection list.
 *
 * No collision check here — that's a multi-skill concern; the verify
 * surface is per-skill so collisions can't occur within one call.
 */
function projectCodexSkillForVerify(skill: SomaSkill): ProjectedFile[] {
  return (skill.files ?? []).map((file) => ({
    path: `skills/${skill.name}/${file.path}`,
    content: file.content,
  }));
}

/**
 * Pi.dev per-skill projection: reuse the existing
 * `buildPiDevPortableSkillFiles` helper with a single-skill list.
 * The helper handles id slug normalization + frontmatter rewrite.
 */
function projectPiDevSkillForVerify(skill: SomaSkill): ProjectedFile[] {
  return buildPiDevPortableSkillFiles([skill]).map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

/**
 * Locate the substrate-equivalent "SKILL.md" in a projection. Both
 * substrates currently project SKILL.md at the leaf of the skill's
 * own directory. We accept any path whose basename is `SKILL.md`.
 */
function findSkillMd(files: readonly ProjectedFile[]): ProjectedFile | undefined {
  return files.find((file) => /(^|\/)SKILL\.md$/.test(file.path));
}

interface FrontmatterFields {
  hasFrontmatter: boolean;
  parsed: boolean;
  name?: string;
  description?: string;
}

/**
 * Lenient YAML-ish frontmatter parser for the verify layer. We only
 * pull `name:` and `description:` because those are the two fields
 * shape-check rules 4 + 5 depend on. Multi-line values (folded
 * scalars, etc.) are NOT supported — substrate projection skill
 * frontmatter is single-line per the live convention.
 */
function parseFrontmatter(content: string): FrontmatterFields {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { hasFrontmatter: false, parsed: true };

  const body = match[1];
  // Trivial well-formedness probe: every non-empty, non-comment line
  // must look like `key:` or `key: value` or `- list item`. We don't
  // try to ENFORCE valid YAML, just rule out wholly garbled bodies
  // (e.g. a missing closing delimiter that the FRONTMATTER_RE caught
  // as best-effort).
  const lines = body.split(/\r?\n/);
  let nameValue: string | undefined;
  let descriptionValue: string | undefined;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("  ") || line.startsWith("\t") || line.startsWith("- ")) {
      // Nested/list line — accepted, no extraction.
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      return { hasFrontmatter: true, parsed: false };
    }
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "name") nameValue = stripQuotes(value);
    else if (key === "description") descriptionValue = stripQuotes(value);
  }
  return {
    hasFrontmatter: true,
    parsed: true,
    name: nameValue,
    description: descriptionValue,
  };
}

/**
 * Substrate-only primitive scan. We re-use the same shape as the
 * Phase-1 classifier but operate on the PROJECTED bytes (which may
 * differ from source after the rewriter ran).
 */
const HOOK_BINDING_RE = /^[\s>*-]*(?:Stop|UserPromptSubmit|PreToolUse|PostToolUse|SessionStart|SubagentStop|Notification|PreCompact)\s*:/m;
const SLASH_COMMAND_RE = /(?:^|[\s([`])\/(?:e[1-5]|[a-z][a-z0-9-]{1,})(?:[\s.,;)\]`?!]|$)/m;
const CLAUDE_HOME_RE = /~\/\.claude\/[a-zA-Z0-9_\-./]+/g;
const SOMA_HOME_INTERNAL_RE = /~\/\.soma\/UNMAPPED\/[a-zA-Z0-9_\-./]+/g;

function stripCodeBlocks(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "");
}

const PROSE_EXTENSIONS = /\.(md|markdown|txt|mdx)$/i;
function isProseFile(relPath: string): boolean {
  return PROSE_EXTENSIONS.test(relPath);
}

export interface VerifySkillInput {
  // The imported skill, in the SomaSkill shape the adapters consume.
  // `path` is informational only; the verify layer reads only
  // `name` (used for substrate id derivation) and `files`.
  skill: SomaSkill;
  substrate: ClaudeSkillsSmokeSubstrate;
  // Source frontmatter description for the `description-mismatch`
  // check. When undefined the check is skipped (skill had no
  // frontmatter description on the source side, so a mismatch is
  // not meaningful).
  sourceDescription?: string;
}

export function verifySubstrateProjection(
  input: VerifySkillInput,
): ClaudeSkillSubstrateVerifyResult {
  const { skill, substrate, sourceDescription } = input;
  const issues: ClaudeSkillSubstrateVerifyIssue[] = [];

  // Step 1: project (may throw — see Pi.dev id-collision contract).
  let projected: ProjectedFile[];
  try {
    projected = substrate === "codex"
      ? projectCodexSkillForVerify(skill)
      : projectPiDevSkillForVerify(skill);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({
      kind: "projection-throw",
      severity: "error",
      message: `${substrate} projection threw: ${message.slice(0, 256)}`,
    });
    return finalize(substrate, issues);
  }

  // Step 2: non-empty projection.
  if (projected.length === 0) {
    issues.push({
      kind: "empty-projection",
      severity: "error",
      message: `${substrate} projection produced zero files`,
    });
    return finalize(substrate, issues);
  }

  // Step 3: oversized projection (per-file sanity).
  for (const file of projected) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      issues.push({
        kind: "oversized-projection",
        severity: "error",
        message: `${file.path} exceeds ${MAX_FILE_BYTES} byte sanity limit (${bytes})`,
        file: file.path,
      });
    }
  }

  // #126: executable TypeScript helpers under Tools/ are part of
  // the skill's runtime surface. The smoke verifier does not execute
  // them, but it must prove that projection kept the file and that
  // the projected payload is non-empty.
  const projectedToolByRelPath = new Map<string, ProjectedFile>();
  for (const file of projected) {
    const match = /(?:^|\/)(Tools\/.*\.ts)$/i.exec(file.path);
    if (match) projectedToolByRelPath.set(match[1], file);
  }
  for (const file of skill.files ?? []) {
    if (!/^Tools\/.*\.ts$/i.test(file.path)) continue;
    const projectedTool = projectedToolByRelPath.get(file.path);
    const expected = substrate === "codex"
      ? `skills/${skill.name}/${file.path}`
      : `agent/skills/<skill-id>/${file.path}`;
    if (!projectedTool) {
      issues.push({
        kind: "unresolved-tool-path",
        severity: "warning",
        message: `${expected} is missing from ${substrate} projection`,
        file: expected,
      });
      continue;
    }
    if (Buffer.byteLength(projectedTool.content, "utf8") === 0) {
      issues.push({
        kind: "unresolved-tool-path",
        severity: "warning",
        message: `${expected} is empty in ${substrate} projection`,
        file: expected,
      });
    }
  }

  // Step 4: SKILL.md frontmatter parsability + metadata.
  const skillMd = findSkillMd(projected);
  let fm: FrontmatterFields | undefined;
  if (skillMd) {
    fm = parseFrontmatter(skillMd.content);
    if (fm.hasFrontmatter && !fm.parsed) {
      issues.push({
        kind: "frontmatter-unparseable",
        severity: "error",
        message: `${skillMd.path} frontmatter has a malformed line`,
        file: skillMd.path,
      });
    } else if (fm.hasFrontmatter) {
      // Step 5: required metadata.
      if (!fm.name || fm.name.length === 0) {
        issues.push({
          kind: "missing-name",
          severity: "error",
          message: `${skillMd.path} frontmatter is missing a name field`,
          file: skillMd.path,
        });
      }
      if (!fm.description || fm.description.length === 0) {
        issues.push({
          kind: "missing-description",
          severity: "error",
          message: `${skillMd.path} frontmatter is missing a description field`,
          file: skillMd.path,
        });
      } else if (
        sourceDescription !== undefined &&
        sourceDescription.length > 0 &&
        fm.description !== sourceDescription
      ) {
        issues.push({
          kind: "description-mismatch",
          severity: "error",
          message: `${skillMd.path} description differs from source`,
          file: skillMd.path,
        });
      }
    }
    // Step 8: long-body warning.
    const bytes = Buffer.byteLength(skillMd.content, "utf8");
    if (bytes > LONG_BODY_BYTES) {
      issues.push({
        kind: "long-body",
        severity: "warning",
        message: `${skillMd.path} body is ${bytes} bytes (over ${LONG_BODY_BYTES} threshold)`,
        file: skillMd.path,
      });
    }
  }

  // Step 6 + 7: scan every projected prose file for dangling refs and
  // substrate-incompatible primitives.
  for (const file of projected) {
    const text = file.content;

    // Substrate-only primitives apply on prose files. Hook bindings
    // are an error in both target substrates because neither has a
    // `Stop:`/`UserPromptSubmit:` surface that matches Claude Code's
    // primitive. Slash-command references in projected prose are
    // ALSO errors because the projection is what the substrate
    // would consume — a `/grill-me` reference inside a Codex skill
    // is dead text at best, principal-confusing at worst.
    if (isProseFile(file.path)) {
      if (HOOK_BINDING_RE.test(text)) {
        issues.push({
          kind: "substrate-only-primitive",
          severity: "error",
          message: `${file.path} carries a hook binding (no ${substrate} equivalent)`,
          file: file.path,
        });
      }
      const stripped = stripCodeBlocks(text);
      if (SLASH_COMMAND_RE.test(stripped)) {
        const sample = SLASH_COMMAND_RE.exec(stripped)?.[0]?.trim() ?? "/slash";
        issues.push({
          kind: "substrate-only-primitive",
          severity: "error",
          message: `${file.path} carries a Claude slash-command reference (${sample.slice(0, 24)})`,
          file: file.path,
        });
      }
    }

    // Dangling internal refs. Two flavors are reported:
    //   (a) `~/.claude/...` survived the rewriter (the normalizer
    //       should have caught these in needs-adapt skills; for
    //       `portable` skills they would never have existed).
    //   (b) `~/.soma/UNMAPPED/...` — the normalizer's catch-all
    //       fallback. These are NEVER actual paths on disk, so
    //       carrying them into a substrate projection is dangling
    //       by definition.
    let claudeMatch: RegExpExecArray | null;
    CLAUDE_HOME_RE.lastIndex = 0;
    while ((claudeMatch = CLAUDE_HOME_RE.exec(text)) !== null) {
      issues.push({
        kind: "dangling-internal-ref",
        severity: "error",
        message: `${file.path} contains an unrewritten Claude path: ${claudeMatch[0].slice(0, 60)}`,
        file: file.path,
      });
      if (CLAUDE_HOME_RE.lastIndex === claudeMatch.index) CLAUDE_HOME_RE.lastIndex += 1;
      break; // First match is enough; verbose dumps belong in audit, not summary.
    }
    let unmappedMatch: RegExpExecArray | null;
    SOMA_HOME_INTERNAL_RE.lastIndex = 0;
    while ((unmappedMatch = SOMA_HOME_INTERNAL_RE.exec(text)) !== null) {
      issues.push({
        kind: "dangling-internal-ref",
        severity: "warning",
        message: `${file.path} contains an unmapped fallback path: ${unmappedMatch[0].slice(0, 60)}`,
        file: file.path,
      });
      if (SOMA_HOME_INTERNAL_RE.lastIndex === unmappedMatch.index) SOMA_HOME_INTERNAL_RE.lastIndex += 1;
      break;
    }
  }

  return finalize(substrate, issues);
}

function finalize(
  substrate: ClaudeSkillsSmokeSubstrate,
  issues: readonly ClaudeSkillSubstrateVerifyIssue[],
): ClaudeSkillSubstrateVerifyResult {
  const hasError = issues.some((issue) => issue.severity === "error");
  const hasWarning = issues.some((issue) => issue.severity === "warning");

  let status: ClaudeSkillSubstrateVerifyResult["status"];
  let reason: string;
  if (hasError) {
    status = "failed";
    const first = issues.find((issue) => issue.severity === "error");
    reason = first?.message ?? "shape check failed";
  } else if (hasWarning) {
    status = "verified-with-warnings";
    const first = issues.find((issue) => issue.severity === "warning");
    reason = first?.message ?? "shape check produced warnings";
  } else {
    status = "verified";
    reason = "ok";
  }

  return {
    substrate,
    status,
    reason,
    issues: [...issues],
  };
}
