import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CURSOR_RULES_BLOCK_BEGIN, buildSubstrateHomeProjection, mergeCursorRulesContent } from "../home-projection";
import { loadProjectionInputForDoctor } from "../doctor-projection-input";
import { defaultSomaRepoPath } from "../repo-path";
import { isEnoent } from "../fs-utils";
import { CURSOR_RULES_PATH } from "./cursor";
import { hasProvenanceHeader } from "./shared";
import type { InstallSubstrate, SomaDoctorFinding } from "../types";

/**
 * Content-compare drift (soma#370): re-render a substrate's home projection
 * in memory using the SAME builder `soma install`/`soma export` use
 * (`buildSubstrateHomeProjection`), then diff each rendered file against
 * what is actually on disk. Substrate-agnostic by construction — it needs
 * no per-substrate mtime heuristic — so it replaces the old codex/claude-code
 * profile-mtime diagnosers and, for the first time, covers cursor and
 * pi-dev (neither had ANY drift diagnosis before).
 *
 * Deliberately excludes grok: grok's `soma-lifecycle` hook, AGENTS.md
 * pointer block, and skill discovery are verified live via `grok inspect
 * --json` (`../grok/doctor.ts`) because whether Grok's RUNTIME has actually
 * loaded a file is a different, non-deterministic question from whether the
 * file's BYTES match a fresh render. Grok's rendered home-projection files
 * (skills/soma/*.md, hooks/*, personas/*, roles/*, agents/*) are themselves
 * a pure function of ProjectionInput — exactly as deterministic as codex's —
 * so this module also runs for grok, composed ALONGSIDE (not instead of)
 * the oracle-based checks in `../adapters/doctor.ts`. See that file for the
 * composition and the investigation note this decision is based on.
 */
export type ContentCompareSubstrate = Extract<InstallSubstrate, "codex" | "pi-dev" | "claude-code" | "cursor" | "grok">;

export interface ContentCompareDoctorOptions {
  substrate: ContentCompareSubstrate;
  homeDir: string;
  somaHome: string;
  /** Defaults to `defaultSomaRepoPath()`, same as `soma install`. */
  somaRepoPath?: string;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

interface DriftBuckets {
  missing: string[];
  unmanaged: string[];
  stale: string[];
}

/**
 * Classify a single mismatched file. `unmanaged` (hand-replaced) only
 * applies to files the adapter actually wraps with `withProvenance` — a
 * file that never carries the header (JSON/TOML/frontmatter/verbatim
 * scripts) has no header to lose, so any drift there is reported as `stale`
 * instead. Checking `hasProvenanceHeader` on the FRESH render (rather than
 * maintaining a separate "header-eligible paths" list) is what makes this
 * substrate-agnostic: whichever files a given adapter chose to wrap decide
 * their own classification, with nothing to keep in sync here.
 */
function classifyMismatch(freshContent: string, onDisk: string): "unmanaged" | "stale" {
  if (hasProvenanceHeader(freshContent) && !hasProvenanceHeader(onDisk)) return "unmanaged";
  return "stale";
}

/**
 * `.cursorrules` is not a plain 1:1 projected file — install splices the
 * rendered block into a possibly foreign-owned file
 * (`mergeCursorRulesContent`/`CURSOR_RULES_BLOCK_BEGIN/END`), preserving
 * every byte outside the markers. So "does this file match a fresh render"
 * means "does re-running the same merge against the CURRENT on-disk bytes
 * reproduce them unchanged" — not raw equality against the un-merged block
 * body. A raw-equality check would flag every legitimately-managed
 * `.cursorrules` as permanently stale.
 */
async function compareCursorRulesFile(substrateHome: string, freshBlockBody: string, buckets: DriftBuckets): Promise<void> {
  const path = join(substrateHome, CURSOR_RULES_PATH);
  const onDisk = await readFileOrNull(path);
  if (onDisk === null) {
    buckets.missing.push(CURSOR_RULES_PATH);
    return;
  }
  const expected = mergeCursorRulesContent(onDisk, freshBlockBody);
  if (expected === onDisk) return;
  // No Soma block markers at all: either hand-stripped, or a foreign
  // .cursorrules that predates Soma ever touching it. Either way it is not
  // currently a managed projection surface.
  if (!onDisk.includes(CURSOR_RULES_BLOCK_BEGIN)) {
    buckets.unmanaged.push(CURSOR_RULES_PATH);
  } else {
    buckets.stale.push(CURSOR_RULES_PATH);
  }
}

const SUBSTRATE_LABELS: Record<ContentCompareSubstrate, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  grok: "Grok",
  "pi-dev": "Pi.dev",
};

