// soma#373 — greenfield install acceptance test.
//
// Every other install test exercises `installSomaFor*` against a home that
// (within the same test) has already been bootstrapped, so a fresh-machine
// regression — a file the plan promises but apply never writes, a projected
// doc that references a path nothing ever creates, a hand-edited JSON
// fixture that stops parsing — can slip through unnoticed. This file installs
// into a completely empty `homeDir` + `somaHome` pair (nothing pre-created,
// mirroring `soma install <substrate> --home-dir <tmp> --soma-home <tmp>
// --apply` end to end: `installSomaFor*` IS what the CLI's `runInstall`
// calls — see `src/cli/substrate-lifecycle.ts`'s `installers` map) for every
// substrate on `PROJECTION_LIFECYCLE_SUBSTRATES`, then audits the result.
//
// Three acceptance checks per substrate, run by `auditProjectedFiles`:
//   1. every file the install reports as projected (`result.somaHome.files`
//      + `result.substrateHome.files`) exists on disk and is non-empty.
//   2. every projected `*.md` file is non-empty UTF-8 text; every projected
//      `*.json` file parses.
//   3. no projected file contains a dangling absolute-path reference into
//      the temp `homeDir`/`somaHome` tree (a path under one of those roots
//      that doesn't exist on disk).
//
// The "broken fixture" test below proves (2) and (3) actually catch
// breakage rather than passing vacuously.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  installSomaForClaudeCode,
  installSomaForCodex,
  installSomaForCursor,
  installSomaForGrok,
  installSomaForPiDev,
  type SomaInstallOptions,
  type SomaInstallResult,
} from "../src/index";
import { INSTALL_SUBSTRATES, PROJECTION_LIFECYCLE_SUBSTRATES, type InstallSubstrate } from "../src/cli/substrate-lifecycle";
import { defaultSubstrateHome } from "../src/install-spec-registry";

async function withGreenfieldHomes<T>(
  fn: (homeDir: string, somaHome: string) => Promise<T>,
): Promise<T> {
  // Two INDEPENDENT temp roots (not one nested under the other) — greenfield
  // means nothing pre-created, and exercises `--home-dir` / `--soma-home`
  // pointing at unrelated trees, same as a real split-home install.
  const homeDir = await mkdtemp(join(tmpdir(), "soma-greenfield-home-"));
  const somaHome = await mkdtemp(join(tmpdir(), "soma-greenfield-soma-"));
  try {
    return await fn(homeDir, somaHome);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(somaHome, { recursive: true, force: true });
  }
}

// Matches an absolute path character run (no whitespace/quote/bracket/paren)
// so `findDanglingPathReferences` can walk forward from a known root prefix
// to the end of whatever path was written after it.
const PATH_CHAR = /[A-Za-z0-9_.\-/]/;
// Punctuation a path reference commonly picks up from surrounding prose or
// markdown (a trailing sentence period, a closing backtick/paren, …) that is
// not actually part of the path.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"`]+$/;

/**
 * Every absolute-path reference in `text` that begins with one of `roots`
 * (deduplicated). Exported standalone so it — and the dangling-check built
 * on it — can be unit-tested against fixture text, not just real installs.
 */
export function extractPathReferences(text: string, roots: readonly string[]): string[] {
  const found = new Set<string>();
  for (const root of roots) {
    if (root.length === 0) continue;
    let searchFrom = 0;
    for (;;) {
      const idx = text.indexOf(root, searchFrom);
      if (idx === -1) break;
      let end = idx + root.length;
      while (end < text.length && PATH_CHAR.test(text[end])) end += 1;
      const ref = text.slice(idx, end).replace(TRAILING_PUNCTUATION, "");
      if (ref.length > root.length) found.add(ref);
      searchFrom = idx + root.length;
    }
  }
  return [...found];
}

/** Path references under `roots` that don't exist on disk and aren't exempt. */
export function findDanglingPathReferences(
  text: string,
  roots: readonly string[],
  isExempt: (ref: string) => boolean = () => false,
): string[] {
  return extractPathReferences(text, roots).filter((ref) => !existsSync(ref) && !isExempt(ref));
}

export interface ProjectionAuditProblem {
  file: string;
  reason: string;
}

