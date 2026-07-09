import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CURSOR_RULES_BLOCK_BEGIN, buildSubstrateHomeProjection, mergeCursorRulesContent } from "../home-projection";
import { loadProjectionInputForDoctor } from "../doctor-projection-input";
import { defaultSomaRepoPath } from "../repo-path";
import { isEnoent } from "../fs-utils";
import { CURSOR_RULES_PATH } from "./cursor";
import { hasProvenanceHeader } from "./shared";
import type { InstallSubstrate, SomaDoctorFinding } from "../types";

// The leading heading of a legacy full-file `.cursorrules` projection —
// mirrors the literal `mergeCursorRulesContent` (home-projection.ts),
// `renderCursorRules` (adapters/cursor.ts), and the cursor uninstall guard
// (adapters/cursor/install.ts) key on. Kept in lockstep so the doctor's
// "is this managed" test matches what install actually splices/overwrites.
const CURSOR_LEGACY_FULL_FILE_HEADING = "# Soma Cursor Projection";

/**
 * Content-compare drift (soma#370): rebuild a substrate's home projection
 * in memory using the SAME builder `soma install`/`soma export` use
 * (`buildSubstrateHomeProjection`), then diff each projected file against
 * what is actually on disk. Substrate-agnostic by construction — it needs
 * no per-substrate mtime heuristic — so it replaces the old codex/claude-code
 * profile-mtime diagnosers and, for the first time, covers cursor and
 * pi-dev (neither had ANY drift diagnosis before).
 *
 * Covers ALL 5 install substrates, grok included: grok's projected
 * home files (skills/soma/*.md, hooks/*, personas/*, roles/*, agents/*) are a
 * pure function of ProjectionInput — exactly as deterministic as codex's — so
 * content-compare is meaningful for them. For grok this runs ALONGSIDE (not
 * instead of) the `grok inspect --json` oracle checks in `../grok/doctor.ts`:
 * whether Grok's RUNTIME has actually loaded a file is a different,
 * complementary question from whether the file's BYTES match a fresh
 * projection. `../adapters/doctor.ts` composes the two for grok; see that
 * file for the composition and the investigation note behind it.
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

/** Per-file comparison outcome. `clean` contributes to no bucket. */
type FileVerdict = "clean" | "missing" | "unmanaged" | "stale";

/**
 * Classify a single mismatched file. `unmanaged` (hand-replaced) only
 * applies to files the adapter actually wraps with `withProvenance` — a
 * file that never carries the header (JSON/TOML/frontmatter/verbatim
 * scripts) has no header to lose, so any drift there is reported as `stale`
 * instead. Checking `hasProvenanceHeader` on the FRESH projection (rather than
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
 * projected block into a possibly foreign-owned file
 * (`mergeCursorRulesContent`/`CURSOR_RULES_BLOCK_BEGIN/END`), preserving
 * every byte outside the markers. So "does this file match a fresh projection"
 * means "does re-running the same merge against the CURRENT on-disk bytes
 * reproduce them unchanged" — not raw equality against the un-merged block
 * body. A raw-equality check would flag every legitimately-managed
 * `.cursorrules` as permanently stale.
 */
async function classifyCursorRulesFile(substrateHome: string, freshBlockBody: string): Promise<FileVerdict> {
  const onDisk = await readFileOrNull(join(substrateHome, CURSOR_RULES_PATH));
  if (onDisk === null) return "missing";
  const expected = mergeCursorRulesContent(onDisk, freshBlockBody);
  if (expected === onDisk) return "clean";
  // Mirror `mergeCursorRulesContent`'s own definition of "Soma-managed" — the
  // doctor and the writer must never disagree on what counts as managed. A
  // file is managed when it carries the Soma block markers OR is a legacy
  // full-file projection that STARTS WITH the Soma heading (that is exactly
  // the pair `mergeCursorRulesContent` splices/overwrites). A managed file
  // that no longer matches is `stale`; only a file with NEITHER signal is a
  // foreign / hand-replaced `.cursorrules` → `unmanaged`. Missing the legacy
  // full-file case here would misreport an old managed projection whose
  // content merely lags as hand-replaced (sage#450 r4).
  const managed =
    onDisk.includes(CURSOR_RULES_BLOCK_BEGIN) || onDisk.startsWith(CURSOR_LEGACY_FULL_FILE_HEADING);
  return managed ? "stale" : "unmanaged";
}

/**
 * Classify one projected file against disk. Pure per-file work (a single
 * read plus a comparison) so the caller can run every file concurrently —
 * doctor latency becomes the MAX read, not the SUM. Order is reimposed by
 * the caller, so returning a verdict here (rather than mutating shared
 * buckets) keeps the concurrency race-free and the findings deterministic.
 */
async function classifyProjectedFile(
  substrateHome: string,
  substrate: ContentCompareSubstrate,
  file: { path: string; content: string },
): Promise<FileVerdict> {
  if (substrate === "cursor" && file.path === CURSOR_RULES_PATH) {
    return classifyCursorRulesFile(substrateHome, file.content);
  }
  const onDisk = await readFileOrNull(join(substrateHome, file.path));
  if (onDisk === null) return "missing";
  if (onDisk === file.content) return "clean";
  return classifyMismatch(file.content, onDisk);
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
    // The Soma home was never installed, or is only partially written
    // (`soma install`/`soma init` never ran, or ran incompletely) — there is
    // no complete source to build the projection FROM, so NO comparison could
    // be performed. Do NOT fail open by returning `[]` (which reads as
    // "clean/ok" and would claim coverage we never did): emit an explicit
    // `info` "not diagnosable" finding instead. `info` keeps `soma doctor`
    // exit 0 — a legitimately-uninstalled home must not hard-fail CI — while
    // the output plainly says "not diagnosed", never a bare "ok" (sage#450
    // r2). Reporting "missing" would be equally dishonest: we cannot know what
    // SHOULD be on disk without the source. Any OTHER failure (permissions, a
    // directory where a file belongs) is a genuine bug and must not be
    // swallowed.
    if (!isEnoent(error)) throw error;
    return [{
      id: `${options.substrate}-not-diagnosable`,
      severity: "info",
      message:
        `Cannot diagnose ${SUBSTRATE_LABELS[options.substrate]} projection drift — Soma is not installed, or ` +
        "the Soma home is incomplete, so the source projection cannot be built to compare against. No comparison was performed.",
      action: `soma install ${options.substrate}`,
    }];
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

  // Read + classify every file concurrently (each is an independent read),
  // so doctor latency is the MAX file read, not the SUM. `Promise.all`
  // preserves input order, so folding verdicts back in `files` order below
  // keeps the per-bucket path lists — and thus the findings and their
  // messages — deterministic for tests and stable output.
  const verdicts = await Promise.all(
    files.map((file) => classifyProjectedFile(projection.substrateHome, options.substrate, file)),
  );

  const buckets: DriftBuckets = { missing: [], unmanaged: [], stale: [] };
  files.forEach((file, index) => {
    const verdict = verdicts[index];
    if (verdict !== "clean") buckets[verdict].push(file.path);
  });

  return buildFindings(options.substrate, files.length, buckets);
}