function buildFindings(substrate: ContentCompareSubstrate, totalFiles: number, buckets: DriftBuckets): SomaDoctorFinding[] {
  const findings: SomaDoctorFinding[] = [];
  const label = SUBSTRATE_LABELS[substrate];
  const action = `soma reproject ${substrate}`;

  if (buckets.missing.length > 0) {
    findings.push({
      id: `${substrate}-projection-missing`,
      severity: "error",
      message:
        buckets.missing.length === totalFiles
          ? `${label} projection is missing.`
          : `${label} projection file(s) missing on disk: ${buckets.missing.join(", ")}.`,
      action,
    });
  }
  if (buckets.unmanaged.length > 0) {
    findings.push({
      id: `${substrate}-projection-unmanaged-edit`,
      severity: "warning",
      message:
        `${label} projection file(s) missing the Soma provenance header (hand-edited, or left by an older ` +
        `projection): ${buckets.unmanaged.join(", ")}. Reprojecting will overwrite them — move durable changes ` +
        "into ~/.soma first.",
      action,
    });
  }
  if (buckets.stale.length > 0) {
    findings.push({
      id: `${substrate}-projection-stale`,
      severity: "warning",
      message:
        `${label} projection file(s) are out of date — the Soma source changed since the last reproject: ` +
        `${buckets.stale.join(", ")}.`,
      action,
    });
  }
  return findings;
}

export async function diagnoseContentCompareDrift(options: ContentCompareDoctorOptions): Promise<SomaDoctorFinding[]> {
  const somaRepoPath = options.somaRepoPath ?? defaultSomaRepoPath();
  let input: Awaited<ReturnType<typeof loadProjectionInputForDoctor>>;
  try {
    input = await loadProjectionInputForDoctor({ somaHome: options.somaHome, somaRepoPath });
  } catch (error) {
    // The Soma home itself was never bootstrapped, or is only partially
    // written (`soma init`/`soma bootstrap` never ran, or ran incompletely)
    // — there is no complete source to render FROM, so there is nothing
    // honest to say about substrate drift yet: reporting "missing" here
    // would claim knowledge we don't have. Mirrors the old profile-mtime
    // diagnosers' lenient default (a null profile mtime skipped the check
    // rather than reporting every file "missing"). An unbootstrapped Soma
    // home is a DIFFERENT, already-covered concern (the onboarding flow
    // guides toward `soma init`), not projection drift. Any OTHER failure
    // (permissions, a directory where a file belongs) is a genuine bug and
    // must not be swallowed.
    if (!isEnoent(error)) throw error;
    return [];
  }

  const projection = buildSubstrateHomeProjection(options.substrate, input, {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    somaRepoPath,
  });

  // `writeProjection` writes `bundle.files` sequentially onto the SAME
  // path when one repeats (e.g. codex/grok deliberately list a portable
  // `the-algorithm` skill file and then a static override at the identical
  // path — "last entry wins" is documented at that call site). A raw
  // per-entry compare would treat the shadowed earlier entry as a false
  // "stale" mismatch against what's actually on disk. Dedupe to the LAST
  // occurrence per path first so content-compare matches real write
  // semantics.
  const filesByPath = new Map<string, string>();
  for (const file of projection.bundle.files) filesByPath.set(file.path, file.content);
  const files = [...filesByPath.entries()].map(([path, content]) => ({ path, content }));

  const buckets: DriftBuckets = { missing: [], unmanaged: [], stale: [] };

  for (const file of files) {
    if (options.substrate === "cursor" && file.path === CURSOR_RULES_PATH) {
      await compareCursorRulesFile(projection.substrateHome, file.content, buckets);
      continue;
    }
    const onDisk = await readFileOrNull(join(projection.substrateHome, file.path));
    if (onDisk === null) {
      buckets.missing.push(file.path);
      continue;
    }
    if (onDisk === file.content) continue;
    const verdict = classifyMismatch(file.content, onDisk);
    buckets[verdict === "unmanaged" ? "unmanaged" : "stale"].push(file.path);
  }

  return buildFindings(options.substrate, files.length, buckets);
}