/**
 * Runs the three greenfield acceptance checks against a declared set of
 * projected files. `roots` scopes the dangling-reference scan (soma#373:
 * "ignore unrelated system/example paths outside the tmp tree") — pass the
 * temp `homeDir`/`somaHome` roots for a real install, or a fixture's own
 * temp root for the broken-projection self-test below. `isExempt` lets a
 * caller declare specific referenced paths as intentionally-not-yet-existing
 * (see `isKnownLazyOrCrossSubstrateReference` below) rather than promises
 * the install broke.
 */
export async function auditProjectedFiles(
  files: readonly string[],
  roots: readonly string[],
  isExempt: (ref: string) => boolean = () => false,
): Promise<ProjectionAuditProblem[]> {
  const problems: ProjectionAuditProblem[] = [];

  for (const file of files) {
    let content: string;
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        problems.push({ file, reason: "not a regular file" });
        continue;
      }
      if (info.size === 0) {
        problems.push({ file, reason: "empty file" });
        continue;
      }
      content = await readFile(file, "utf8");
    } catch (error) {
      problems.push({ file, reason: `missing or unreadable: ${(error as Error).message}` });
      continue;
    }

    if (file.endsWith(".md") && content.trim().length === 0) {
      problems.push({ file, reason: "markdown file has no non-whitespace content" });
    }

    if (file.endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch (error) {
        problems.push({ file, reason: `invalid JSON: ${(error as Error).message}` });
      }
    }

    for (const dangling of findDanglingPathReferences(content, roots, isExempt)) {
      problems.push({ file, reason: `dangling path reference: ${dangling}` });
    }
  }

  return problems;
}

/**
 * Projected docs and runtime configs legitimately reference some paths that
 * don't exist right after a fresh `soma install` — they're not projection
 * promises, they're either (a) cross-substrate defensive policy data, or (b)
 * locations a *later*, separate command populates. Exempting them here keeps
 * the dangling-reference check honest: it still fails on a genuine stale/
 * broken reference (proven by the fixture test below), without flaring on
 * these known, intentional cases.
 *
 * Each exemption cites the source that makes the reference intentional:
 *
 * - Other substrates' default homes: adapters hard-code cross-substrate
 *   privacy protection (e.g. codex's `privateRoots` lists `.claude/memory`,
 *   `.claude/memories`, `.claude/PAI/MEMORY` even when claude-code isn't
 *   installed — src/adapters/codex/adapter.ts `codexLifecycleConfig`). This
 *   test installs exactly one substrate per run, so any other substrate's
 *   home is guaranteed absent regardless of correctness.
 * - `<somaHome>/profile/imports/**`: legacy PAI migration import
 *   destination, populated by the separate `soma migrate pai` command, not
 *   by `soma install` (documented in the generated pai-imports.md's
 *   "Read For Detail" section).
 * - `<somaHome>/imports/**`: the same migration staging root, declared
 *   defensively by policy markers (src/policy.ts `somaPolicyPrivateMarkers`)
 *   ahead of any migration ever running.
 * - `<somaHome>/memory/RAW/untrusted` and
 *   `<somaHome>/memory/SECURITY/inbound-content`: inbound-content security
 *   scan targets, created on first scan, not at bootstrap
 *   (src/inbound-security.ts `defaultInboundContentSecurityConfig`).
 * - `<somaHome>/memory/LEARNING/ALGORITHM`: completed Algorithm-run
 *   learnings, created when the first Algorithm run completes — a fresh
 *   install has run none (documented in lifecycle.md's "Source Files" list
 *   as "Completed Algorithm learnings").
 */
function isKnownLazyOrCrossSubstrateReference(
  ref: string,
  ctx: { homeDir: string; somaHome: string; substrate: InstallSubstrate },
): boolean {
  for (const otherSubstrate of INSTALL_SUBSTRATES) {
    if (otherSubstrate === ctx.substrate) continue;
    const otherHome = join(ctx.homeDir, defaultSubstrateHome(otherSubstrate));
    // cursor's defaultHome is "." (it projects directly into homeDir rather
    // than a dedicated subdir — see src/adapters/cursor/install.ts), so
    // `join(homeDir, ".")` collapses to homeDir itself. Exempting that would
    // exempt EVERY homeDir-scoped reference for every other substrate,
    // silently disabling this whole check. There is no meaningfully-separate
    // "other substrate home" to exempt in that degenerate case, so skip it.
    if (otherHome === ctx.homeDir) continue;
    if (ref === otherHome || ref.startsWith(`${otherHome}/`)) return true;
  }

  const somaRelPrefix = `${ctx.somaHome}/`;
  if (ref.startsWith(somaRelPrefix)) {
    const rel = ref.slice(somaRelPrefix.length);
    const lazyPrefixes = [
      "profile/imports",
      "imports",
      "memory/RAW/untrusted",
      "memory/SECURITY/inbound-content",
      "memory/LEARNING/ALGORITHM",
    ];
    if (lazyPrefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) return true;
  }

  return false;
}

