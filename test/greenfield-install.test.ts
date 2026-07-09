// soma#373 — greenfield install acceptance test.
//
// Every other install test exercises the `installSomaFor*` functions against
// a home that (within the same test) has already been bootstrapped, so a fresh-machine
// regression — a file the plan promises but apply never writes, a projected
// doc that references a path nothing ever creates, a hand-edited JSON
// fixture that stops parsing — can slip through unnoticed. This file drives
// the REAL CLI install path — `parseInstallArgs(["install", <substrate>,
// "--home-dir", <tmp>, "--soma-home", <tmp>, "--apply"])` fed through
// `runSubstrateLifecycleCli` (src/cli/substrate-lifecycle.ts) — so it
// exercises argv parsing, dispatch, and the `--apply` gate, not just the
// installer function. It runs for every substrate on
// `PROJECTION_LIFECYCLE_SUBSTRATES` against empty existing temp roots, then
// audits what actually landed on disk.
//
// `runSubstrateLifecycleCli` returns a formatted string, not a structured
// file list, so the audit's file SET is derived two ways (soma#373 sanctions
// either): the static install PLAN's declared files (asserted present on
// disk — the "declared promise kept" check), plus a full walk of the temp
// roots (every projected file, including dynamic bundled-skill/lifecycle
// output the static plan omits) which feeds the content checks.
//
// Three acceptance checks, run by `auditProjectedFiles`:
//   1. every projected file that landed exists on disk and is non-empty; and
//      every file the static plan declares is among them (declared→landed).
//   2. every projected text file (`.md`, `.json`, and other non-binary
//      projected extensions) decodes as valid UTF-8 under a FATAL decoder —
//      a lone continuation byte or truncated multibyte sequence fails rather
//      than silently becoming U+FFFD. Additionally every `.md` has
//      non-whitespace content and every `.json` parses.
//   3. no projected file contains a dangling absolute-path reference into
//      the temp `homeDir`/`somaHome` tree (a path under one of those roots
//      that doesn't exist on disk).
//
// The "broken fixture" test below proves (2) and (3) actually catch
// breakage rather than passing vacuously.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  planSomaForClaudeCodeInstall,
  planSomaForCodexInstall,
  planSomaForCursorInstall,
  planSomaForGrokInstall,
  planSomaForPiDevInstall,
  type SomaInstallOptions,
  type SomaInstallPlan,
} from "../src/index";
import {
  INSTALL_SUBSTRATES,
  PROJECTION_LIFECYCLE_SUBSTRATES,
  parseInstallArgs,
  runSubstrateLifecycleCli,
  type InstallSubstrate,
} from "../src/cli/substrate-lifecycle";
import { defaultSubstrateHome, installSpecFor } from "../src/install-spec-registry";

async function withGreenfieldHomes<T>(
  fn: (homeDir: string, somaHome: string) => Promise<T>,
): Promise<T> {
  // Two INDEPENDENT temp roots (not one nested under the other): greenfield
  // means empty EXISTING roots — `mkdtemp` creates them empty — and exercises
  // `--home-dir` / `--soma-home` pointing at unrelated trees, same as a real
  // split-home install. (The create-from-absence case, where install must
  // create a home path that does NOT yet exist, is covered by its own test
  // below.)
  const homeDir = await mkdtemp(join(tmpdir(), "soma-greenfield-home-"));
  const somaHome = await mkdtemp(join(tmpdir(), "soma-greenfield-soma-"));
  try {
    return await fn(homeDir, somaHome);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(somaHome, { recursive: true, force: true });
  }
}

/**
 * Every regular file under `roots`, recursively — the faithful "what actually
 * landed on disk" projected set. Skips transient `.soma-case.*` case-probe
 * markers the owned-subtree reconcile may leave mid-run (same filter the
 * existing install tests use).
 */
async function collectProjectedFiles(roots: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    for (const rel of await readdir(root, { recursive: true })) {
      if (basename(rel).startsWith(".soma-case.")) continue;
      const full = join(root, rel);
      if ((await stat(full)).isFile()) files.push(full);
    }
  }
  return files;
}

const SUBSTRATE_PLANNERS: Record<
  (typeof PROJECTION_LIFECYCLE_SUBSTRATES)[number],
  (options: SomaInstallOptions) => SomaInstallPlan
> = {
  codex: planSomaForCodexInstall,
  "pi-dev": planSomaForPiDevInstall,
  "claude-code": planSomaForClaudeCodeInstall,
  cursor: planSomaForCursorInstall,
  grok: planSomaForGrokInstall,
};

/**
 * Drive the real CLI install for `substrate` into the given roots: parse an
 * argv, run it through the lifecycle CLI, and assert the apply actually
 * happened. Callers audit the resulting disk state afterward.
 */
