/**
 * #106 — Noise denylist: editor/IDE/language infrastructure files
 * that are silently skipped during pack import.
 *
 * These files are NOT skill content. Pre-#106 they ended up in the
 * `substrate-specific` catch-all (now `unrecognized-layout`) and
 * polluted refusal lists with hundreds of `.gitignore` / `bun.lock` /
 * `.vscode/...` entries the principal had no actionable interest in.
 *
 * Detection happens at routing time (well before any refusal
 * accounting) so noise files never end up in `PaiPackUnrecognizedLayoutRefusal.files`.
 * Each match emits a `skipped-noise-file` audit action so reviewers
 * can still see which files the pack carried.
 *
 * The single-source list also feeds the `EDITOR_CONFIG_DIRS` constant
 * (re-exported below) so the #104 symlink denylist
 * (`.cursor/.vscode/.idea/.fleet/.zed`) and the #106 regular-file
 * denylist stay in sync — same dirs, both kinds of contents skipped.
 *
 * Patterns are matched against the POSIX-style pack-relative path so
 * the same expressions work on macOS/Linux (no \ vs / drift) and tests
 * stay portable.
 */

/**
 * Editor/IDE configuration directories whose ENTIRE contents are
 * noise. Shared between this module (regular files) and
 * `pai-pack-importer.ts` (symlink denylist from #104).
 *
 * Each entry is a bare directory name. The matcher walks the
 * POSIX-style relative path and considers any segment equal to one of
 * these as a hit (so `.vscode/launch.json`, `nested/.idea/x.md`, and
 * `src/Workflows/.cursor/rules/r.md` all skip).
 */
export const EDITOR_CONFIG_DIRS = [".cursor", ".vscode", ".idea", ".fleet", ".zed"] as const;

/**
 * Categorize a noise match so the audit `detail` field tells reviewers
 * WHY the file was skipped without re-running the regex against
 * `kind`. Visible in `soma-pack.json` under `normalization.actions`.
 */
type NoiseCategory =
  | "vcs-config"
  | "editor-config"
  | "ide-config"
  | "lockfile"
  | "manifest"
  | "lint-config"
  | "build-cache"
  | "os-metadata";

/**
 * Match-by-basename patterns. The simplest rules: if the file's basename
 * matches any of these (case-sensitive on the canonical POSIX path), it's
 * noise. `package.json` and `tsconfig*.json` are sibling-conditional
 * and live in a separate code path (see `isNoiseFile`).
 */
const NOISE_BASENAME_PATTERNS: { pattern: RegExp; category: NoiseCategory }[] = [
  { pattern: /^\.gitignore$/, category: "vcs-config" },
  { pattern: /^\.gitattributes$/, category: "vcs-config" },
  { pattern: /^\.editorconfig$/, category: "editor-config" },
  { pattern: /^\.eslintrc(?:\..+)?$/, category: "lint-config" },
  { pattern: /^\.prettierrc(?:\..+)?$/, category: "lint-config" },
  { pattern: /^\.npmrc$/, category: "manifest" },
  { pattern: /^\.nvmrc$/, category: "manifest" },
  { pattern: /^bun\.lock$/, category: "lockfile" },
  { pattern: /^bun\.lockb$/, category: "lockfile" },
  { pattern: /^package-lock\.json$/, category: "lockfile" },
  { pattern: /^yarn\.lock$/, category: "lockfile" },
  { pattern: /^pnpm-lock\.yaml$/, category: "lockfile" },
  // Build caches. `.tsbuildinfo` files can sit anywhere — match by
  // suffix not basename.
  { pattern: /\.tsbuildinfo$/, category: "build-cache" },
  // OS metadata
  { pattern: /^\.DS_Store$/, category: "os-metadata" },
  { pattern: /^Thumbs\.db$/, category: "os-metadata" },
];

/**
 * Test whether the path falls inside one of the editor/IDE config
 * directories. Returns the matched dir name (for audit `detail`) or
 * `null`. Match is on POSIX-style path segments so substring
 * collisions (e.g. `my.cursor.dir/`) don't trigger a false positive.
 */
