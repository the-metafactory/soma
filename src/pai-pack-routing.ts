import { kebabSlug } from "./pai-pack-slug";
import type { PaiPackImportFile } from "./types";

export type PaiPackRenderMode = "copy" | "skill" | "skill-body" | "manifest" | "archive-manifest";
export type PaiPackRouteRoot = "skill" | "archive";

/**
 * Routing result for a single pack-relative source path.
 *
 * `skillName` (#105):
 *   - `null` when the file belongs to the FLAT top-level skill (pack
 *     name kebab-cased). The caller already knows the pack-level slug.
 *   - A kebab-cased nested skill name (e.g. `"remotion"`) when the file
 *     belongs to a nested bundle at `src/<Name>/...`. The caller routes
 *     it under `<somaHome>/skills/<skillName>/<relativePath>`.
 *
 * `relativePath` is always relative to the eventual skill root —
 * stripped of the `src/<Name>/` (or `src/`) prefix that lives upstream
 * of the routed shape. The caller composes the absolute target by
 * joining `<somaHome>` + `skills` + the resolved skill slug + this.
 *
 * Archive routes still carry `relativePath` rooted at the archive's
 * source/ subtree so the original pack layout survives intact.
 */
export interface PaiPackRoute {
  classification: PaiPackImportFile["classification"];
  root: PaiPackRouteRoot;
  relativePath: string;
  renderMode: Extract<PaiPackRenderMode, "copy" | "skill" | "skill-body">;
  /**
   * Nested skill slug when the route belongs to a `src/<Name>/...`
   * bundle (#105); `null` for top-level FLAT files and for archive
   * routes. Always lower-case kebab.
   */
  skillName: string | null;
}

const SOURCE_DOC_TARGETS: Record<string, string> = {
  "README.md": "PAI-PACK-README.md",
  "INSTALL.md": "PAI-PACK-INSTALL.md",
  "VERIFY.md": "PAI-PACK-VERIFY.md",
};

const TEMPLATE_PREFIXES = ["src/DashboardTemplate/", "src/ReportTemplate/"];
const PORTABLE_PREFIXES = ["src/Workflows/", "src/Tools/"];

/**
 * Recognized subdirectories under a nested skill bundle. Mirrors the
 * issue-105 contract table.
 *
 *   src/<Name>/SKILL.md         → portable (skill entry)
 *   src/<Name>/Workflows/<r>    → portable
 *   src/<Name>/Tools/<r>        → portable
 *   src/<Name>/References/<r>   → portable
 *   src/<Name>/Examples/<r>     → portable
 *   src/<Name>/<other>          → substrate-specific (archive)
 */
const NESTED_PORTABLE_SUBDIRS = ["Workflows", "Tools", "References", "Examples"] as const;

function stripSrcPrefix(path: string): string {
  return path.slice("src/".length);
}

/**
 * Lower-case kebab transform for nested skill folder names. Delegates
 * to `kebabSlug` so a `src/ExtractWisdom/` dir lands at
 * `~/.soma/skills/extract-wisdom/`. Single-source — see
 * `src/pai-pack-slug.ts` for the pipeline + Sage r1 #108 rationale.
 */
export function kebabNestedName(name: string): string {
  return kebabSlug(name);
}

/**
 * Match `src/<Name>/<rest>` and return the `<Name>` segment (raw, not
 * kebabed). `null` if the path doesn't have that shape.
 */
function nestedDirName(path: string): string | null {
  if (!path.startsWith("src/")) return null;
  const tail = path.slice("src/".length);
  const slash = tail.indexOf("/");
  if (slash === -1) return null; // bare file at src root
  return tail.slice(0, slash);
}

/**
 * Classify a pack-relative source path into a route.
 *
 * The `nestedSkills` set names the raw (pre-kebab) `<Name>` of every
 * `src/<Name>/SKILL.md` found in the pack. The router uses it to
 * distinguish a recognized nested bundle (`src/Remotion/Workflows/...`)
 * from a generic sibling subdirectory that should stay substrate-
 * specific (`src/Art/Lib/...`).
 *
 * The detection rule (issue 105): a `<Name>` is nested iff
 * `src/<Name>/SKILL.md` exists in the pack file set. The caller MUST
 * compute the set BEFORE invoking the router. Without `SKILL.md` the
 * dir isn't a skill — its files stay substrate-specific.
 */
