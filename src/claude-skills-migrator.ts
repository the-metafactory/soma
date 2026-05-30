/**
 * #115 — `soma migrate claude-skills` (Phase 1).
 *
 * Second migration path alongside `soma migrate pai`. Imports directly
 * from an installed flat `.claude/skills/` tree:
 *   - One `<Name>/SKILL.md` per skill, no pack-level metadata.
 *   - No collection bundles (no nested-skill duplicates → no collisions
 *     by construction).
 *   - Per-skill payload typically includes `Workflows/`, `Tools/`,
 *     `References/`, `Examples/` siblings.
 *
 * Per-skill pipeline:
 *   1. Read `<from>/<Name>/SKILL.md`, walk the skill body recursively.
 *   2. Classify portability (heuristic, regex-based):
 *        - `portable`        — no `~/.claude/` refs, no hook bindings,
 *                              no `/<slash-command>` prose refs.
 *        - `needs-adapt`     — `~/.claude/...` paths the pai-pack
 *                              normalizer can deterministically rewrite.
 *        - `claude-specific` — hook bindings or slash commands; no
 *                              portable equivalent.
 *   3. Apply rewrites (for `needs-adapt`) via the existing
 *      `normalizeSkillContent` pipeline.
 *   4. Write to `<somaHome>/skills/<kebab>/`, mirroring siblings.
 *   5. Skip `claude-specific` unless `includeClaudeSpecific` is set.
 *
 * Idempotency:
 *   - SHA-256 of the source SKILL.md is the per-skill identity key.
 *   - Re-running with unchanged source → zero writes, manifest
 *     `importedAt` preserved.
 *
 * Phase 2 (deferred — separate PR): `--smoke <substrate>` per-skill
 * projection verify against Codex / Pi.dev substrate projectors.
 *
 * Boundaries (same as `pai-pack-normalizer.ts`):
 *   - No LLM rewrites.
 *   - No personal/private inference.
 *   - No execution of embedded commands.
 *   - The classifier is HEURISTIC — regex pattern match, not semantic
 *     analysis. Its limits are documented in the portability report
 *     header.
 */
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { kebabSlug } from "./pai-pack-slug";
import { normalizeSkillContent } from "./pai-pack-normalizer";
import { EDITOR_CONFIG_DIRS } from "./pai-pack-noise";
import { runBoundedConcurrent } from "./internal-concurrency";
import { verifySubstrateProjection } from "./claude-skills-substrate-verify";
import type {
  ClaudeSkillAuditEntry,
  ClaudeSkillDependency,
  ClaudeSkillDescriptionRewrite,
  ClaudeSkillOutcome,
  ClaudeSkillPortabilityTag,
  ClaudeSkillSubstrateVerifyResult,
  ClaudeSkillSubstrateVerifySummary,
  ClaudeSkillsMigrationManifest,
  ClaudeSkillsMigrationManifestEntry,
  ClaudeSkillsMigrationManifestLastRun,
  ClaudeSkillsMigrationManifestOutcome,
  ClaudeSkillsMigrationOptions,
  ClaudeSkillsMigrationPlan,
  ClaudeSkillsMigrationResult,
  ClaudeSkillsSmokeSubstrate,
  DescriptionStatus,
  RewriteDescriptionsAgent,
  RewriteDispatchOverride,
  SomaSkill,
} from "./types";
import {
  classifyDescriptionStatus,
  DEFAULT_REWRITE_TARGET,
  defaultRewriteDispatch,
  sanitizeRewrittenDescription,
  sha256Utf8,
  SUBSTRATE_DESCRIPTION_LIMIT,
} from "./claude-skill-description-rewriter";
import { createNoopProgressEmitter, type PhaseTimings, type ProgressEmitter } from "./claude-skills-progress";

const MANIFEST_SCHEMA = "soma.claude-skills-migration.v1";
const MANIFEST_RELATIVE = "imports/claude-skills/.manifest.json";
const REPORT_RELATIVE = "imports/claude-skills/.portability-report.md";

// #115 Phase 2 — `--smoke` substrate de-dup + validation. Caller is
// responsible for resolving the `all` keyword to the substrate list
// at parse time; this helper only de-dupes + sorts so the order in
// the report / manifest is byte-stable.
const ALL_SMOKE_SUBSTRATES: readonly ClaudeSkillsSmokeSubstrate[] = ["codex", "pi-dev"];
function normalizeSmokeSubstrates(
  raw: readonly ClaudeSkillsSmokeSubstrate[] | undefined,
): ClaudeSkillsSmokeSubstrate[] {
  if (!raw || raw.length === 0) return [];
  const set = new Set<ClaudeSkillsSmokeSubstrate>();
  for (const sub of raw) {
    set.add(sub);
  }
  // Preserve the canonical order so report column order is stable.
  return ALL_SMOKE_SUBSTRATES.filter((sub) => set.has(sub));
}

type ConcreteRewriteDescriptionsAgent = Exclude<RewriteDescriptionsAgent, "none" | "auto">;

function resolveRewriteDescriptionsAgent(agent: Exclude<RewriteDescriptionsAgent, "none">): ConcreteRewriteDescriptionsAgent {
  return agent === "auto" ? "codex" : agent;
}

// Parse the front-matter description of a source SKILL.md so the
// per-substrate verifier can run the description-mismatch check
// against the projected SKILL.md. The Pi.dev projector rewrites the
// `name` field but not `description`, so a missing/changed
// description after projection is a meaningful blocker.
//
// Shared frontmatter helpers — single source of truth for description
// extraction across the migrator + verifier. See
// `./claude-skills-frontmatter.ts` for the contract and reach.
import {
  findFrontmatterBlockScalarEndIndex,
  FRONTMATTER_RE,
  isFrontmatterBlockScalarMarker,
  parseDescriptionFromFrontmatter as parseSourceDescription,
} from "./claude-skills-frontmatter";

/**
 * Materialize an imported skill as a `SomaSkill`-shaped object so
 * the verifier can re-use existing substrate projection helpers.
 *
 * `name` is the source directory name (preserves casing for codex
 * file paths; the Pi.dev projector lowercases via `piDevSkillId`).
 */
function buildSomaSkillFromPayload(
  sourceName: string,
  rewrittenFiles: { relPath: string; content: Buffer }[],
): SomaSkill {
  const skillMd = rewrittenFiles.find((f) => f.relPath === "SKILL.md");
  const description = skillMd ? parseSourceDescription(skillMd.content.toString("utf8")) ?? "" : "";
  return {
    name: sourceName,
    path: sourceName,
    description,
    triggers: [],
    files: rewrittenFiles.map((file) => ({
      path: file.relPath,
      content: file.content.toString("utf8"),
    })),
  };
}

// #104 parallel — editor-config symlinks (`.cursor/`, `.vscode/`,
// `.idea/`, `.fleet/`, `.zed/`) ship inside many PAI skills and are
// resolved on the principal's box to IDE-specific rule files. Treat
// them as benign noise: drop them from the import set instead of
// refusing the skill. Every OTHER symlink still refuses loud.
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sourceSkillKebabName(sourceName: string): string {
  return kebabSlug(sourceName);
}
const EDITOR_CONFIG_SYMLINK_PATTERNS: { pattern: RegExp; dir: string }[] = EDITOR_CONFIG_DIRS.map((dir) => ({
  pattern: new RegExp(`(?:^|/)${escapeRegex(dir)}/`),
  dir,
}));
function matchEditorConfigSymlinkDir(relativePosixPath: string): string | null {
  for (const { pattern, dir } of EDITOR_CONFIG_SYMLINK_PATTERNS) {
    if (pattern.test(relativePosixPath)) return dir;
  }
  return null;
}

// AC-4: classifier rules. Phase 1 is HEURISTIC — every signal below is
// a deterministic regex match against the on-disk bytes of the skill's
// body files (SKILL.md + every recursive markdown / text payload).
//
// 1) `~/.claude/...` path refs trigger the `needs-adapt`/`portable`
//    split. The pai-pack normalizer's deterministic rewrite table
//    (`pai-pack-normalizer.ts` CLAUDE_HOME_DETERMINISTIC) is the
//    authority on what "needs-adapt" actually means — a skill whose
//    only Claude refs map cleanly via that table is `needs-adapt`.
//    Anything beyond it falls back through the normalizer's
//    UNMAPPED catch-all, which is still "deterministic enough" for
//    Phase 1 — the catch-all rewrites to `~/.soma/UNMAPPED/` and
//    surfaces a warning. So for classifier purposes ANY `~/.claude/`
//    reference (that isn't accompanied by a `claude-specific` signal)
//    makes the skill `needs-adapt`.
const CLAUDE_PATH_REF = /~\/\.claude\b/;

// 2) Hook bindings — Claude-Code-only primitive. Match a line that
//    begins with one of the lifecycle hook names followed by `:`.
//    Anchored to start-of-line (after optional whitespace) so prose
//    mentions like "the `Stop:` hook" inside a paragraph don't fire.
//    The `m` flag is required because we test against multi-line
//    file contents.
const HOOK_BINDING = /^[\s>*-]*(?:Stop|UserPromptSubmit|PreToolUse|PostToolUse|SessionStart|SubagentStop|Notification|PreCompact)\s*:/m;

// 3) Slash-command refs in prose — Claude Code's user-facing slash
//    commands like `/clear`, `/init`, `/grill-me`, `/e3`. Pattern
//    constraints:
//      - Preceded by start-of-line, whitespace, or `(` / `[` so we
//        match prose like "run /clear" and "(/init)" but NOT path
//        fragments like `~/.claude/...` or `https://...`.
//      - At least 2 chars after the slash (avoid /a one-off
//        false positives in code).
//      - Excluded inside fenced code blocks — those are usually
//        bash / curl examples (URLs, CLI flags) and trigger false
//        positives. Stripping fenced code blocks before the test
//        is the simplest deterministic filter.
//      - Allow letters/digits/hyphens after the slash, no `/` (so
//        URL paths don't match) and no `.` (so file paths like
//        `/some.json` don't match).
const SLASH_COMMAND_REF = /(?:^|[\s([`])\/(?:e[1-5]|[a-z][a-z0-9-]{1,})(?:[\s.,;)\]`?!]|$)/m;

// Strip fenced code blocks (``` … ```) and inline code (`…`) from
// content before running the slash-command test. Both are common
// hosts for shell command examples that contain `/some-flag` or
// URL paths — neither should classify the skill as Claude-specific.
function stripCodeBlocks(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "");
}

function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function resolveHomes(options: ClaudeSkillsMigrationOptions): { somaHome: string; from: string } {
  if (!options.from) {
    throw new Error("soma migrate claude-skills requires --from <skills-dir>.");
  }
  const home = resolve(options.homeDir ?? homedir());
  return {
    from: resolve(options.from),
    somaHome: resolve(options.somaHome ?? join(home, ".soma")),
  };
}

// `--status` mode doesn't need a `--from` (it reads the manifest of a
// prior apply). Lighter resolver that only computes `somaHome`.
function resolveSomaHomeOnly(options: ClaudeSkillsMigrationOptions): string {
  const home = resolve(options.homeDir ?? homedir());
  return resolve(options.somaHome ?? join(home, ".soma"));
}

function isWithinPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface SkillFilePayload {
  // POSIX-style relative path inside the skill directory.
  relPath: string;
  // Absolute source path.
  source: string;
  // Raw bytes (used for SHA + classification + rewrite).
  content: Buffer;
}

// #118 — `realpath`-anchored security denylist for resolved symlink
// targets. Even when a symlink chain resolves inside `$HOME`, paths
// that almost certainly carry credentials (`.ssh/`, cloud-CLI creds,
// the active user's keyring directories) must NEVER be slurped into
// a Soma skill import. The list mirrors the existing secret-file
// patterns in `pai-pack-importer.ts` (SECRET_FILE_PATTERNS) but
// operates on the resolved target directory.
//
// Keep this list narrow — every entry widens the refusal envelope.
// All entries are POSIX-style path segments anchored to `$HOME`.
const HOME_SUBPATH_DENYLIST: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
];

