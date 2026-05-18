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
import type {
  ClaudeSkillOutcome,
  ClaudeSkillPortabilityTag,
  ClaudeSkillsMigrationManifest,
  ClaudeSkillsMigrationManifestEntry,
  ClaudeSkillsMigrationOptions,
  ClaudeSkillsMigrationPlan,
  ClaudeSkillsMigrationResult,
} from "./types";

const MANIFEST_SCHEMA = "soma.claude-skills-migration.v1";
const MANIFEST_RELATIVE = "imports/claude-skills/.manifest.json";
const REPORT_RELATIVE = "imports/claude-skills/.portability-report.md";

// #104 parallel — editor-config symlinks (`.cursor/`, `.vscode/`,
// `.idea/`, `.fleet/`, `.zed/`) ship inside many PAI skills and are
// resolved on the principal's box to IDE-specific rule files. Treat
// them as benign noise: drop them from the import set instead of
// refusing the skill. Every OTHER symlink still refuses loud.
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/**
 * Walk every file under `<from>/<sourceName>/` recursively, refusing
 * symlinks and out-of-root escapes the same way `pai-pack-importer.ts`
 * does. Returns POSIX-relative paths.
 */
async function collectSkillFiles(skillDir: string): Promise<SkillFilePayload[]> {
  const realRoot = await realpath(skillDir);
  const out: SkillFilePayload[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(skillDir, full).split(sep).join("/");
      if (entry.name.includes("\\")) {
        throw new Error(`soma migrate claude-skills refused ambiguous path separator: ${rel}`);
      }
      if (entry.isSymbolicLink()) {
        // #104 parallel — editor-config symlinks are noise on the
        // source side and never carry portable skill content.
        // Drop silently so the skill imports without aborting.
        // Every other symlink still refuses loud (matches the
        // pack/docs importers).
        if (matchEditorConfigSymlinkDir(rel)) {
          continue;
        }
        throw new Error(`soma migrate claude-skills refused symlink path: ${rel}`);
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".hg" || entry.name === ".svn") {
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
        await visit(full);
        continue;
      }
      if (entry.isFile()) {
        const realFile = await realpath(full);
        if (!isWithinPath(realRoot, realFile)) {
          throw new Error(`soma migrate claude-skills refused path outside skill root: ${rel}`);
        }
        const content = await readFile(full);
        out.push({ relPath: rel, source: full, content });
      }
    }
  }

  await visit(skillDir);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
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