function matchEditorConfigDir(relativePosixPath: string): string | null {
  const segments = relativePosixPath.split("/");
  for (const dir of EDITOR_CONFIG_DIRS) {
    if (segments.includes(dir)) return dir;
  }
  return null;
}

/**
 * Match a manifest-style filename (`package.json`, `tsconfig.json`,
 * `tsconfig.*.json`) that becomes noise only if no `SKILL.md` sibling
 * exists at the same directory level. With a sibling, the manifest is
 * presumed to be skill-related and the router classifies it normally
 * (likely `unrecognized-layout` — still refused unless
 * `--include-unrecognized` — but never silently dropped).
 *
 * Returns the category if the basename matches the manifest shape,
 * else `null`. The sibling-check is the caller's responsibility.
 */
function matchSiblingConditionalManifest(basename: string): NoiseCategory | null {
  if (basename === "package.json") return "manifest";
  if (basename === "tsconfig.json") return "manifest";
  if (/^tsconfig\..+\.json$/.test(basename)) return "manifest";
  return null;
}

export interface NoiseMatch {
  /** The category written into the audit `detail` field. */
  category: string;
  /** Human-readable detail string (matched pattern, dir, etc.). */
  detail: string;
}

/**
 * Decide whether a single pack-relative path is noise.
 *
 * `path` MUST be POSIX-style (forward slashes). The caller should
 * already have normalized backslashes — `collectFiles` does this.
 *
 * `siblingSet` is a Set of every POSIX path in the pack (the full
 * enumerated file list). Used ONLY to evaluate the sibling rule for
 * `package.json` / `tsconfig*.json`. Pass an empty set to disable the
 * sibling check (treats manifests as noise unconditionally — the
 * issue-106 contract requires the sibling rule, so callers should
 * pass the real set).
 *
 * Returns `NoiseMatch | null`.
 */
export function detectNoiseFile(path: string, siblingSet: ReadonlySet<string>): NoiseMatch | null {
  // 1. Editor/IDE dir denylist — anywhere along the path.
  const editorDir = matchEditorConfigDir(path);
  if (editorDir !== null) {
    return { category: "ide-config", detail: `under ${editorDir}/` };
  }

  // 2. Basename patterns (lockfiles, VCS config, lint config, etc.).
  const slash = path.lastIndexOf("/");
  const basename = slash === -1 ? path : path.slice(slash + 1);
  const dirPath = slash === -1 ? "" : path.slice(0, slash);
  for (const { pattern, category } of NOISE_BASENAME_PATTERNS) {
    if (pattern.test(basename)) {
      return { category, detail: `matched ${pattern.source}` };
    }
  }

  // 3. Sibling-conditional manifests. `package.json` / `tsconfig*.json`
  //    only become noise when there's NO `SKILL.md` at the same
  //    directory level — without that anchor we can't trust the
  //    manifest is a pure dep manifest (it might describe the pack
  //    itself).
  const manifestCategory = matchSiblingConditionalManifest(basename);
  if (manifestCategory !== null) {
    const siblingSkill = dirPath === "" ? "SKILL.md" : `${dirPath}/SKILL.md`;
    if (!siblingSet.has(siblingSkill)) {
      return { category: manifestCategory, detail: `${basename} with no SKILL.md sibling` };
    }
  }

  return null;
}

/**
 * Bulk-classify the pack's enumerated file list. Returns the
 * remaining (non-noise) files plus an audit row per skipped file.
 *
 * The result preserves input order so downstream routing remains
 * deterministic (matches `collectFiles`'s sort contract).
 */
export interface NoisePartition {
  kept: string[];
  skipped: { path: string; match: NoiseMatch }[];
}

export function partitionNoise(files: readonly string[]): NoisePartition {
  const siblingSet = new Set(files);
  const kept: string[] = [];
  const skipped: { path: string; match: NoiseMatch }[] = [];
  for (const path of files) {
    const match = detectNoiseFile(path, siblingSet);
    if (match) {
      skipped.push({ path, match });
    } else {
      kept.push(path);
    }
  }
  return { kept, skipped };
}