/**
 * #118 — safely resolve a symlink target and answer two questions:
 *   1. Does its realpath stay within `$HOME` (and outside the denylist)?
 *   2. Is the resolved target a file, a directory, or broken?
 *
 * Uses `realpath` so multi-hop symlink chains can't escape `$HOME` via
 * a symlink-to-symlink hop. Cycle detection is the caller's responsibility
 * (it threads a `visitedRealPaths` Set keyed per-walk).
 *
 * Error semantics: every failure is returned as `{ refused: <kind> }`
 * so the caller can decide whether to throw, audit, or skip. Never
 * throws on its own.
 */
type SymlinkResolution =
  | { refused: "outside-home"; reason: string }
  | { refused: "broken"; reason: string }
  | { refused: "cycle"; reason: string }
  | { refused: "denylist"; reason: string }
  | { kind: "file" | "dir"; realPath: string };

async function resolveSymlinkSafely(
  absPath: string,
  homeRealPath: string,
  visitedRealPaths: Set<string>,
): Promise<SymlinkResolution> {
  let realPath: string;
  try {
    realPath = await realpath(absPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { refused: "broken", reason: `symlink target does not exist (broken link): ${absPath}` };
    }
    // ELOOP — kernel-level symlink loop. We surface as cycle so the
    // refusal message stays consistent with the per-walk detection
    // path below.
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ELOOP") {
      return { refused: "cycle", reason: `symlink loop detected by kernel: ${absPath}` };
    }
    throw error;
  }
  // Boundary check — exact `homeRealPath` is allowed (a symlink that
  // points AT $HOME itself is benign), every descendant must sit
  // under `homeRealPath + sep`.
  if (realPath !== homeRealPath && !realPath.startsWith(`${homeRealPath}${sep}`)) {
    return { refused: "outside-home", reason: `symlink target resolves outside $HOME: ${realPath}` };
  }
  // Denylist check — `<$HOME>/.ssh/...`, `<$HOME>/.aws/...`, etc.
  const homeRel = relative(homeRealPath, realPath);
  const firstSegment = homeRel.split(sep)[0] ?? "";
  if (HOME_SUBPATH_DENYLIST.includes(firstSegment)) {
    return { refused: "denylist", reason: `symlink target resolves into denylisted home subpath: ${realPath}` };
  }
  // Per-walk cycle detection. Once we've recorded this realpath, a
  // second encounter inside the same walk means we're chasing a loop
  // that didn't trip the kernel's ELOOP check (multi-hop dir cycle).
  if (visitedRealPaths.has(realPath)) {
    return { refused: "cycle", reason: `symlink cycle detected (revisited target): ${realPath}` };
  }
  // Stat the resolved target so the caller can decide file vs dir
  // routing. We use the same Bun-friendly `lstat` then promote to
  // file/dir from the realpath stat to keep the cost minimal — one
  // extra stat per symlink resolution, never on the hot file path.
  const targetStat = await lstat(realPath);
  if (targetStat.isDirectory()) {
    return { kind: "dir", realPath };
  }
  if (targetStat.isFile()) {
    return { kind: "file", realPath };
  }
  // A device file or socket has no place in a skill import.
  return { refused: "outside-home", reason: `symlink target is not a regular file or directory: ${realPath}` };
}

/**
 * Walk every file under `<from>/<sourceName>/` recursively. Returns
 * POSIX-relative paths.
 *
 * Symlink semantics (#118 rescope):
 *   - Editor-config symlinks (`.cursor/`, `.vscode/`, etc.) silently
 *     dropped, same as before (#104 parallel).
 *   - Every other symlink resolves via `realpath`:
 *       - target inside `$HOME` AND not denylisted → FOLLOWED. File
 *         symlinks contribute their target bytes at the symlink's
 *         relpath; directory symlinks are walked recursively.
 *       - target outside `$HOME`, broken, cyclic, or denylisted →
 *         throws so the caller can classify the containing skill as
 *         `refused-other` (log-and-continue at the per-skill layer).
 *   - Out-of-root absolute file paths still refuse — a regular file's
 *     `realpath` must stay within the source-side tree the same way
 *     pai-pack-importer enforces it.
 *
 * Per-file audit (`followed-user-owned-symlink`) is collected on the
 * returned `audit` array so the surrounding skill outcome can record
 * which symlinks were resolved.
 */
interface CollectSkillFilesResult {
  files: SkillFilePayload[];
  audit: ClaudeSkillAuditEntry[];
}

async function collectSkillFiles(
  skillDir: string,
  homeRealPath: string,
): Promise<CollectSkillFilesResult> {
  const realRoot = await realpath(skillDir);
  const out: SkillFilePayload[] = [];
  const audit: ClaudeSkillAuditEntry[] = [];
  // Per-walk cycle detection — every directory we descend records its
  // realpath here so a circular symlink chain triggers `refused: cycle`
  // before infinite recursion. We seed with the resolved skill root.
  const visitedRealPaths = new Set<string>([realRoot]);

  // `relBase` lets the caller substitute the POSIX-relative path
  // under the skill root when we recurse into a followed directory
  // symlink. Without it, a target's children would land at their
  // absolute-on-disk path; we need them at `<symlinkRel>/<childRel>`.
  //
  // `withinFollowedSymlink` flips the "within skill root" file-path
  // check off — the followed branch's children have already been
  // resolved through `realpath` and bounded to `$HOME`, which is the
  // security anchor for symlink chases. The default branch (regular
  // dir walk) keeps the strict check so a stray hardlink-out-of-root
  // file still refuses.
  async function visit(
    dir: string,
    relBase: string,
    withinFollowedSymlink: boolean,
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
      if (entry.name.includes("\\")) {
        throw new Error(`soma migrate claude-skills refused ambiguous path separator: ${rel}`);
      }
      if (entry.isSymbolicLink()) {
        // #104 parallel — editor-config symlinks are pure noise.
        if (matchEditorConfigSymlinkDir(rel)) {
          continue;
        }
        // #118 — resolve safely. User-owned (in-$HOME, non-denylisted)
        // targets are followed; everything else throws so the
        // surrounding skill classifies as `refused-other`.
        const resolved = await resolveSymlinkSafely(full, homeRealPath, visitedRealPaths);
        if ("refused" in resolved) {
          throw new Error(
            `soma migrate claude-skills refused symlink path: ${rel} — ${resolved.reason}`,
          );
        }
        // Record audit entry — one per symlink resolution, regardless
        // of file vs dir. The audit is per-skill; the surrounding skill
        // outcome will surface this in the portability report.
        audit.push({
          kind: "followed-user-owned-symlink",
          relPath: rel,
          detail: resolved.realPath,
        });
        // Mark this target as visited so a later symlink under a
        // descendant pointing back into this subtree triggers cycle
        // refusal instead of infinite walk.
        visitedRealPaths.add(resolved.realPath);
        if (resolved.kind === "file") {
          const content = await readFile(resolved.realPath);
          out.push({ relPath: rel, source: resolved.realPath, content });
          continue;
        }
        // Directory: recurse into the resolved target, but anchor the
        // POSIX-relative path namespace at the symlink's `rel` so
        // children land under `<rel>/<childName>`. From here down, the
        // strict within-skill-root check is relaxed — children live
        // under the followed target, not the skill root, and the
        // resolveSymlinkSafely call above already enforced the
        // $HOME boundary on the resolved target.
        await visit(resolved.realPath, rel, true);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".hg" || entry.name === ".svn") {
          // #118 — VCS metadata dirs are still refused at the source-
          // skill root (a Claude skill should never carry an inline
          // `.git/`). Inside a followed user-owned symlink branch
          // (which is, by construction, a separate worktree the user
          // is developing alongside their Claude skill), `.git/` is
          // expected; we silently skip it so the followed skill can
          // import without poisoning the surrounding outcome.
          if (withinFollowedSymlink) {
            continue;
          }
          throw new Error(`soma migrate claude-skills refused VCS metadata directory: ${rel}`);
        }
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") {
          continue;
        }
        // Skip editor-config directories outright (regular dirs, not
        // symlinks). They carry no portable skill content.
        if ((EDITOR_CONFIG_DIRS as readonly string[]).includes(entry.name)) {
          continue;
        }
        // Cycle bookkeeping for plain dirs too — cheap and protects
        // against bind-mount-style hard-link cycles (rare on macOS
        // but POSIX permits them).
        const realDir = await realpath(full);
        if (visitedRealPaths.has(realDir)) {
          throw new Error(
            `soma migrate claude-skills refused symlink path: ${rel} — directory cycle detected at ${realDir}`,
          );
        }
        visitedRealPaths.add(realDir);
        await visit(full, rel, withinFollowedSymlink);
        continue;
      }
      if (entry.isFile()) {
        if (!withinFollowedSymlink) {
          // Strict within-root check only applies outside the followed-
          // symlink branch. Inside it, the safe-resolve helper already
          // bounded the target to `$HOME`.
          const realFile = await realpath(full);
          if (!isWithinPath(realRoot, realFile)) {
            throw new Error(`soma migrate claude-skills refused path outside skill root: ${rel}`);
          }
        }
        const content = await readFile(full);
        out.push({ relPath: rel, source: full, content });
      }
    }
  }

  await visit(skillDir, "", false);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  audit.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files: out, audit };
}

/**
 * Classify a skill against the Phase 1 heuristic rules.
 *
 * Inputs are all the payload files for the skill. We test:
 *   - any hook binding match → `claude-specific`
 *   - any slash-command-in-prose match → `claude-specific`
 *   - any `~/.claude/` reference → `needs-adapt`
 *   - else → `portable`
 *
 * Reason string captures the first triggering signal with its file path,
 * matching the table the issue spec calls for in the portability report.
 */
export interface ClassificationResult {
  tag: ClaudeSkillPortabilityTag;
  reason: string;
}

// Slash-command classification ONLY fires on prose surfaces — Markdown
// SKILL.md / Workflows / References. Code files (`.ts`, `.js`, `.py`,
// shell, etc.) routinely embed `/path/...` fragments, Discord command
// names like `/imagine`, and URL paths that have nothing to do with
// Claude Code's slash-command surface. The Phase-1 classifier is
// heuristic and the cost of a false-positive `claude-specific` verdict
// is high (the skill gets skipped on apply); restricting prose-only
// keeps the verdict surface tight.
const PROSE_EXTENSIONS = /\.(md|markdown|txt|mdx)$/i;

function isProseFile(relPath: string): boolean {
  return PROSE_EXTENSIONS.test(relPath);
}

export const REASON_PREFIX_HOOK_BINDING = "hook binding";
export const REASON_PREFIX_SLASH_COMMAND = "slash-command";

export function classifySkillPortability(files: readonly SkillFilePayload[]): ClassificationResult {
  // Pass 1: claude-specific signals (highest priority).
  for (const file of files) {
    const text = file.content.toString("utf8");
    if (HOOK_BINDING.test(text)) {
      const sample = HOOK_BINDING.exec(text)?.[0]?.trim() ?? "hook binding";
      return {
        tag: "claude-specific",
        reason: `${REASON_PREFIX_HOOK_BINDING} detected in ${file.relPath} (${sample.slice(0, 32)})`,
      };
    }
    if (!isProseFile(file.relPath)) continue;
    const stripped = stripCodeBlocks(text);
    if (SLASH_COMMAND_REF.test(stripped)) {
      const sample = SLASH_COMMAND_REF.exec(stripped)?.[0]?.trim() ?? "/slash-command";
      return {
        tag: "claude-specific",
        reason: `${REASON_PREFIX_SLASH_COMMAND} reference detected in ${file.relPath} (${sample.slice(0, 32)})`,
      };
    }
  }

  // Pass 2: needs-adapt signals.
  let firstClaudeRef: { file: string; count: number } | null = null;
  for (const file of files) {
    const text = file.content.toString("utf8");
    // Count `~/.claude` matches in this file (cheap; only used when
    // we already know we're going to surface a reason).
    let count = 0;
    let m: RegExpExecArray | null;
    const scanner = /~\/\.claude\b/g;
    while ((m = scanner.exec(text)) !== null) {
      count += 1;
      if (scanner.lastIndex === m.index) scanner.lastIndex += 1;
    }
    if (count > 0) {
      if (!firstClaudeRef) {
        firstClaudeRef = { file: file.relPath, count };
      } else {
        firstClaudeRef.count += count;
      }
    }
  }
  if (firstClaudeRef) {
    return {
      tag: "needs-adapt",
      reason: `${firstClaudeRef.count} ~/.claude/* reference(s) (rewritten via normalizer)`,
    };
  }
  // Else portable.
  return { tag: "portable", reason: "clean" };
}