const SUBSTRATE_INSTALLERS: Record<
  (typeof PROJECTION_LIFECYCLE_SUBSTRATES)[number],
  (options: SomaInstallOptions) => Promise<SomaInstallResult>
> = {
  codex: installSomaForCodex,
  "pi-dev": installSomaForPiDev,
  "claude-code": installSomaForClaudeCode,
  cursor: installSomaForCursor,
  grok: installSomaForGrok,
};

for (const substrate of PROJECTION_LIFECYCLE_SUBSTRATES) {
  test(`greenfield install: ${substrate} projects a clean, self-consistent home`, async () => {
    await withGreenfieldHomes(async (homeDir, somaHome) => {
      const install = SUBSTRATE_INSTALLERS[substrate];
      const result = await install({ homeDir, somaHome });

      expect(result.substrate).toBe(substrate);

      // The declared projected-file set: what the install itself reports it
      // wrote. `somaHome.files` covers the ~/.soma bootstrap; `substrateHome.
      // files` covers everything projected onto the substrate home (static +
      // post-projection + lifecycle) — see src/install.ts's `allProjectedFiles`.
      const expectedFiles = [...new Set([...result.somaHome.files, ...result.substrateHome.files])];
      expect(expectedFiles.length).toBeGreaterThan(0);

      const problems = await auditProjectedFiles(expectedFiles, [homeDir, somaHome], (ref) =>
        isKnownLazyOrCrossSubstrateReference(ref, { homeDir, somaHome, substrate }),
      );
      if (problems.length > 0) {
        throw new Error(
          `${substrate}: ${problems.length} greenfield projection problem(s):\n${problems
            .map((p) => `  - ${p.file}: ${p.reason}`)
            .join("\n")}`,
        );
      }
    });
  });
}

test("auditProjectedFiles flags a deliberately broken projection (dangling reference + malformed JSON)", async () => {
  const root = await mkdtemp(join(tmpdir(), "soma-greenfield-broken-"));
  try {
    const brokenMd = join(root, "broken.md");
    const missingTarget = join(root, "skills", "does-not-exist", "SKILL.md");
    await writeFile(
      brokenMd,
      `# Broken projection\n\nSee \`${missingTarget}\` for details.\n`,
      "utf8",
    );

    const brokenJson = join(root, "broken.json");
    await writeFile(brokenJson, "{ not valid json ", "utf8");

    const emptyMd = join(root, "empty.md");
    await writeFile(emptyMd, "", "utf8");

    const problems = await auditProjectedFiles([brokenMd, brokenJson, emptyMd], [root]);

    const reasons = problems.map((p) => `${p.file}: ${p.reason}`);
    expect(reasons.some((r) => r.includes(brokenMd) && r.includes(`dangling path reference: ${missingTarget}`))).toBe(true);
    expect(reasons.some((r) => r.includes(brokenJson) && r.includes("invalid JSON"))).toBe(true);
    expect(reasons.some((r) => r.includes(emptyMd) && r.includes("empty file"))).toBe(true);

    // And the sibling helper the audit is built on agrees directly.
    const fixtureContent = await readFile(brokenMd, "utf8");
    expect(findDanglingPathReferences(fixtureContent, [root])).toEqual([missingTarget]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auditProjectedFiles passes a clean fixture (no false positives)", async () => {
  const root = await mkdtemp(join(tmpdir(), "soma-greenfield-clean-"));
  try {
    const target = join(root, "skills", "real-skill", "SKILL.md");
    await mkdir(join(root, "skills", "real-skill"), { recursive: true });
    await writeFile(target, "# Real skill\n\nBody.\n", "utf8");

    const doc = join(root, "doc.md");
    await writeFile(doc, `# Doc\n\nSee \`${target}\` for details.\n`, "utf8");

    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ path: target }, null, 2), "utf8");

    expect(await auditProjectedFiles([target, doc, config], [root])).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