export function classifySkillPortability(files: readonly SkillFilePayload[]): ClassificationResult {
  // Pass 1: claude-specific signals (highest priority).
  for (const file of files) {
    const text = file.content.toString("utf8");
    if (HOOK_BINDING.test(text)) {
      const sample = HOOK_BINDING.exec(text)?.[0]?.trim() ?? "hook binding";
      return {
        tag: "claude-specific",
        reason: `hook binding detected in ${file.relPath} (${sample.slice(0, 32)})`,
      };
    }
    if (!isProseFile(file.relPath)) continue;
    const stripped = stripCodeBlocks(text);
    if (SLASH_COMMAND_REF.test(stripped)) {
      const sample = SLASH_COMMAND_REF.exec(stripped)?.[0]?.trim() ?? "/slash-command";
      return {
        tag: "claude-specific",
        reason: `slash-command reference detected in ${file.relPath} (${sample.slice(0, 32)})`,
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
}

async function readSourceSkill(
  fromDir: string,
  sourceName: string,
): Promise<SourceSkillReadResult> {
  const skillDir = join(fromDir, sourceName);
  const skillMdPath = join(skillDir, "SKILL.md");
  if (!(await pathExists(skillMdPath))) {
    throw new Error(`soma migrate claude-skills: ${sourceName}/SKILL.md not found.`);
  }
  const files = await collectSkillFiles(skillDir);
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
  return {
    sourceName,
    kebabName: kebabSlug(sourceName),
    files,
    sourceSha: sha256Hex(Buffer.from(composite, "utf8")),
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
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const skillMdPath = join(fromDir, entry.name, "SKILL.md");
    if (await pathExists(skillMdPath)) {
      // Symlinked SKILL.md is refused — same loud-fail bar as
      // every other path in this importer.
      const stat = await lstat(skillMdPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`soma migrate claude-skills refused symlinked SKILL.md: ${entry.name}/SKILL.md`);
      }
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
    const skills = parsed.skills as Array<Record<string, unknown>>;
    for (const entry of skills) {
      if (typeof entry?.sourceName !== "string" || typeof entry?.sourceSha !== "string") {
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

async function buildPlanCore(
  fromDir: string,
  somaHome: string,
  includeClaudeSpecific: boolean,
  prevManifest: ClaudeSkillsMigrationManifest | null,
): Promise<PlanResult> {
  const names = await listFlatSkillNames(fromDir);
  if (names.length === 0) {
    return { isFlatSkillsTree: false, outcomes: [], reads: [] };
  }

  // Bounded concurrency for the read + classify pass — per-skill work
  // is independent and dominated by file I/O, same as the memory
  // migrator (4-wide).
  const reads = await runBoundedConcurrent(
    names,
    async (name) => readSourceSkill(fromDir, name),
    4,
  );

  const prevBySource = new Map<string, ClaudeSkillsMigrationManifestEntry>();
  if (prevManifest) {
    for (const entry of prevManifest.skills) {
      prevBySource.set(entry.sourceName, entry);
    }
  }

  const outcomes: ClaudeSkillOutcome[] = reads.map((read) => {
    const classification = classifySkillPortability(read.files);
    const target = join(somaHome, "skills", read.kebabName);
    let disposition: ClaudeSkillOutcome["disposition"];
    if (classification.tag === "claude-specific" && !includeClaudeSpecific) {
      disposition = "skipped-claude-specific";
    } else {
      const prior = prevBySource.get(read.sourceName);
      if (prior?.sourceSha === read.sourceSha && prior?.tag === classification.tag) {
        disposition = "skipped-idempotent";
      } else {
        disposition = "imported";
      }
    }
    return {
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
    };
  });
  outcomes.sort((a, b) => a.sourceName.localeCompare(b.sourceName));

  return { isFlatSkillsTree: true, outcomes, reads };
}

export async function planClaudeSkillsMigration(
  options: ClaudeSkillsMigrationOptions,
): Promise<ClaudeSkillsMigrationPlan> {
  const { from, somaHome } = resolveHomes(options);
  const includeClaudeSpecific = options.includeClaudeSpecific === true;
  // Plan mode reads any existing manifest so the dispositions match
  // what an `--apply` invocation would do (e.g. a re-run on unchanged
  // source shows `skipped-idempotent`, not `imported`).
  const prevManifest = await readExistingManifest(somaHome);
  const { isFlatSkillsTree, outcomes } = await buildPlanCore(
    from,
    somaHome,
    includeClaudeSpecific,
    prevManifest,
  );
  return {
    apply: false,
    from,
    somaHome,
    isFlatSkillsTree,
    outcomes,
    includeClaudeSpecific,
  };
}

async function writeSkillPayload(
  read: SourceSkillReadResult,
  targetDir: string,
  applyRewrites: boolean,
): Promise<{ fileShas: Record<string, string> }> {
  // Make sure the target directory tree exists. Per-file `mkdir` of
  // the parent happens inside the loop so deep payloads
  // (`Workflows/SubDir/file.md`) work without precomputed dir lists.
  await mkdir(targetDir, { recursive: true });
  const fileShas: Record<string, string> = {};

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
    if (applyRewrites && isText) {
      const original = file.content.toString("utf8");
      const { content: rewritten } = normalizeSkillContent(file.relPath, original);
      const bytes = Buffer.from(rewritten, "utf8");
      await writeFile(target, bytes);
      fileShas[file.relPath] = sha256Hex(bytes);
    } else {
      await copyFile(file.source, target);
      fileShas[file.relPath] = sha256Hex(file.content);
    }
  }

  return { fileShas };
}

function renderManifest(manifest: ClaudeSkillsMigrationManifest): string {
  // JSON.stringify with 2-space indent + trailing newline matches the
  // pai-memory-migrator and pai-docs-importer manifest format. Entries
  // sorted by kebabName so byte-stable reruns produce byte-stable
  // manifests.
  const sorted: ClaudeSkillsMigrationManifest = {
    ...manifest,
    skills: [...manifest.skills].sort((a, b) => a.kebabName.localeCompare(b.kebabName)),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function renderPortabilityReport(
  result: ClaudeSkillsMigrationPlan & { importedAt: string },
): string {
  // AC-5 — markdown report. Always written on the apply path so the
  // principal has a per-skill audit trail next to the manifest.
  // Header documents the heuristic's limits (AC-4 transparency).
  const lines: string[] = [];
  lines.push("# Claude Skills Portability Report");
  lines.push("");
  lines.push(`Source: ${result.from}`);
  lines.push(`Generated: ${result.importedAt}`);
  lines.push(`Include claude-specific: ${result.includeClaudeSpecific ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Classifier rules (Phase 1, heuristic)");
  lines.push("");
  lines.push("- **claude-specific** — hook binding (`Stop:`, `UserPromptSubmit:`, `PreToolUse:`, `PostToolUse:`, `SessionStart:`, `SubagentStop:`, `Notification:`, `PreCompact:`) OR `/<slash-command>` reference in prose (outside fenced code blocks).");
  lines.push("- **needs-adapt** — `~/.claude/...` path reference(s); rewritten via `pai-pack-normalizer.ts` deterministic rewrite table.");
  lines.push("- **portable** — no Claude-specific signal detected.");
  lines.push("");
  lines.push("Phase 1 is regex-based; subtle Claude-only behavior in prose that doesn't trip these signals can still slip through as `portable`. Phase 2 (`--smoke <substrate>`) will add per-substrate projection verify to turn the verdict from heuristic to verified.");
  lines.push("");
  lines.push("## Per-skill outcomes");
  lines.push("");
  lines.push("| Skill | Tag | Disposition | Reason |");
  lines.push("|---|---|---|---|");
  for (const o of result.outcomes) {
    lines.push(`| ${o.kebabName} | ${o.tag} | ${o.disposition} | ${o.reason} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function migrateClaudeSkills(
  options: ClaudeSkillsMigrationOptions,
): Promise<ClaudeSkillsMigrationResult> {
  const { from, somaHome } = resolveHomes(options);
  const includeClaudeSpecific = options.includeClaudeSpecific === true;

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

  const { isFlatSkillsTree, outcomes, reads } = await buildPlanCore(
    from,
    somaHome,
    includeClaudeSpecific,
    previousManifest,
  );

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

  // Apply phase: walk the outcome list, write payloads for imported
  // skills, carry prior manifest entries for `skipped-idempotent`.
  const manifestEntries: ClaudeSkillsMigrationManifestEntry[] = [];
  let writtenCount = 0;
  let skippedIdempotentCount = 0;
  let skippedClaudeSpecificCount = 0;

  for (const outcome of outcomes) {
    if (outcome.disposition === "skipped-claude-specific") {
      skippedClaudeSpecificCount += 1;
      continue;
    }
    if (outcome.disposition === "skipped-idempotent") {
      skippedIdempotentCount += 1;
      const prior = previousBySource.get(outcome.sourceName);
      if (prior) {
        manifestEntries.push(prior);
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
    // `needs-adapt` runs through the normalizer; `portable` and
    // (when `--include-claude-specific`) `claude-specific` are
    // pass-through. Running the normalizer on portable skills is
    // safe (it's a no-op when no signals fire) but skipping the
    // copy-byte-rewrite branch keeps the source SHA equal to the
    // landed SHA for portable skills, which simplifies the audit
    // trail.
    const applyRewrites = outcome.tag === "needs-adapt";
    const { fileShas } = await writeSkillPayload(read, targetDir, applyRewrites);
    manifestEntries.push({
      sourceName: outcome.sourceName,
      kebabName: outcome.kebabName,
      tag: outcome.tag,
      sourceSha: outcome.sourceSha,
      fileShas,
    });
    // Refresh the outcome's fileCount with the count of files actually
    // landed under the skill root (always equal to source file count
    // in Phase 1; the divergence shows up under Phase 2 if any per-
    // substrate omits files).
    outcome.fileCount = Object.keys(fileShas).length;
    writtenCount += 1;
  }

  // Manifest timestamp policy mirrors pai-memory-migrator:
  //   - any actual write → bump timestamp.
  //   - pure idempotent rerun → preserve prior timestamp so the
  //     manifest is byte-stable.
  const importedAt =
    writtenCount === 0 && previousManifest
      ? previousManifest.importedAt
      : new Date().toISOString();

  const newManifest: ClaudeSkillsMigrationManifest = {
    schema: MANIFEST_SCHEMA,
    from,
    somaHome,
    importedAt,
    includeClaudeSpecific,
    skills: manifestEntries,
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
      importedAt,
    }),
    "utf8",
  );

  return {
    apply: true,
    from,
    somaHome,
    isFlatSkillsTree: true,
    outcomes,
    includeClaudeSpecific,
    importedAt,
    manifestPath,
    reportPath,
    writtenCount,
    skippedIdempotentCount,
    skippedClaudeSpecificCount,
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