const CLAUDE_SKILL_DEP_RE = /~\/\.claude\/skills\/([^/\s`"'()<>[\]{}]+)(?:\/([^\s`"'()<>[\]{}]+))?/g;
const DEPENDENCY_SCAN_EXTENSIONS = /\.(md|markdown|mdx|txt|json|yaml|yml|ts|js|tsx|jsx|mjs|cjs|py|rb|sh|bash|zsh|toml|hbs|handlebars|tmpl|tpl|xml|html|css)$/i;

function isDependencyScannableFile(file: SkillFilePayload): boolean {
  return DEPENDENCY_SCAN_EXTENSIONS.test(file.relPath) && file.content.byteLength <= 1024 * 1024;
}

function scanSkillDependencies(files: readonly SkillFilePayload[]): ClaudeSkillDependency[] {
  const bySkill = new Map<string, { references: Set<string>; sourceFiles: Set<string> }>();
  for (const file of files) {
    if (!isDependencyScannableFile(file)) continue;
    const text = file.content.toString("utf8");
    CLAUDE_SKILL_DEP_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CLAUDE_SKILL_DEP_RE.exec(text)) !== null) {
      const skill = sourceSkillKebabName(match[1]);
      const rawReference = (match as unknown as (string | undefined)[])[2] ?? "";
      const reference = rawReference.replace(/[.,;:!?]+$/g, "") || "(root)";
      let entry = bySkill.get(skill);
      if (!entry) {
        entry = { references: new Set<string>(), sourceFiles: new Set<string>() };
        bySkill.set(skill, entry);
      }
      entry.references.add(reference);
      entry.sourceFiles.add(file.relPath);
      if (CLAUDE_SKILL_DEP_RE.lastIndex === match.index) CLAUDE_SKILL_DEP_RE.lastIndex += 1;
    }
  }
  return [...bySkill.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([skill, entry]) => ({
      skill,
      references: [...entry.references].sort(),
      sourceFiles: [...entry.sourceFiles].sort(),
    }));
}

// Test-only: lower-level signal accessors. Exported so the unit
// tests can target the regex layer without rebuilding payload
// objects. The CLI-facing classifier above is the canonical entry.
export const _classifierInternals = {
  CLAUDE_PATH_REF,
  HOOK_BINDING,
  SLASH_COMMAND_REF,
  stripCodeBlocks,
} as const;

interface SourceSkillReadResult {
  sourceName: string;
  kebabName: string;
  files: SkillFilePayload[];
  sourceSha: string;
  // #118 — per-skill audit of followed symlinks. Empty array when the
  // skill walked clean. Propagated onto the ClaudeSkillOutcome via the
  // plan/apply path so the portability report can surface it.
  audit: ClaudeSkillAuditEntry[];
  // #120 — SKILL.md frontmatter description status against the 1024-
  // char substrate cap. Computed by `readSourceSkill` so both plan +
  // apply paths see the same verdict. `originalDescription` is the
  // raw text (empty string when `descriptionStatus.kind === "missing"`).
  descriptionStatus: DescriptionStatus;
  originalDescription: string;
  // SHA-256 of the original description bytes (hex). Empty when
  // status is `missing` (no source bytes to hash). Idempotency
  // anchor for the rewrite path.
  originalDescriptionSha: string;
  dependencies: ClaudeSkillDependency[];
}

async function readSourceSkill(
  fromDir: string,
  sourceName: string,
  homeRealPath: string,
): Promise<SourceSkillReadResult> {
  const skillDir = join(fromDir, sourceName);
  const skillMdPath = join(skillDir, "SKILL.md");
  if (!(await pathExists(skillMdPath))) {
    throw new Error(`soma migrate claude-skills: ${sourceName}/SKILL.md not found.`);
  }
  const rootStat = await lstat(skillDir);
  if (rootStat.isSymbolicLink()) {
    const resolvedRoot = await resolveSymlinkSafely(skillDir, homeRealPath, new Set());
    if ("refused" in resolvedRoot) {
      throw new Error(
        `soma migrate claude-skills refused symlink path: ${sourceName} — ${resolvedRoot.reason}`,
      );
    }
    if (resolvedRoot.kind !== "dir") {
      throw new Error(
        `soma migrate claude-skills refused symlink path: ${sourceName} — top-level skill symlink target is not a directory: ${resolvedRoot.realPath}`,
      );
    }
  }
  // #118 — wrap collect errors with the source skill name so the
  // refusal reason includes `<sourceName>/<rel>` per AC-4. The walker's
  // error messages all follow the shape `soma migrate claude-skills
  // refused <kind>: <rel>[ — <detail>]`; we splice the source name
  // in front of `<rel>` so principals can locate the offending path
  // without grep. Falls back to a `(in <sourceName>)` suffix when the
  // shape doesn't match.
  const { files, audit } = await collectSkillFiles(skillDir, homeRealPath).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const fixed = message.replace(
      /(soma migrate claude-skills refused [^:]+: )([^\s—]+)/,
      (_full, prefix, rel) => `${prefix}${sourceName}/${rel}`,
    );
    const finalMessage = fixed === message
      ? `${fixed} (in ${sourceName})`
      : fixed;
    throw new Error(finalMessage);
  });
  const skillMd = files.find((f) => f.relPath === "SKILL.md");
  if (!skillMd) {
    throw new Error(`soma migrate claude-skills: ${sourceName}/SKILL.md not collected (symlink? case mismatch?)`);
  }
  // Holly R1 substantive — composite source SHA covers every collected
  // file, not just SKILL.md. A sibling edit (e.g., Workflows/Run.md update,
  // new Tools/helper.ts) now flips `sourceSha` and triggers a re-import.
  // Hashing sorted `relPath:sha` pairs keeps the composite stable across
  // platforms (collectSkillFiles already returns deterministic order, but
  // the explicit sort makes the contract obvious).
  const composite = files
    .map((f) => `${f.relPath}:${sha256Hex(f.content)}`)
    .sort()
    .join("\n");
  // #120 — classify the frontmatter description against the 1024
  // substrate cap. `parseSourceDescription` returns `undefined` for
  // either no frontmatter OR no `description:` line — both collapse
  // to `missing`. A present-but-empty description (rare) classifies
  // as `ok` with length 0; substrates accept it, no rewrite needed.
  const skillMdContent = skillMd.content.toString("utf8");
  const originalDescription = parseSourceDescription(skillMdContent);
  const descriptionStatus = classifyDescriptionStatus(originalDescription);
  const originalDescriptionSha = originalDescription === undefined
    ? ""
    : sha256Utf8(originalDescription);
  return {
    sourceName,
    kebabName: sourceSkillKebabName(sourceName),
    files,
    sourceSha: sha256Hex(Buffer.from(composite, "utf8")),
    audit,
    descriptionStatus,
    originalDescription: originalDescription ?? "",
    originalDescriptionSha,
    dependencies: scanSkillDependencies(files),
  };
}

/**
 * Refuse the apply path if the source isn't a flat skills tree. A flat
 * tree has at least one `<Name>/SKILL.md` direct child. Anything else
 * (Packs/ layout, empty dir, file-at-root) is rejected loud so the
 * principal doesn't accidentally point at a Packs/ tree.
 */
async function listFlatSkillNames(fromDir: string): Promise<string[]> {
  if (!(await pathExists(fromDir))) {
    return [];
  }
  const fromStat = await lstat(fromDir);
  if (fromStat.isSymbolicLink()) {
    throw new Error("soma migrate claude-skills refused symlinked --from root.");
  }
  if (!fromStat.isDirectory()) {
    throw new Error(`soma migrate claude-skills: --from is not a directory: ${fromDir}`);
  }
  const entries = await readdir(fromDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillMdPath = join(fromDir, entry.name, "SKILL.md");
    if (entry.isSymbolicLink()) {
      // #166 — top-level symlinked skill directories are common in PAI
      // development (`~/.claude/skills/name -> ~/work/.../skill`). List
      // entries that look like skill roots so `readSourceSkill` can
      // apply the same safe symlink policy used inside skill trees and
      // classify failures per skill instead of silently skipping them.
      if (await pathExists(skillMdPath)) {
        names.push(entry.name);
      }
      continue;
    }
    if (await pathExists(skillMdPath)) {
      // #118 — a symlinked top-level SKILL.md is no longer an outright
      // refusal at the listing phase. The walker in `collectSkillFiles`
      // resolves the symlink via the safe helper: user-owned in-$HOME
      // targets follow + import; out-of-home / broken / cyclic targets
      // throw and classify the whole `<Name>` skill as `refused-other`
      // (per-skill log-and-continue at the orchestrator level).
      // We DO still surface the skill name so the orchestrator can run
      // `readSourceSkill` against it — that's where the safe-resolve
      // and per-skill error isolation live.
      names.push(entry.name);
    }
  }
  names.sort();
  return names;
}

async function readExistingManifest(
  somaHome: string,
): Promise<ClaudeSkillsMigrationManifest | null> {
  const path = join(somaHome, MANIFEST_RELATIVE);
  if (!(await pathExists(path))) return null;
  try {
    const raw = await readFile(path, "utf8");
    // Parse-then-shape-check pattern. `JSON.parse` returns `unknown`
    // by contract; the runtime guards on `schema` and `skills` validate
    // the shape before we narrow to the manifest type. The lint
    // suppression on the schema check exists because TS narrows
    // `parsed.schema` to the literal type via the `as` assertion;
    // without the assertion we lose the typed return surface here.
    const parsed = JSON.parse(raw) as { schema?: unknown; skills?: unknown };
    if (parsed.schema !== MANIFEST_SCHEMA || !Array.isArray(parsed.skills)) return null;
    // Holly R1 nit — shallow shape probe. A partially-corrupted manifest
    // (right schema string, array `skills`, but entries missing the
    // fingerprint fields) would otherwise blow up downstream with opaque
    // errors. The probe is cheap; one bad entry rejects the whole manifest
    // and the migrator falls back to a fresh run.
    const skills = parsed.skills as Record<string, unknown>[];
    for (const entry of skills) {
      if (typeof entry.sourceName !== "string" || typeof entry.sourceSha !== "string") {
        return null;
      }
    }
    return parsed as unknown as ClaudeSkillsMigrationManifest;
  } catch {
    return null;
  }
}

interface PlanResult {
  isFlatSkillsTree: boolean;
  outcomes: ClaudeSkillOutcome[];
  // Holly R1 nit — carry the read payloads so the apply path can write
  // without a second disk pass. Plan-mode callers ignore this field;
  // apply-mode callers thread it through to writeSkillPayload to avoid
  // doubling I/O on 45-skill imports.
  reads: SourceSkillReadResult[];
}

interface BuildPlanCoreOptions {
  fromDir: string;
  somaHome: string;
  includeClaudeSpecific: boolean;
  prevManifest: ClaudeSkillsMigrationManifest | null;
  rewriteDescriptionsAgent: RewriteDescriptionsAgent;
  homeRealPath: string;
  progress: ProgressEmitter;
}