export function routePaiPackSourceFile(
  path: string,
  nestedSkills: ReadonlySet<string> = new Set(),
): PaiPackRoute {
  const sourceDocTarget = SOURCE_DOC_TARGETS[path];
  if (sourceDocTarget) {
    return {
      classification: "source-doc",
      root: "skill",
      relativePath: `references/${sourceDocTarget}`,
      renderMode: "copy",
      skillName: null,
    };
  }

  if (TEMPLATE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return {
      classification: "template",
      root: "skill",
      relativePath: stripSrcPrefix(path),
      renderMode: "copy",
      skillName: null,
    };
  }

  // #105 — `src/SKILL.md` is the FLAT entry; always route to the
  // pack-level skill (no nested override possible — `nestedDirName`
  // returns null for bare files under src/).
  if (path === "src/SKILL.md") {
    return {
      classification: "portable",
      root: "skill",
      relativePath: "SKILL.md",
      renderMode: "skill",
      skillName: null,
    };
  }

  // #105 (Sage r2 #108 CodeQuality important) — nested-skill detection
  // MUST run before the FLAT `PORTABLE_PREFIXES` check; otherwise a
  // pack with `src/Tools/SKILL.md` (or `src/Workflows/SKILL.md`) is
  // misrouted as a flat portable file with `skillName: null` instead
  // of a nested `tools` (or `workflows`) skill. The detection rule
  // (nested iff `src/<Name>/SKILL.md` exists in the file set) is
  // structural — `nestedSkills` already encodes that fact, so we can
  // safely intercept here without breaking standard FLAT packs whose
  // nested set is empty.
  const nestedName = nestedDirName(path);
  if (nestedName !== null && nestedSkills.has(nestedName)) {
    const tail = path.slice(`src/${nestedName}/`.length);
    const slug = kebabNestedName(nestedName);
    // src/<Name>/SKILL.md — nested skill entry.
    if (tail === "SKILL.md") {
      return {
        classification: "portable",
        root: "skill",
        relativePath: "SKILL.md",
        renderMode: "skill",
        skillName: slug,
      };
    }
    // src/<Name>/{Workflows,Tools,References,Examples}/<rest>
    const firstSlash = tail.indexOf("/");
    if (firstSlash !== -1) {
      const subdir = tail.slice(0, firstSlash);
      if ((NESTED_PORTABLE_SUBDIRS as readonly string[]).includes(subdir)) {
        return {
          classification: "portable",
          root: "skill",
          relativePath: tail,
          renderMode: tail.endsWith(".md") ? "skill-body" : "copy",
          skillName: slug,
        };
      }
    }
    // src/<Name>/<other> — known nested skill but not a recognized subdir.
    // Fall through to substrate-specific (archive).
    return {
      classification: "substrate-specific",
      root: "archive",
      relativePath: `source/${path}`,
      renderMode: "copy",
      skillName: null,
    };
  }

  // FLAT pack portable: `src/Workflows/*` and `src/Tools/*` at the
  // pack root (no nested override). The nested branch above already
  // intercepted any case where `Workflows` / `Tools` was the name of
  // a nested skill, so this branch is unambiguously the FLAT one.
  if (PORTABLE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    const renderMode: Extract<PaiPackRenderMode, "copy" | "skill" | "skill-body"> =
      path.endsWith(".md") ? "skill-body" : "copy";
    return {
      classification: "portable",
      root: "skill",
      relativePath: stripSrcPrefix(path),
      renderMode,
      skillName: null,
    };
  }

  return {
    classification: "substrate-specific",
    root: "archive",
    relativePath: `source/${path}`,
    renderMode: "copy",
    skillName: null,
  };
}