async function runCliInstall(substrate: InstallSubstrate, homeDir: string, somaHome: string): Promise<void> {
  const parsed = parseInstallArgs(["install", substrate, "--home-dir", homeDir, "--soma-home", somaHome, "--apply"]);
  expect(parsed.command).toBe("install");
  expect(parsed.substrate).toBe(substrate);
  expect(parsed.apply).toBe(true);
  const output = await runSubstrateLifecycleCli(parsed);
  // The apply-mode result banner (formatInstallResult); the dry-run path emits
  // "PLAN (no changes written)" instead, so this also guards the --apply gate.
  expect(output).toContain("Soma install applied");
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
 * (see `isKnownOnDemandOrCrossSubstrateReference` below) rather than promises
 * the install broke.
 */
export async function auditProjectedFiles(
  files: readonly string[],
  roots: readonly string[],
  isExempt: (ref: string) => boolean = () => false,
): Promise<ProjectionAuditProblem[]> {
  const problems: ProjectionAuditProblem[] = [];

  for (const file of files) {
    let buffer: Buffer;
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
      // Read the RAW bytes: `readFile(file, "utf8")` silently maps invalid
      // byte sequences to U+FFFD, so it can never prove a file is valid UTF-8.
      buffer = await readFile(file);
    } catch (error) {
      problems.push({ file, reason: `missing or unreadable: ${(error as Error).message}` });
      continue;
    }

    // Validate encoding with a FATAL decoder for text projections — this is
    // what makes the "valid UTF-8" claim true rather than aspirational. A lone
    // continuation byte or a truncated multibyte sequence throws here instead
    // of decoding to a replacement char. Decode ONCE and reuse the string for
    // the markdown-empty / JSON.parse / dangling-path checks below.
    let content: string;
    if (isTextProjectionPath(file)) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        problems.push({ file, reason: "invalid UTF-8" });
        continue;
      }
    } else {
      // Non-text projected asset: don't assert an encoding, but still scan its
      // decoded text for dangling references (lossy decode is fine here — a
      // path reference is ASCII and survives replacement-char substitution).
      content = buffer.toString("utf8");
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
 * True when a projected file is expected to be UTF-8 text and should be
 * validated with the fatal decoder. Soma projects markdown, JSON, and a
 * handful of other text formats (JSONL logs, TOML config, plain-text
 * pointer files, `.mjs` hook modules, `.txt`). Anything else is treated as
 * an opaque asset (no encoding assertion). Extension-driven — a genuinely
 * binary projection with a text extension would be a separate bug this
 * check would rightly surface.
 */
function isTextProjectionPath(path: string): boolean {
  return /\.(md|json|jsonl|toml|txt|mjs|js|ts|yaml|yml)$/.test(path) || !/\.[a-z0-9]+$/i.test(path);
}

/**
 * Projected docs and runtime configs legitimately reference some paths that
 * don't exist right after a fresh `soma install` — they're not projection
 * promises, they're either (a) cross-substrate defensive policy data, or (b)
 * locations a *later*, separate command creates on demand. Exempting them
 * here keeps the dangling-reference check honest: it still fails on a genuine
 * stale/broken reference (proven by the fixture test below), without flaring
 * on these known, intentional cases.
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
function isKnownOnDemandOrCrossSubstrateReference(
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
    const onDemandPrefixes = [
      "profile/imports",
      "imports",
      "memory/RAW/untrusted",
      "memory/SECURITY/inbound-content",
      "memory/LEARNING/ALGORITHM",
    ];
    if (onDemandPrefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) return true;
  }

  return false;
}

/**
 * Files a spec declares in `homeFiles` (so the planner / doctor / owned-subtree
 * reconcile know about them) but only PROJECTS when their source exists — so a
 * greenfield install legitimately omits them. Matched by path suffix. Source:
 * src/adapters/claude-code.ts, where `ConditionalRulesFile` names exactly
 * `rules/soma/ACTIVE_VSA.md` (no active VSA) and `rules/soma/MEMORY.md` (no
 * memory index); both are excluded from the always-on content builders and
 * appended only when their source is present. A declared file absent for any
 * OTHER reason is a real "planned but never written" regression.
 */
const GREENFIELD_CONDITIONAL_DECLARED_SUFFIXES = [
  "rules/soma/ACTIVE_VSA.md",
  "rules/soma/MEMORY.md",
];

for (const substrate of PROJECTION_LIFECYCLE_SUBSTRATES) {
  test(`greenfield install: ${substrate} projects a clean, self-consistent home (via CLI)`, async () => {
    await withGreenfieldHomes(async (homeDir, somaHome) => {
      await runCliInstall(substrate, homeDir, somaHome);

      // (1a) Declared promise kept: every file the STATIC install plan
      // declares actually landed on disk — UNLESS it is a known conditional
      // projection a greenfield install legitimately omits. The plan
      // deliberately omits dynamic bundled-skill/lifecycle output (see
      // test/fixtures.ts), so this is a subset check with teeth against the
      // ugly-parse-free structured plan: it fails if a planned NON-conditional
      // projection silently didn't get written.
      const plan = SUBSTRATE_PLANNERS[substrate]({ homeDir, somaHome });
      const spec = installSpecFor(substrate);
      // `optionalHomeFiles` are only written when opted-in / their source
      // exists; drop them from the "must land" set.
      const optional = new Set(
        (spec.optionalHomeFiles?.({ homeDir, somaHome }) ?? []).map((path) => resolve(plan.substrateHome, path)),
      );
      const declared = [...plan.somaFiles, ...plan.substrateFiles]
        .map((path) => resolve(path))
        .filter((path) => !optional.has(path));
      expect(declared.length).toBeGreaterThan(0);

      // (1b) Full projected set: everything that actually landed under either
      // temp root — the faithful audit surface for the content checks.
      const projectedFiles = await collectProjectedFiles([homeDir, somaHome]);
      const projectedResolved = new Set(projectedFiles.map((path) => resolve(path)));
      expect(projectedFiles.length).toBeGreaterThan(declared.length - 1); // ≥ declared

      // A declared file may be absent ONLY if it is a documented conditional
      // projection (no active VSA / no memory index on greenfield); any other
      // missing declared file is a real "planned but never written" bug.
      const missingDeclared = declared.filter(
        (path) =>
          !projectedResolved.has(path) &&
          !GREENFIELD_CONDITIONAL_DECLARED_SUFFIXES.some((suffix) => path.endsWith(`/${suffix}`)),
      );
      if (missingDeclared.length > 0) {
        throw new Error(
          `${substrate}: ${missingDeclared.length} planned file(s) never landed on disk:\n${missingDeclared
            .map((path) => `  - ${path}`)
            .join("\n")}`,
        );
      }

      const problems = await auditProjectedFiles(projectedFiles, [homeDir, somaHome], (ref) =>
        isKnownOnDemandOrCrossSubstrateReference(ref, { homeDir, somaHome, substrate }),
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

test("greenfield install (via CLI) creates a home path that does not yet exist (create-from-absence)", async () => {
  // Unlike withGreenfieldHomes (which mkdtemps both roots so they exist-but-
  // empty), point --home-dir / --soma-home at child paths UNDER a temp root
  // that do NOT exist yet, so install must create them from absence — the
  // fresh-machine case where ~/.soma and the substrate home don't exist.
  const parent = await mkdtemp(join(tmpdir(), "soma-greenfield-absent-"));
  try {
    const homeDir = join(parent, "nested", "home");
    const somaHome = join(parent, "nested", "soma");
    expect(existsSync(homeDir)).toBe(false);
    expect(existsSync(somaHome)).toBe(false);

    await runCliInstall("claude-code", homeDir, somaHome);

    // Both absent paths now exist and hold projected files.
    expect(existsSync(homeDir)).toBe(true);
    expect(existsSync(somaHome)).toBe(true);

    const projectedFiles = await collectProjectedFiles([homeDir, somaHome]);
    expect(projectedFiles.length).toBeGreaterThan(0);

    const problems = await auditProjectedFiles(projectedFiles, [homeDir, somaHome], (ref) =>
      isKnownOnDemandOrCrossSubstrateReference(ref, { homeDir, somaHome, substrate: "claude-code" }),
    );
    if (problems.length > 0) {
      throw new Error(
        `create-from-absence: ${problems.length} projection problem(s):\n${problems
          .map((p) => `  - ${p.file}: ${p.reason}`)
          .join("\n")}`,
      );
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

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

    // A .md whose bytes are NOT valid UTF-8: a lone continuation byte 0x80
    // plus a truncated BOM-like sequence. `readFile(_, "utf8")` would have
    // decoded this to U+FFFD and passed; the fatal decoder must reject it.
    const badUtf8Md = join(root, "bad-utf8.md");
    await writeFile(badUtf8Md, Buffer.from([0xff, 0xfe, 0x00, 0x80]));

    const problems = await auditProjectedFiles([brokenMd, brokenJson, emptyMd, badUtf8Md], [root]);

    const reasons = problems.map((p) => `${p.file}: ${p.reason}`);
    expect(reasons.some((r) => r.includes(brokenMd) && r.includes(`dangling path reference: ${missingTarget}`))).toBe(true);
    expect(reasons.some((r) => r.includes(brokenJson) && r.includes("invalid JSON"))).toBe(true);
    expect(reasons.some((r) => r.includes(emptyMd) && r.includes("empty file"))).toBe(true);
    expect(reasons.some((r) => r.includes(badUtf8Md) && r.includes("invalid UTF-8"))).toBe(true);

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