async function buildPlanCore(options: BuildPlanCoreOptions): Promise<PlanResult> {
  const {
    fromDir,
    somaHome,
    includeClaudeSpecific,
    prevManifest,
    rewriteDescriptionsAgent,
    homeRealPath,
    progress,
  } = options;
  const names = await listFlatSkillNames(fromDir);
  if (names.length === 0) {
    return { isFlatSkillsTree: false, outcomes: [], reads: [] };
  }
  // #125 — discovery banner + per-skill index. The banner fires here
  // (not inside `listFlatSkillNames`) so the count reflects the
  // skills the orchestrator will actually walk; an empty tree no
  // longer surprises the principal with a "0 skill(s)" message.
  progress.start(names.length);

  // Bounded concurrency for the read + classify pass — per-skill work
  // is independent and dominated by file I/O, same as the memory
  // migrator (4-wide).
  //
  // #118 — per-skill log-and-continue. A read failure on one skill no
  // longer aborts the whole migrate. We surface a `Result`-style
  // tagged union per skill so the outcome builder can classify
  // failures as `refused-other` while keeping the rest of the pipeline
  // pure. Mirrors the pattern in `pai-migration.ts:728-737`.
  type ReadResult =
    | { ok: true; read: SourceSkillReadResult }
    | { ok: false; sourceName: string; reason: string };
  // #125 — per-skill progress for the read+classify phase. Each
  // entry records its own index relative to the alphabetical
  // `names` order (consistent with the final outcomes ordering),
  // so the `[N/total]` prefix matches the report's row order. The
  // emitter handles TTY-vs-non-TTY mechanics; we only feed it
  // skill + phase + outcome detail.
  const nameToIndex = new Map<string, number>(names.map((n, i) => [n, i + 1]));
  // #139 — bracket the read+classify phase with
  // beginConcurrentPhase / endConcurrentPhase. The emitter suppresses
  // per-skill output during the bracket and emits one banner + one
  // summary, replacing the #125 behavior of 97 interleaved append-
  // only lines (4-wide concurrent fan-out produced one stepComplete
  // per skill, which the #125 emitter rendered as 97 `\n`-terminated
  // lines because `\r`-overwrite would clobber 3 of 4 workers).
  //
  // The bracket extends across BOTH the concurrent read fan-out AND
  // the sequential classification loop below — the `classified`
  // stepComplete is conceptually part of the same "read + classify"
  // phase (the principal sees one phase, not two), and emitting
  // those 97 lines append-only would re-introduce the same #139
  // symptom we're fixing.
  //
  // The migrator's own per-phase wall-clock timing
  // (`readClassifyMs`) is computed by the outer caller around
  // `buildPlanCore` and remains the source of truth for the
  // stdout Timing block. The `concurrentStart` delta below is only
  // used to feed the emitter's banner/summary line.
  const READ_CLASSIFY_CONCURRENCY = 4;
  const concurrentStart = Date.now();
  progress.beginConcurrentPhase("read + classify", names.length, READ_CLASSIFY_CONCURRENCY);
  const readResults: ReadResult[] = await runBoundedConcurrent<string, ReadResult>(
    names,
    async (name) => {
      const idx = nameToIndex.get(name) ?? 0;
      const t0 = Date.now();
      try {
        const read = await readSourceSkill(fromDir, name, homeRealPath);
        progress.stepComplete(idx, name, "reading + classifying", Date.now() - t0, "read");
        return { ok: true, read };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        progress.stepComplete(idx, name, "reading + classifying", Date.now() - t0, "refused-other");
        return { ok: false, sourceName: name, reason };
      }
    },
    READ_CLASSIFY_CONCURRENCY,
  );

  const prevBySource = new Map<string, ClaudeSkillsMigrationManifestEntry>();
  if (prevManifest) {
    for (const entry of prevManifest.skills) {
      prevBySource.set(entry.sourceName, entry);
    }
  }

  const reads: SourceSkillReadResult[] = [];
  const outcomes: ClaudeSkillOutcome[] = [];
  for (const r of readResults) {
    if (!r.ok) {
      // Per-skill refusal — preserve the source name + reason so the
      // formatter can surface `<sourceName>/<rel>` per AC-4. The
      // refusal has no sourceSha (we never finished reading the
      // skill); we use a stable empty marker so manifest entries
      // for `refused-other` are intentionally absent (idempotency
      // anchors only land for successfully-read skills).
      outcomes.push({
        sourceName: r.sourceName,
        kebabName: sourceSkillKebabName(r.sourceName),
        tag: "portable",
        reason: r.reason,
        disposition: "refused-other",
        sourceSha: "",
        target: null,
        fileCount: 0,
        refusalReason: r.reason,
      });
      continue;
    }
    const read = r.read;
    reads.push(read);
    const classification = classifySkillPortability(read.files);
    // #125 — emit the resolved classification verdict so the per-
    // skill stderr row carries the final tag (portable / needs-adapt /
    // claude-specific). The read+classify step already fired above;
    // we follow with a `[classified ... <tag>]` line so a principal
    // tail-ing the run can grep verdicts without reading the report.
    const classifyIdx = nameToIndex.get(read.sourceName) ?? 0;
    progress.stepComplete(classifyIdx, read.sourceName, "classified", 0, classification.tag);
    const target = join(somaHome, "skills", read.kebabName);
    let disposition: ClaudeSkillOutcome["disposition"];
    if (classification.tag === "claude-specific" && !includeClaudeSpecific) {
      disposition = "skipped-claude-specific";
    } else {
      const prior = prevBySource.get(read.sourceName);
      const sourceAndTagUnchanged =
        prior?.sourceSha === read.sourceSha && prior.tag === classification.tag;
      const needsDescriptionRewrite =
        rewriteDescriptionsAgent !== "none" &&
        (read.descriptionStatus.kind === "oversize" || read.descriptionStatus.kind === "missing");
      const rewriteAlreadySatisfiesIntent =
        prior?.descriptionRewrite?.agent === rewriteDescriptionsAgent &&
        prior.descriptionRewrite.originalDescriptionSha === read.originalDescriptionSha;
      if (sourceAndTagUnchanged && (!needsDescriptionRewrite || rewriteAlreadySatisfiesIntent)) {
        disposition = "skipped-idempotent";
      } else {
        disposition = "imported";
      }
    }
    outcomes.push({
      sourceName: read.sourceName,
      kebabName: read.kebabName,
      tag: classification.tag,
      reason: classification.reason,
      disposition,
      sourceSha: read.sourceSha,
      target: disposition === "skipped-claude-specific" ? null : target,
      // fileCount is populated by the apply path; plan path reports
      // the source file count so the principal can see the size of
      // each pending write up-front.
      fileCount: read.files.length,
      ...(read.audit.length > 0 ? { audit: read.audit } : {}),
      ...(read.dependencies.length > 0 ? { dependencies: read.dependencies } : {}),
      // #120 — every successfully-read skill carries a description
      // status so the portability report can show the original
      // length even when no rewrite was requested.
      descriptionStatus: read.descriptionStatus,
    });
  }
  outcomes.sort((a, b) => a.sourceName.localeCompare(b.sourceName));
  // #139 — close the concurrent phase here, AFTER the sequential
  // classification loop. See the matching beginConcurrentPhase above:
  // the bracket spans the full logical read+classify phase, not
  // just the runBoundedConcurrent fan-out, so the per-skill
  // `classified` stepComplete events stay suppressed too.
  progress.endConcurrentPhase("read + classify", Date.now() - concurrentStart);

  return { isFlatSkillsTree: true, outcomes, reads };
}

function applyDependencyWarnings(outcomes: ClaudeSkillOutcome[]): void {
  const dispositionBySkill = new Map(outcomes.map((o) => [o.kebabName, o.disposition]));
  for (const outcome of outcomes) {
    if (!outcome.dependencies || outcome.dependencies.length === 0) {
      outcome.dependencyMissing = undefined;
      continue;
    }
    const missing = new Set<string>();
    for (const dependency of outcome.dependencies) {
      if (dependency.skill === outcome.kebabName) continue;
      const disposition = dispositionBySkill.get(dependency.skill);
      if (
        disposition === undefined ||
        disposition === "skipped-claude-specific" ||
        disposition === "refused-other" ||
        disposition === "refused-description-limit"
      ) {
        missing.add(dependency.skill);
      }
    }
    if (missing.size > 0) {
      outcome.dependencyMissing = [...missing].sort();
    } else {
      outcome.dependencyMissing = undefined;
    }
  }
}

export async function planClaudeSkillsMigration(
  options: ClaudeSkillsMigrationOptions,
): Promise<ClaudeSkillsMigrationPlan> {
  const { from, somaHome } = resolveHomes(options);
  const includeClaudeSpecific = options.includeClaudeSpecific === true;
  const smokeSubstrates = normalizeSmokeSubstrates(options.smokeSubstrates);
  const rewriteDescriptionsAgent: RewriteDescriptionsAgent =
    options.rewriteDescriptionsAgent ?? "none";
  // #118 — resolve `$HOME` once via realpath so symlinks targeting
  // paths under HOME (the common case on macOS where /tmp resolves to
  // /private/tmp) are correctly identified as in-bounds. The resolved
  // path is the security anchor for the safe-symlink helper.
  const homeRealPath = await realpath(resolve(options.homeDir ?? homedir()));
  // #125 — resolve the progress emitter. Library callers default to
  // the no-op; the CLI injects a stderr-backed emitter.
  const progress = options.progressEmitter ?? createNoopProgressEmitter();
  // Plan mode reads any existing manifest so the dispositions match
  // what an `--apply` invocation would do (e.g. a re-run on unchanged
  // source shows `skipped-idempotent`, not `imported`).
  const prevManifest = await readExistingManifest(somaHome);
  const { isFlatSkillsTree, outcomes } = await buildPlanCore({
    fromDir: from,
    somaHome,
    includeClaudeSpecific,
    prevManifest,
    rewriteDescriptionsAgent,
    homeRealPath,
    progress,
  });
  // #120 — surface refused-description-limit in plan mode too so a
  // dry-run shows what the apply will refuse without committing to
  // writes. Mirrors the apply path's classification logic.
  applyDescriptionLimitClassification({
    outcomes,
    rewriteDescriptionsAgent,
  });
  applyDependencyWarnings(outcomes);
  return {
    apply: false,
    from,
    somaHome,
    isFlatSkillsTree,
    outcomes,
    includeClaudeSpecific,
    smokeSubstrates,
    rewriteDescriptionsAgent,
  };
}

/**
 * #120 — classify outcomes whose description is oversize OR missing
 * AND no `--rewrite-descriptions <agent>` was set. Mutates the
 * outcomes in place to `refused-description-limit` so plan + apply
 * paths share the same verdict.
 *
 * Skills whose disposition is already terminal (`skipped-claude-
 * specific`, `refused-other`) are skipped — the description limit
 * is a SECONDARY filter, not a primary one.
 */
function applyDescriptionLimitClassification(args: {
  outcomes: ClaudeSkillOutcome[];
  rewriteDescriptionsAgent: RewriteDescriptionsAgent;
}): void {
  const { outcomes, rewriteDescriptionsAgent } = args;
  if (rewriteDescriptionsAgent !== "none") return;
  for (const outcome of outcomes) {
    if (
      outcome.disposition === "skipped-claude-specific" ||
      outcome.disposition === "refused-other"
    ) {
      continue;
    }
    const status = outcome.descriptionStatus;
    if (!status) continue;
    if (status.kind === "oversize" || status.kind === "missing") {
      outcome.disposition = "refused-description-limit";
      outcome.target = null;
      outcome.refusalReason = status.kind === "oversize"
        ? `description length ${status.length} exceeds substrate cap of ${status.threshold} — re-run with --rewrite-descriptions auto or <claude|codex|pi>`
        : `SKILL.md has no frontmatter description (substrate cap ${status.threshold}) — re-run with --rewrite-descriptions auto or <claude|codex|pi> to synthesize one`;
    }
  }
}

/**
 * #120 — splice a rewritten description into the SKILL.md
 * frontmatter. Two shapes are handled:
 *
 *   1. Frontmatter present, `description:` line present (oversize
 *      path). The existing line is replaced; every other line in the
 *      frontmatter block (name, allowed-tools, etc.) survives byte-
 *      for-byte.
 *   2. No frontmatter at all (missing path). A fresh `--- /
 *      description: ... / ---` block is prepended; the body remains
 *      untouched. `name: <kebabSlug>` is also synthesized because
 *      substrates require both fields to load.
 *
 * The frontmatter exists ONLY on SKILL.md in PAI skills (Workflows/
 * Tools/References stay untouched). The caller passes the bytes of
 * the source SKILL.md and gets the bytes that should land at the
 * target path.
 */
function spliceFrontmatterDescription(args: {
  sourceName: string;
  skillMdContent: string;
  rewritten: string;
}): string {
  const { sourceName, skillMdContent, rewritten } = args;
  // Quote the description in case it contains characters YAML would
  // treat as control (`:`, `#`, leading `-`, etc.). Single matching
  // pair, double quotes, escape any embedded double quote.
  const quoted = `"${rewritten.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  const fm = FRONTMATTER_RE.exec(skillMdContent);
  if (!fm) {
    // Missing-path: synthesize a minimal frontmatter block. `name:`
    // mirrors the source directory name so the substrate loader's
    // identity check passes. The kebab-cased projection happens
    // downstream (per-substrate adapter); we use the source name here
    // for symmetry with skills that ship explicit `name: <SourceName>`.
    return `---\nname: ${sourceName}\ndescription: ${quoted}\n---\n\n${skillMdContent}`;
  }
  // Frontmatter present: replace the `description:` line if it
  // exists, otherwise insert one just before the closing `---`.
  const fmBlock = fm[1];
  const lines = fmBlock.split(/\r?\n/);
  let replaced = false;
  const newLines: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("description:")) {
      replaced = true;
      // Preserve the leading indentation (rare but possible if the
      // skill author indented their frontmatter).
      const indent = /^\s*/.exec(line)?.[0] ?? "";
      newLines.push(`${indent}description: ${quoted}`);
      const value = line.trimStart().slice("description:".length).trim();
      if (isFrontmatterBlockScalarMarker(value)) {
        i = findFrontmatterBlockScalarEndIndex(lines, i, indent.length);
      }
      continue;
    }
    newLines.push(line);
  }
  if (!replaced) {
    // No description line; append one. Substrates require it; the
    // synthesis path means we MUST always end up with a description.
    newLines.push(`description: ${quoted}`);
  }
  const rebuiltBlock = newLines.join("\n");
  // Reconstruct: `---\n<block>\n---<rest>`. `fm[0]` is the full
  // matched delimited block including the leading `---\n` and
  // trailing `\n---`; we replace it in place.
  return skillMdContent.replace(fm[0], `---\n${rebuiltBlock}\n---`);
}

/**
 * #120 — run the LLM dispatcher for one skill's description with a
 * single retry when the model overshoots the 1024-char cap. The
 * caller passes a resolved dispatcher (either the test override or
 * the real subprocess wrapper); this function adds:
 *   - sanitization of the LLM response (frontmatter strip, quote
 *     strip, whitespace collapse).
 *   - hard-cap validation against 1024 (NOT 900 — 900 is the
 *     target the prompt asks for; the substrate cap is the binding
 *     limit).
 *   - one retry when the first attempt is over 1024.
 *
 * On success returns the rewritten text + its SHA. On failure (still
 * over 1024 after retry, or dispatcher throws) bubbles the error up
 * so the apply path can classify the skill as `refused-other` with
 * the limit in the reason.
 */
async function performRewriteWithRetry(args: {
  dispatcher: RewriteDispatchOverride;
  agent: Exclude<RewriteDescriptionsAgent, "none">;
  sourceName: string;
  status: DescriptionStatus;
  originalDescription: string;
  skillMdBody: string;
}): Promise<{ rewritten: string; rewrittenSha: string }> {
  const { dispatcher, agent, sourceName, status, originalDescription, skillMdBody } = args;
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    const raw = await dispatcher({
      agent,
      sourceName,
      status,
      originalDescription,
      skillMdBody,
      targetMaxLength: DEFAULT_REWRITE_TARGET,
    });
    const rewritten = sanitizeRewrittenDescription(raw);
    if (rewritten.length === 0) {
      throw new Error(
        `--rewrite-descriptions ${agent} returned empty description for ${sourceName}`,
      );
    }
    if (rewritten.length <= SUBSTRATE_DESCRIPTION_LIMIT) {
      return { rewritten, rewrittenSha: sha256Utf8(rewritten) };
    }
    // First attempt overshot the hard cap; loop once more.
  }
  throw new Error(
    `--rewrite-descriptions ${agent}: returned >${SUBSTRATE_DESCRIPTION_LIMIT}-char description for ${sourceName} on both attempts (substrate cap exceeded).`,
  );
}

async function writeSkillPayload(
  read: SourceSkillReadResult,
  targetDir: string,
  applyRewrites: boolean,
  rewrittenSkillMdContent: string | null,
): Promise<{
  fileShas: Record<string, string>;
  // #115 Phase 2 — POST-rewrite, in-memory payload. Threaded into the
  // verifier so it sees the bytes a substrate would consume, without
  // re-reading the just-written files from disk.
  rewrittenFiles: { relPath: string; content: Buffer }[];
}> {
  // Make sure the target directory tree exists. Per-file `mkdir` of
  // the parent happens inside the loop so deep payloads
  // (`Workflows/SubDir/file.md`) work without precomputed dir lists.
  await mkdir(targetDir, { recursive: true });
  const fileShas: Record<string, string> = {};
  const rewrittenFiles: { relPath: string; content: Buffer }[] = [];

  for (const file of read.files) {
    const target = join(targetDir, ...file.relPath.split("/"));
    await mkdir(join(target, ".."), { recursive: true });

    // Only the canonical text-payload extensions go through the
    // rewriter. Binary assets (images, audio under `Examples/`)
    // pass through bit-for-bit so SHA still equals source SHA.
    // `.hbs` (Handlebars) covered because PAI's Prompting skill
    // ships templates that reference `~/.claude/Skills/...` literally
    // in template bodies — the rewriter must touch them too or
    // landed skills carry residue (AC-3 zero-residue grep).
    const isText = /\.(md|markdown|mdx|txt|json|yaml|yml|ts|js|tsx|jsx|mjs|cjs|py|rb|sh|bash|zsh|toml|hbs|handlebars|tmpl|tpl|xml|html|css)$/.test(file.relPath);
    // #120 — when a description rewrite produced new SKILL.md bytes,
    // they take precedence over both the source bytes and the
    // path-normalizer's output. The normalizer must still run on the
    // POST-splice content so `~/.claude/` refs in the body get
    // rewritten the same as everywhere else.
    const useRewrittenSkillMd = rewrittenSkillMdContent !== null && file.relPath === "SKILL.md";
    if (useRewrittenSkillMd) {
      const base = rewrittenSkillMdContent;
      const finalContent = applyRewrites
        ? normalizeSkillContent(file.relPath, base).content
        : base;
      const bytes = Buffer.from(finalContent, "utf8");
      await writeFile(target, bytes);
      fileShas[file.relPath] = sha256Hex(bytes);
      rewrittenFiles.push({ relPath: file.relPath, content: bytes });
      continue;
    }
    if (applyRewrites && isText) {
      const original = file.content.toString("utf8");
      const { content: rewritten } = normalizeSkillContent(file.relPath, original);
      const bytes = Buffer.from(rewritten, "utf8");
      await writeFile(target, bytes);
      fileShas[file.relPath] = sha256Hex(bytes);
      rewrittenFiles.push({ relPath: file.relPath, content: bytes });
    } else {
      await copyFile(file.source, target);
      fileShas[file.relPath] = sha256Hex(file.content);
      rewrittenFiles.push({ relPath: file.relPath, content: file.content });
    }
  }

  return { fileShas, rewrittenFiles };
}

function renderManifest(manifest: ClaudeSkillsMigrationManifest): string {
  // JSON.stringify with 2-space indent + trailing newline matches the
  // pai-memory-migrator and pai-docs-importer manifest format. Entries
  // sorted by kebabName so byte-stable reruns produce byte-stable
  // manifests.
  const sorted: ClaudeSkillsMigrationManifest = {
    ...manifest,
    skills: [...manifest.skills].sort((a, b) => a.kebabName.localeCompare(b.kebabName)),
    ...(manifest.lastRun
      ? {
          lastRun: {
            ...manifest.lastRun,
            outcomes: [...manifest.lastRun.outcomes].sort((a, b) => a.kebabName.localeCompare(b.kebabName)),
          },
        }
      : {}),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * #120 — single-source mapping from `ClaudeSkillOutcome` to the
 * human-readable reason that should land in CLI output, the
 * portability report row, etc. Refusal dispositions
 * (`refused-other`, `refused-description-limit`) surface the
 * `refusalReason` (which embeds the source path / length / cap);
 * every other disposition surfaces the classifier `reason` (the
 * portability verdict).
 *
 * Exported so the CLI formatter can reuse it — Holly r1 S1 nit:
 * the migrator's report renderer + the CLI's plan/apply formatters
 * were duplicating the disposition→reason mapping in three places,
 * which would drift when the next refusal disposition lands.
 */
export function resolveOutcomeReason(outcome: ClaudeSkillOutcome): string {
  if (outcome.disposition === "refused-other" || outcome.disposition === "refused-description-limit") {
    return outcome.refusalReason ?? outcome.reason;
  }
  return outcome.reason;
}

function remediationForOutcome(outcome: ClaudeSkillOutcome): string | undefined {
  if (outcome.disposition === "skipped-claude-specific") {
    return "Re-run with --include-claude-specific if this Claude-only skill should still be imported.";
  }
  if (outcome.disposition === "refused-description-limit") {
    return "Re-run with --rewrite-descriptions auto (or claude/codex/pi) to compress the description before import.";
  }
  if (outcome.disposition !== "refused-other") return undefined;
  const reason = resolveOutcomeReason(outcome);
  if (reason.includes("VCS metadata directory")) {
    return "remove or move embedded VCS metadata such as .git/.hg/.svn out of the skill directory, then rerun.";
  }
  if (reason.includes("symlink cycle") || reason.includes("symlink loop")) {
    return "Break the symlink cycle or replace the symlink with regular files, then rerun.";
  }
  if (reason.includes("broken link") || reason.includes("target does not exist")) {
    return "Repair or remove the broken symlink target, then rerun.";
  }
  if (reason.includes("outside $HOME")) {
    return "Move the symlink target under $HOME or copy the files into the skill tree, then rerun.";
  }
  if (reason.includes("denylisted")) {
    return "Remove links to credential or secret-bearing home subpaths, then rerun.";
  }
  return "Fix the refused source path shown in the reason, then rerun.";
}

function isActionableManifestOutcome(outcome: ClaudeSkillOutcome): boolean {
  return (
    outcome.disposition === "skipped-claude-specific" ||
    outcome.disposition === "refused-other" ||
    outcome.disposition === "refused-description-limit" ||
    (outcome.dependencyMissing?.length ?? 0) > 0
  );
}

function buildManifestLastRun(
  outcomes: readonly ClaudeSkillOutcome[],
): ClaudeSkillsMigrationManifestLastRun | undefined {
  const exceptional = outcomes.filter(isActionableManifestOutcome);
  if (exceptional.length === 0) return undefined;
  let imported = 0;
  let skippedIdempotent = 0;
  let skippedClaudeSpecific = 0;
  let refusedOther = 0;
  let refusedDescriptionLimit = 0;
  for (const outcome of outcomes) {
    if (outcome.disposition === "imported") imported += 1;
    else if (outcome.disposition === "skipped-idempotent") skippedIdempotent += 1;
    else if (outcome.disposition === "skipped-claude-specific") skippedClaudeSpecific += 1;
    else if (outcome.disposition === "refused-other") refusedOther += 1;
    else refusedDescriptionLimit += 1;
  }
  const manifestOutcomes: ClaudeSkillsMigrationManifestOutcome[] = exceptional.map((outcome) => {
    const remediation = remediationForOutcome(outcome);
    return {
      sourceName: outcome.sourceName,
      kebabName: outcome.kebabName,
      tag: outcome.tag,
      disposition: outcome.disposition,
      reason: outcome.reason,
      ...(outcome.refusalReason ? { refusalReason: outcome.refusalReason } : {}),
      ...(remediation ? { remediation } : {}),
      ...(outcome.dependencyMissing && outcome.dependencyMissing.length > 0
        ? { dependencyMissing: [...outcome.dependencyMissing].sort() }
        : {}),
    };
  });
  return {
    totals: {
      imported,
      skippedIdempotent,
      skippedClaudeSpecific,
      refusedOther,
      refusedDescriptionLimit,
    },
    outcomes: manifestOutcomes,
  };
}

function renderPortabilityReport(
  result: ClaudeSkillsMigrationPlan & { importedAt: string },
): string {
  // `rewriteDescriptionsAgent` is a required field on
  // `ClaudeSkillsMigrationPlan` from #120 onward — but referenced
  // here through the plain field path so the type system enforces it
  // exists at every callsite.
  // AC-5 — markdown report. Always written on the apply path so the
  // principal has a per-skill audit trail next to the manifest.
  // Header documents the heuristic's limits (AC-4 transparency).
  const lines: string[] = [];
  lines.push("# Claude Skills Portability Report");
  lines.push("");
  lines.push(`Source: ${result.from}`);
  lines.push(`Generated: ${result.importedAt}`);
  lines.push(`Include claude-specific: ${result.includeClaudeSpecific ? "yes" : "no"}`);
  if (result.smokeSubstrates.length > 0) {
    lines.push(`Smoke substrates: ${result.smokeSubstrates.join(", ")}`);
  }
  if (result.rewriteDescriptionsAgent !== "none") {
    lines.push(`Rewrite descriptions agent: ${result.rewriteDescriptionsAgent}`);
  }
  lines.push("");
  lines.push("## Classifier rules (Phase 1, heuristic)");
  lines.push("");
  lines.push("- **claude-specific** — hook binding (`Stop:`, `UserPromptSubmit:`, `PreToolUse:`, `PostToolUse:`, `SessionStart:`, `SubagentStop:`, `Notification:`, `PreCompact:`) OR `/<slash-command>` reference in prose (outside fenced code blocks).");
  lines.push("- **needs-adapt** — `~/.claude/...` path reference(s); rewritten via `pai-pack-normalizer.ts` deterministic rewrite table.");
  lines.push("- **portable** — no Claude-specific signal detected.");
  lines.push("");
  lines.push(
    result.smokeSubstrates.length > 0
      ? "Phase 1 is regex-based; subtle Claude-only behavior in prose that doesn't trip these signals can still slip through as `portable`. Phase 2 substrate columns below carry the per-skill static-shape verify verdict (verified / verified-with-warnings / failed) against each requested substrate's projection."
      : "Phase 1 is regex-based; subtle Claude-only behavior in prose that doesn't trip these signals can still slip through as `portable`. Phase 2 (`--smoke <substrate>`) will add per-substrate projection verify to turn the verdict from heuristic to verified.",
  );
  lines.push("");
  lines.push("## Per-skill outcomes");
  lines.push("");
  // Substrate columns are conditional on `--smoke` having been
  // passed (AC-5 extension). Without the flag, the Phase-1 column
  // shape stays exactly the same so the report is backward-stable
  // for principals who haven't opted in.
  // #120 — Description + Rewrite columns appear only when
  // `--rewrite-descriptions` was used. Without the flag the table
  // shape is byte-stable for principals who haven't opted in.
  const includeRewriteColumns = result.rewriteDescriptionsAgent !== "none";
  const headerCells = ["Skill", "Tag", "Disposition", "Reason", "Dependencies"];
  if (includeRewriteColumns) {
    headerCells.push("Description");
    headerCells.push("Rewrite");
  }
  for (const substrate of result.smokeSubstrates) {
    headerCells.push(substrate);
  }
  lines.push(`| ${headerCells.join(" | ")} |`);
  lines.push(`|${headerCells.map(() => "---").join("|")}|`);
  for (const o of result.outcomes) {
    // #118 / #120 — refusal dispositions surface `refusalReason`;
    // non-refusal dispositions surface the classifier `reason`.
    // Centralized in `resolveOutcomeReason` (Holly r1 S1).
    const reasonCell = escapeMarkdownCell(resolveOutcomeReason(o));
    const row = [o.kebabName, o.tag, o.disposition, reasonCell, renderDependenciesCell(o)];
    if (includeRewriteColumns) {
      row.push(renderDescriptionCell(o));
      row.push(renderRewriteCell(o));
    }
    for (const substrate of result.smokeSubstrates) {
      const verify = o.substrates?.[substrate];
      row.push(verify ? renderSubstrateCell(verify) : "—");
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  // #118 — audit section listing every followed-user-owned-symlink.
  // Sorted by source skill, then by rel path. Absent when no skill
  // recorded a followed symlink (Phase-1 byte-stable rerun).
  // Audit kind is currently only `followed-user-owned-symlink`; future
  // kinds will need a switch here. We flatten directly today.
  const followedAuditRows: { source: string; rel: string; target: string }[] = [];
  for (const o of result.outcomes) {
    if (!o.audit) continue;
    for (const entry of o.audit) {
      followedAuditRows.push({ source: o.sourceName, rel: entry.relPath, target: entry.detail });
    }
  }
  if (followedAuditRows.length > 0) {
    followedAuditRows.sort(
      (a, b) => a.source.localeCompare(b.source) || a.rel.localeCompare(b.rel),
    );
    lines.push("");
    lines.push("## Followed user-owned symlinks");
    lines.push("");
    lines.push(
      "These symlinks were resolved via `realpath` and their target bytes imported. Every resolved target stayed within `$HOME` and outside the credential-path denylist (`.ssh/`, `.aws/`, `.gnupg/`, `.kube/`, `.docker/`).",
    );
    lines.push("");
    lines.push("| Source skill | Symlink path | Resolved target |");
    lines.push("|---|---|---|");
    for (const row of followedAuditRows) {
      lines.push(`| ${row.source} | ${escapeMarkdownCell(row.rel)} | ${escapeMarkdownCell(row.target)} |`);
    }
    lines.push("");
    // Mention the audit kind by name so principals grep'ing the report
    // can find it. Also documented in `src/types.ts`.
    lines.push("Audit kind: `followed-user-owned-symlink` (one entry per resolved symlink in the manifest).");
  }
  const missingDependencyCount = countOutcomesWithMissingDependencies(result.outcomes);
  if (missingDependencyCount > 0) {
    lines.push("");
    lines.push(`${missingDependencyCount} skill(s) depend on skipped/refused skills — see report for details.`);
  }
  lines.push("");
  return lines.join("\n");
}

// Markdown table cells can't contain raw `|` characters. Escape
// them, and collapse newlines (verifier reasons are single-line by
// contract; this is defensive).
function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderSubstrateCell(verify: ClaudeSkillSubstrateVerifyResult): string {
  if (verify.status === "verified") return "verified";
  // For the table cell we surface the short status + the first
  // issue's message, truncated. The full issue list lives in the
  // manifest (`substrates[].issues`) for audit.
  const trimmed = escapeMarkdownCell(verify.reason).slice(0, 120);
  return `${verify.status}: ${trimmed}`;
}

function renderDependenciesCell(outcome: ClaudeSkillOutcome): string {
  if (!outcome.dependencies || outcome.dependencies.length === 0) return "—";
  const missing = new Set(outcome.dependencyMissing ?? []);
  return outcome.dependencies
    .map((dep) => {
      const refs = dep.references.join(", ");
      const suffix = missing.has(dep.skill) ? " missing" : "";
      return `${dep.skill} (${refs})${suffix}`;
    })
    .map(escapeMarkdownCell)
    .join("<br>");
}

export function countOutcomesWithMissingDependencies(outcomes: readonly ClaudeSkillOutcome[]): number {
  return outcomes.filter((outcome) => (outcome.dependencyMissing?.length ?? 0) > 0).length;
}

// #120 — Description column. Shows `<orig>→<rewrite>` when a rewrite
// happened, `<orig> (rewrote)` shorthand when status was missing,
// plain length when no rewrite. Empty dash when the read failed
// (refused-other never gets a status).
function renderDescriptionCell(outcome: ClaudeSkillOutcome): string {
  const status = outcome.descriptionStatus;
  if (!status) return "—";
  const rewrite = outcome.descriptionRewrite;
  if (rewrite) {
    return `${status.length}→${rewrite.rewrittenLength} (rewrote)`;
  }
  return `${status.length}`;
}

// #120 — Rewrite column. Shows `<agent> / <ISO timestamp>` when a
// rewrite happened, dash otherwise.
function renderRewriteCell(outcome: ClaudeSkillOutcome): string {
  const rewrite = outcome.descriptionRewrite;
  if (!rewrite) return "—";
  return `${rewrite.agent} / ${rewrite.rewrittenAt}`;
}

/**
 * #115 Phase 2 — per-substrate static-shape smoke pass.
 *
 * Walks every outcome with disposition `imported` OR `skipped-
 * idempotent` (whose payload is already on disk), builds a
 * `SomaSkill` from the in-memory post-rewrite payload (or re-reads
 * from disk for skipped-idempotent skills), then invokes
 * `verifySubstrateProjection` per substrate. Idempotency: a prior
 * `verified` verdict for the same (source SHA, substrate) is
 * skipped — re-verify only runs when the verdict was warnings or
 * failed (the adapter might have been fixed between runs), or when
 * a new substrate was added to the smoke set.
 */
interface RunSmokeVerifyArgs {
  smokeSubstrates: readonly ClaudeSkillsSmokeSubstrate[];
  outcomes: ClaudeSkillOutcome[];
  manifestEntries: ClaudeSkillsMigrationManifestEntry[];
  previousBySource: Map<string, ClaudeSkillsMigrationManifestEntry>;
  somaHome: string;
  pendingVerifyPayloads: Map<string, { relPath: string; content: Buffer }[]>;
  readsBySource: Map<string, SourceSkillReadResult>;
  summary: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifySummary>>;
  // #125 — progress hook + per-skill index lookup. Defaults supplied
  // by the apply path; smoke verify is the only phase whose callsites
  // need both fields because each outcome can produce multiple
  // per-substrate progress lines.
  progress: ProgressEmitter;
  outcomeIndexBySource: Map<string, number>;
}

async function runSmokeVerify(args: RunSmokeVerifyArgs): Promise<void> {
  const { smokeSubstrates, outcomes, manifestEntries, previousBySource, somaHome, pendingVerifyPayloads, readsBySource, summary, progress, outcomeIndexBySource } = args;
  const entryByName = new Map(manifestEntries.map((entry) => [entry.sourceName, entry]));

  for (const outcome of outcomes) {
    if (outcome.disposition === "skipped-claude-specific") continue;
    // #118 — `refused-other` skills never landed bytes; nothing to
    // verify against a substrate. Skip without classifying as a
    // contract violation.
    if (outcome.disposition === "refused-other") continue;

    // Resolve the post-rewrite payload. Three sources, in order:
    //   1. In-memory payload captured by the apply loop.
    //   2. Disk re-read of the landed skill (skipped-idempotent
    //      case where no rewrite ran this invocation).
    //   3. Fallback to the source read payload (only happens if
    //      neither 1 nor 2 holds, which is the contract-violation
    //      branch; we error loud).
    let rewrittenFiles = pendingVerifyPayloads.get(outcome.sourceName);
    if (!rewrittenFiles) {
      const targetDir = outcome.target ?? join(somaHome, "skills", outcome.kebabName);
      if (await pathExists(targetDir)) {
        rewrittenFiles = await readLandedSkillPayload(targetDir);
      } else {
        const read = readsBySource.get(outcome.sourceName);
        if (read) {
          rewrittenFiles = read.files.map((f) => ({ relPath: f.relPath, content: f.content }));
        }
      }
    }
    if (!rewrittenFiles) {
      // Defensive — never expected with the dispositions above.
      continue;
    }

    const skill = buildSomaSkillFromPayload(outcome.sourceName, rewrittenFiles);
    const entry = entryByName.get(outcome.sourceName);
    const prior = previousBySource.get(outcome.sourceName);

    for (const substrate of smokeSubstrates) {
      // #125 — per-substrate progress. The verify call itself is
      // fast (pure projection + static-shape check), but with 100
      // skills × 2 substrates the line count matters; we still
      // emit each so the principal can see what passed/failed
      // without grepping the report.
      const idx = outcomeIndexBySource.get(outcome.sourceName) ?? 0;
      const smokeT0 = Date.now();
      // Idempotency check: prior verdict was `verified` AND source
      // SHA unchanged → reuse. Anything weaker re-runs so a fix to
      // the substrate adapter can flip the verdict without source
      // churn (issue contract).
      const priorVerify = prior?.substrates?.[substrate];
      const sourceUnchanged = prior?.sourceSha === outcome.sourceSha;
      let result: ClaudeSkillSubstrateVerifyResult;
      if (priorVerify?.status === "verified" && sourceUnchanged) {
        result = priorVerify;
      } else {
        result = verifySubstrateProjection({
          skill,
          substrate,
          sourceDescription: skill.description,
        });
      }
      progress.stepComplete(
        idx,
        outcome.sourceName,
        `smoke ${substrate}`,
        Date.now() - smokeT0,
        result.status,
      );

      // Stamp the outcome (formatter consumes this) and the manifest
      // entry (idempotency anchor for the next run).
      outcome.substrates ??= {};
      outcome.substrates[substrate] = result;
      if (entry) {
        entry.substrates ??= {};
        entry.substrates[substrate] = result;
      }

      const bucket = summary[substrate];
      if (bucket) {
        if (result.status === "verified") bucket.verified += 1;
        else if (result.status === "verified-with-warnings") bucket.verifiedWithWarnings += 1;
        else bucket.failed += 1;
      }
    }
  }
}

/**
 * Re-read the landed payload for a skill from disk. Used by the
 * smoke pass when the apply loop didn't produce an in-memory
 * rewrite (skipped-idempotent skills whose payload is already on
 * disk). Symlinks are refused with the same loud-fail bar as the
 * source-side walker.
 */
async function readLandedSkillPayload(
  targetDir: string,
): Promise<{ relPath: string; content: Buffer }[]> {
  const out: { relPath: string; content: Buffer }[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(targetDir, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        // Soma's own write path doesn't produce symlinks; if one is
        // here the principal placed it. Treat as benign skip so a
        // verify pass doesn't refuse the whole import.
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await visit(full);
        continue;
      }
      if (entry.isFile()) {
        const content = await readFile(full);
        out.push({ relPath: rel, content });
      }
    }
  }
  await visit(targetDir);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

export async function migrateClaudeSkills(
  options: ClaudeSkillsMigrationOptions,
): Promise<ClaudeSkillsMigrationResult> {
  const { from, somaHome } = resolveHomes(options);
  const includeClaudeSpecific = options.includeClaudeSpecific === true;
  const smokeSubstrates = normalizeSmokeSubstrates(options.smokeSubstrates);
  const rewriteDescriptionsAgent: RewriteDescriptionsAgent =
    options.rewriteDescriptionsAgent ?? "none";
  // #120 — resolve the LLM dispatcher: test override wins, otherwise
  // the per-agent subprocess wrapper. The migrator never knows which
  // it's calling — both honor the same `RewriteDispatchOverride`
  // contract so the apply-loop code path is identical.
  const rewriteDispatcher: RewriteDispatchOverride =
    options.rewriteDispatchOverride ?? ((req) => defaultRewriteDispatch(req));
  // #118 — resolve `$HOME` once (see plan-mode helper above).
  const homeRealPath = await realpath(resolve(options.homeDir ?? homedir()));
  // #125 — progress emitter: library callers default to no-op so
  // adding this argument can't change observable behavior; CLI
  // wires a stderr-backed emitter. Phase timings are accumulated in
  // local `Date.now()` deltas so the Timing block survives even
  // when the emitter is a no-op.
  const progress = options.progressEmitter ?? createNoopProgressEmitter();
  const runStart = Date.now();
  let descriptionRewritesMs = 0;
  let applyWriteMs = 0;
  let smokeVerifyMs = 0;

  // Ensure imports/claude-skills/ exists so manifest + report writes
  // succeed even on a fully empty Soma home.
  await mkdir(join(somaHome, "imports/claude-skills"), { recursive: true });
  const manifestPath = join(somaHome, MANIFEST_RELATIVE);
  const reportPath = join(somaHome, REPORT_RELATIVE);

  const previousManifest = await readExistingManifest(somaHome);
  const previousBySource = new Map<string, ClaudeSkillsMigrationManifestEntry>();
  if (previousManifest) {
    for (const entry of previousManifest.skills) {
      previousBySource.set(entry.sourceName, entry);
    }
  }

  const readClassifyStart = Date.now();
  const { isFlatSkillsTree, outcomes, reads } = await buildPlanCore({
    fromDir: from,
    somaHome,
    includeClaudeSpecific,
    prevManifest: previousManifest,
    rewriteDescriptionsAgent,
    homeRealPath,
    progress,
  });
  const readClassifyMs = Date.now() - readClassifyStart;

  if (!isFlatSkillsTree) {
    throw new Error(
      `soma migrate claude-skills: --from ${from} is not a flat skills tree (no <Name>/SKILL.md direct children).`,
    );
  }

  // Holly R1 nit — thread the buildPlanCore reads into the apply path
  // so we don't re-read every skill from disk a second time. Plan phase
  // already collected SkillFilePayload[] bytes for classification;
  // applying writes from the same in-memory payload halves the I/O.
  const readsBySource = new Map(reads.map((r) => [r.sourceName, r]));

  // #120 — classify outcomes whose description requires a rewrite OR
  // a refusal. Mutates dispositions in place; runs once before the
  // apply loop so the loop's branches stay deterministic.
  applyDescriptionLimitClassification({
    outcomes,
    rewriteDescriptionsAgent,
  });
  applyDependencyWarnings(outcomes);

  // Apply phase: walk the outcome list, write payloads for imported
  // skills, carry prior manifest entries for `skipped-idempotent`.
  const manifestEntries: ClaudeSkillsMigrationManifestEntry[] = [];
  let writtenCount = 0;
  let skippedIdempotentCount = 0;
  let skippedClaudeSpecificCount = 0;
  let refusedOtherCount = 0;
  // #120 — counters for the new dispositions.
  let refusedDescriptionLimitCount = 0;
  let descriptionRewrittenCount = 0;
  // #115 Phase 2 — in-memory post-rewrite payload per imported skill,
  // ferried into the smoke pass below to avoid a second disk read.
  // Skipped-idempotent skills fall back to disk re-read inside the
  // verify helper when a NEW substrate gets requested on rerun.
  const pendingVerifyPayloads = new Map<string, { relPath: string; content: Buffer }[]>();
  interface ApplyWriteCandidate {
    outcome: ClaudeSkillOutcome;
    read: SourceSkillReadResult;
    targetDir: string;
    rewrittenSkillMdContent: string | null;
    descriptionRewrite?: ClaudeSkillDescriptionRewrite;
  }
  interface ApplyWriteResult extends ApplyWriteCandidate {
    fileShas: Record<string, string>;
    rewrittenFiles: { relPath: string; content: Buffer }[];
    elapsedMs: number;
  }
  const applyWriteCandidates: ApplyWriteCandidate[] = [];

  // #125 — index lookup for progress `[N/total]` prefix during the
  // apply phase. Built once over the post-classify outcomes so the
  // index is stable across the rewrite + write + smoke phases of a
  // single skill. Holly r1 Nit-1: call sites use the Map directly
  // (the prior `nameToIdx` wrapper carried an unused first arg).
  const outcomeIndexBySource = new Map<string, number>(
    outcomes.map((o, i) => [o.sourceName, i + 1]),
  );

  for (const outcome of outcomes) {
    if (outcome.disposition === "skipped-claude-specific") {
      skippedClaudeSpecificCount += 1;
      continue;
    }
    if (outcome.disposition === "refused-other") {
      // #118 — per-skill log-and-continue. The read failed (out-of-home
      // symlink target, cycle, broken link, denylist). The outcome
      // already carries `refusalReason`; nothing else to do here. The
      // skill is NOT added to the manifest — only successfully-read
      // skills earn an idempotency anchor.
      refusedOtherCount += 1;
      continue;
    }
    if (outcome.disposition === "refused-description-limit") {
      // #120 — description exceeds 1024 chars (or is missing) AND no
      // `--rewrite-descriptions <agent>` was set. Skill NOT imported;
      // no manifest entry (a future rerun with the flag will attempt
      // the rewrite from a clean slate).
      refusedDescriptionLimitCount += 1;
      continue;
    }
    if (outcome.disposition === "skipped-idempotent") {
      skippedIdempotentCount += 1;
      const prior = previousBySource.get(outcome.sourceName);
      if (prior) {
        manifestEntries.push(prior);
        // #115 Phase 2 — propagate prior substrate verify results
        // onto the outcome so the report row still shows the last
        // known verdict even when the disposition is skipped-
        // idempotent. The smoke pass below will overwrite any
        // substrate slot that was requested AND wasn't previously
        // `verified`.
        if (prior.substrates) {
          outcome.substrates = { ...prior.substrates };
        }
        // #120 — surface the prior rewrite provenance on the outcome
        // so the report row shows the stable history.
        if (prior.descriptionRewrite) {
          outcome.descriptionRewrite = prior.descriptionRewrite;
        }
      }
      continue;
    }
    // Apply path uses the read payload already collected by
    // buildPlanCore (Holly R1 nit — single disk pass). The Map lookup
    // is O(1); the buildPlanCore contract guarantees every non-skipped
    // outcome has a corresponding read.
    const read = readsBySource.get(outcome.sourceName);
    if (!read) {
      throw new Error(
        `soma migrate claude-skills: missing read payload for ${outcome.sourceName} — buildPlanCore contract violation.`,
      );
    }
    const targetDir = outcome.target ?? join(somaHome, "skills", outcome.kebabName);

    // #120 — resolve the description rewrite (if any). Three
    // sub-paths:
    //   a) status `ok` → no rewrite needed; SKILL.md content is
    //      untouched.
    //   b) status `oversize` or `missing` AND agent is `none` →
    //      already classified as `refused-description-limit` above
    //      (never reaches here).
    //   c) status `oversize` or `missing` AND agent != `none` →
    //      run the dispatcher (with idempotency check against the
    //      previous manifest entry's `originalDescriptionSha`) and
    //      splice the result into the frontmatter.
    let rewrittenSkillMdContent: string | null = null;
    let descriptionRewrite: ClaudeSkillDescriptionRewrite | undefined;
    const needsRewrite =
      rewriteDescriptionsAgent !== "none" &&
      (read.descriptionStatus.kind === "oversize" || read.descriptionStatus.kind === "missing");
    if (needsRewrite) {
      const prior = previousBySource.get(outcome.sourceName);
      const priorRewrite = prior?.descriptionRewrite;
      const sourceUnchanged =
        priorRewrite?.originalDescriptionSha === read.originalDescriptionSha;
      const sameAgent = priorRewrite?.agent === rewriteDescriptionsAgent;
      const skillMdSource = read.files.find((f) => f.relPath === "SKILL.md");
      if (!skillMdSource) {
        // Should never happen — readSourceSkill refuses without a SKILL.md.
        throw new Error(
          `soma migrate claude-skills: missing SKILL.md payload for ${outcome.sourceName}.`,
        );
      }
      if (priorRewrite && sourceUnchanged && sameAgent) {
        // Idempotency: prior rewrite for this exact source SHA is
        // reused. We still need the rewritten TEXT — we recover it
        // by reading the previously-landed SKILL.md and parsing its
        // description back out. Falls back to re-running the
        // dispatcher when the landed bytes are missing (e.g. a
        // partial soma home).
        const landedSkillMdPath = join(targetDir, "SKILL.md");
        if (await pathExists(landedSkillMdPath)) {
          const landedBytes = await readFile(landedSkillMdPath, "utf8");
          const landedDescription = parseSourceDescription(landedBytes);
          if (landedDescription !== undefined && sha256Utf8(landedDescription) === priorRewrite.rewrittenDescriptionSha) {
            rewrittenSkillMdContent = spliceFrontmatterDescription({
              sourceName: outcome.sourceName,
              skillMdContent: skillMdSource.content.toString("utf8"),
              rewritten: landedDescription,
            });
            descriptionRewrite = priorRewrite;
          }
        }
      }
      if (!descriptionRewrite) {
        // Fresh rewrite (no prior, or source changed, or landed
        // bytes are missing). Bubble dispatcher failures up to the
        // per-skill refusal lane instead of aborting the whole run.
        //
        // The `needsRewrite` guard above ensured `rewriteDescriptions-
        // Agent !== "none"`; assign once so the narrowed type flows
        // through both the dispatcher call AND the provenance entry.
        const activeAgent = resolveRewriteDescriptionsAgent(rewriteDescriptionsAgent);
        // #125 — bracket the LLM call with start + complete progress
        // lines so a principal sees `[N/total] <skill> [rewriting
        // via claude (1318 chars → target 900)... <elapsed>s → 836
        // chars]` instead of a silent 5-30s block.
        const idx = outcomeIndexBySource.get(outcome.sourceName) ?? 0;
        const oldLen = read.descriptionStatus.length;
        progress.step(
          idx,
          outcome.sourceName,
          `rewriting description via ${activeAgent}`,
          `${oldLen} chars → target ${DEFAULT_REWRITE_TARGET}`,
        );
        const rewriteT0 = Date.now();
        try {
          const { rewritten, rewrittenSha } = await performRewriteWithRetry({
            dispatcher: rewriteDispatcher,
            agent: activeAgent,
            sourceName: outcome.sourceName,
            status: read.descriptionStatus,
            originalDescription: read.originalDescription,
            skillMdBody: skillMdSource.content.toString("utf8"),
          });
          const rewriteElapsed = Date.now() - rewriteT0;
          descriptionRewritesMs += rewriteElapsed;
          progress.stepComplete(
            idx,
            outcome.sourceName,
            `rewriting description via ${activeAgent}`,
            rewriteElapsed,
            `${rewritten.length} chars`,
          );
          rewrittenSkillMdContent = spliceFrontmatterDescription({
            sourceName: outcome.sourceName,
            skillMdContent: skillMdSource.content.toString("utf8"),
            rewritten,
          });
          descriptionRewrite = {
            agent: activeAgent,
            rewrittenAt: new Date().toISOString(),
            originalDescriptionSha: read.originalDescriptionSha,
            rewrittenDescriptionSha: rewrittenSha,
            originalLength: read.descriptionStatus.length,
            rewrittenLength: rewritten.length,
          };
          descriptionRewrittenCount += 1;
        } catch (error) {
          const rewriteElapsed = Date.now() - rewriteT0;
          descriptionRewritesMs += rewriteElapsed;
          progress.stepComplete(
            idx,
            outcome.sourceName,
            `rewriting description via ${activeAgent}`,
            rewriteElapsed,
            "failed",
          );
          // Surfaces as `refused-other` on the outcome so other
          // skills in the run continue.
          const reason = error instanceof Error ? error.message : String(error);
          outcome.disposition = "refused-other";
          outcome.refusalReason = reason;
          outcome.target = null;
          refusedOtherCount += 1;
          continue;
        }
      }
    }

    applyWriteCandidates.push({
      outcome,
      read,
      targetDir,
      rewrittenSkillMdContent,
      ...(descriptionRewrite ? { descriptionRewrite } : {}),
    });
  }

  // #139 — apply writes are independent per target skill directory,
  // so run them through the same bounded-concurrency progress phase
  // as read+classify. Results are returned in input order by
  // runBoundedConcurrent, preserving manifest/report stability.
  const APPLY_WRITE_CONCURRENCY = 4;
  const writePhaseStart = Date.now();
  progress.beginConcurrentPhase("apply write", applyWriteCandidates.length, APPLY_WRITE_CONCURRENCY);
  try {
    const writeResults = await runBoundedConcurrent<ApplyWriteCandidate, ApplyWriteResult>(
      applyWriteCandidates,
      async (candidate) => {
        const { outcome, read, targetDir, rewrittenSkillMdContent } = candidate;
        const applyRewrites = outcome.tag === "needs-adapt";
        const writeIdx = outcomeIndexBySource.get(outcome.sourceName) ?? 0;
        progress.step(writeIdx, outcome.sourceName, "writing");
        const writeT0 = Date.now();
        const { fileShas, rewrittenFiles } = await writeSkillPayload(
          read,
          targetDir,
          applyRewrites,
          rewrittenSkillMdContent,
        );
        const elapsedMs = Date.now() - writeT0;
        progress.stepComplete(
          writeIdx,
          outcome.sourceName,
          "writing",
          elapsedMs,
          `${Object.keys(fileShas).length} files`,
        );
        return {
          ...candidate,
          fileShas,
          rewrittenFiles,
          elapsedMs,
        };
      },
      APPLY_WRITE_CONCURRENCY,
    );
    for (const result of writeResults) {
      const { outcome, fileShas, rewrittenFiles, descriptionRewrite } = result;
      applyWriteMs += result.elapsedMs;
      manifestEntries.push({
        sourceName: outcome.sourceName,
        kebabName: outcome.kebabName,
        tag: outcome.tag,
        sourceSha: outcome.sourceSha,
        fileShas,
        ...(descriptionRewrite ? { descriptionRewrite } : {}),
      });
      if (descriptionRewrite) {
        outcome.descriptionRewrite = descriptionRewrite;
      }
      // Refresh the outcome's fileCount with the count of files actually
      // landed under the skill root (always equal to source file count
      // in Phase 1; the divergence shows up under Phase 2 if any per-
      // substrate omits files).
      outcome.fileCount = Object.keys(fileShas).length;
      writtenCount += 1;

      // Stash the post-rewrite payload for the smoke pass below. We
      // don't run verify inline here so the idempotency contract is
      // unambiguous — a re-run with no source churn but a fresh
      // `--smoke <new-sub>` flag still triggers verify on the new
      // substrate, even when the skill was skipped-idempotent above.
      pendingVerifyPayloads.set(outcome.sourceName, rewrittenFiles);
    }
  } finally {
    progress.endConcurrentPhase("apply write", Date.now() - writePhaseStart);
  }

  // #115 Phase 2 — smoke pass. For each (imported skill, requested
  // substrate) pair, run static-shape verify against the projection
  // bytes. We use the in-memory post-rewrite payload when we have
  // one; otherwise (skipped-idempotent case) we re-read the on-disk
  // landed payload so a substrate added after the initial import
  // still gets a verdict.
  const substrateVerifySummary: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifySummary>> = {};
  if (smokeSubstrates.length > 0) {
    for (const substrate of smokeSubstrates) {
      substrateVerifySummary[substrate] = { verified: 0, verifiedWithWarnings: 0, failed: 0 };
    }
    // #125 — smoke verify is a separate timed phase. The
    // per-skill `[N/total] <skill> [smoke <substrate> ... <status>]`
    // emissions live INSIDE `runSmokeVerify` so the progress hook
    // is threaded through here.
    const smokeT0 = Date.now();
    await runSmokeVerify({
      smokeSubstrates,
      outcomes,
      manifestEntries,
      previousBySource,
      somaHome,
      pendingVerifyPayloads,
      readsBySource,
      summary: substrateVerifySummary,
      progress,
      outcomeIndexBySource,
    });
    smokeVerifyMs = Date.now() - smokeT0;
  }

  // Manifest timestamp policy mirrors pai-memory-migrator:
  //   - any actual write → bump timestamp.
  //   - pure idempotent rerun → preserve prior timestamp so the
  //     manifest is byte-stable.
  //
  // #115 Phase 2 — a smoke-only re-run (writtenCount=0 but new
  // verify verdicts on a substrate not previously recorded) still
  // bumps the timestamp because the manifest body changed. The
  // helper checks whether the new entries are byte-equivalent to
  // the previous ones before deciding.
  const importedAt = (() => {
    if (writtenCount > 0 || !previousManifest) return new Date().toISOString();
    const previousSubstrates = previousManifest.smokeSubstrates ?? [];
    const sameSet = previousSubstrates.length === smokeSubstrates.length &&
      smokeSubstrates.every((s) => previousSubstrates.includes(s));
    if (smokeSubstrates.length > 0 && !sameSet) return new Date().toISOString();
    // Same substrate set + no writes → manifest is byte-stable if
    // every per-skill substrate verdict matches the prior entry.
    // We treat any verdict diff as a manifest update.
    if (smokeSubstrates.length > 0) {
      const anyVerdictChanged = manifestEntries.some((entry) => {
        const prior = previousBySource.get(entry.sourceName);
        if (!prior?.substrates && !entry.substrates) return false;
        if (!prior?.substrates || !entry.substrates) return true;
        for (const substrate of smokeSubstrates) {
          const a = prior.substrates[substrate]?.status;
          const b = entry.substrates[substrate]?.status;
          if (a !== b) return true;
        }
        return false;
      });
      if (anyVerdictChanged) return new Date().toISOString();
    }
    return previousManifest.importedAt;
  })();

  const manifestLastRun = buildManifestLastRun(outcomes);
  const newManifest: ClaudeSkillsMigrationManifest = {
    schema: MANIFEST_SCHEMA,
    from,
    somaHome,
    importedAt,
    includeClaudeSpecific,
    skills: manifestEntries,
    ...(manifestLastRun ? { lastRun: manifestLastRun } : {}),
    ...(smokeSubstrates.length > 0 ? { smokeSubstrates } : {}),
  };
  await writeFile(manifestPath, renderManifest(newManifest), "utf8");
  await writeFile(
    reportPath,
    renderPortabilityReport({
      apply: true,
      from,
      somaHome,
      isFlatSkillsTree: true,
      outcomes,
      includeClaudeSpecific,
      smokeSubstrates,
      rewriteDescriptionsAgent,
      importedAt,
    }),
    "utf8",
  );

  // #125 — assemble the PhaseTimings used to render the Timing
  // block. Phases that didn't run (e.g. no smoke substrate, no
  // rewrites) carry `unit: "(not requested)"` so the renderer can
  // suppress the count gracefully.
  const totalMs = Date.now() - runStart;
  const timing: PhaseTimings = {
    totalMs,
    phases: [
      {
        name: "read + classify",
        elapsedMs: readClassifyMs,
        count: outcomes.length,
        unit: "skills",
      },
      {
        name: "description rewrites",
        elapsedMs: descriptionRewritesMs,
        count: descriptionRewrittenCount,
        unit: rewriteDescriptionsAgent === "none"
          ? "(not requested)"
          : `LLM calls via ${rewriteDescriptionsAgent}`,
      },
      {
        name: "apply write",
        elapsedMs: applyWriteMs,
        count: writtenCount,
        unit: "files",
      },
      {
        name: "smoke verify",
        elapsedMs: smokeVerifyMs,
        count: smokeSubstrates.length === 0 ? 0 : outcomes.length,
        unit: smokeSubstrates.length === 0 ? "(not requested)" : `skill × substrate pairs`,
      },
    ],
  };

  return {
    apply: true,
    from,
    somaHome,
    isFlatSkillsTree: true,
    outcomes,
    includeClaudeSpecific,
    smokeSubstrates,
    rewriteDescriptionsAgent,
    importedAt,
    manifestPath,
    reportPath,
    writtenCount,
    skippedIdempotentCount,
    skippedClaudeSpecificCount,
    refusedOtherCount,
    refusedDescriptionLimitCount,
    descriptionRewrittenCount,
    ...(smokeSubstrates.length > 0 ? { substrateVerifySummary } : {}),
    timing,
  };
}

/**
 * Status reader for `--status` mode. Returns the manifest as-is or
 * null when no migration has been applied. CLI formatter renders
 * either an empty-state hint or a per-skill summary table.
 */
export async function readClaudeSkillsMigrationStatus(
  options: ClaudeSkillsMigrationOptions,
): Promise<ClaudeSkillsMigrationManifest | null> {
  const somaHome = resolveSomaHomeOnly(options);
  return readExistingManifest(somaHome);
}
