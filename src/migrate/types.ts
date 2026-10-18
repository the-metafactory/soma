// `soma migrate claude-skills` types (node #814).

// #115 — `soma migrate claude-skills` types.
//
// Imports directly from an installed flat `.claude/skills/` tree — one
// `<Name>/SKILL.md` per skill, no pack-level metadata, no collection
// bundles. Per-skill portability is classified heuristically (regex
// based, Phase 1) and recorded in a sibling report file. Phase 2
// (deferred) adds a `--smoke <substrate>` flag for projection verify.
// #115 Phase 2 — substrate identifier scope for the `--smoke` flag.
// `claude-code` is intentionally excluded — it's the SOURCE substrate
// for `soma migrate claude-skills`, so projecting an imported skill
// back to Claude Code would only ever round-trip; the real verify
// value is on the NON-source substrates (Codex + Pi.dev).
export type ClaudeSkillsSmokeSubstrate = "codex" | "pi-dev" | "grok";

// #115 Phase 2 — per-skill, per-substrate static-shape verification
// verdict. The verifier never EXECUTES the substrate; it only checks
// that the projection bytes survive the substrate's projection
// machinery and pass deterministic structural assertions.
export type ClaudeSkillSubstrateVerifyStatus =
  | "verified"
  | "verified-with-warnings"
  | "failed";

export interface ClaudeSkillSubstrateVerifyResult {
  substrate: ClaudeSkillsSmokeSubstrate;
  status: ClaudeSkillSubstrateVerifyStatus;
  // One-line reason — surfaced in the portability report column.
  // For `verified`: "ok" or a short positive description.
  // For `verified-with-warnings`: the warning summary (first issue).
  // For `failed`: the blocking issue summary (first issue).
  reason: string;
  // Full list of issues surfaced by the static shape checks. Empty
  // when status is `verified`. Test surface and audit trail.
  issues: ClaudeSkillSubstrateVerifyIssue[];
}

export interface ClaudeSkillSubstrateVerifyIssue {
  kind:
    | "projection-throw"
    | "missing-name"
    | "missing-description"
    | "description-mismatch"
    | "dangling-internal-ref"
    | "unresolved-tool-path"
    | "substrate-only-primitive"
    | "empty-projection"
    | "oversized-projection"
    | "frontmatter-unparseable"
    | "long-body";
  // Severity decides whether this issue is a warning or a blocker.
  // `error` → status becomes `failed`. `warning` → status becomes
  // `verified-with-warnings` (unless an `error` is also present).
  severity: "error" | "warning";
  // Human-readable line, single sentence, no trailing newline.
  message: string;
  // Optional path of the projection file that triggered the issue.
  file?: string;
}

export interface ClaudeSkillsMigrationOptions {
  // Source flat skills tree. REQUIRED. Must be a directory of
  // `<Name>/SKILL.md` direct children. Refused loud otherwise.
  from?: string;
  // Override Soma home. Defaults to `<homeDir>/.soma`.
  somaHome?: string;
  // Override `$HOME`. Used by tests; the apply path resolves
  // `somaHome` from this when not explicitly set.
  homeDir?: string;
  // When true, classifier outcomes tagged `claude-specific` are still
  // imported (with an audit warning). Default false → skipped.
  includeClaudeSpecific?: boolean;
  // #115 Phase 2 — substrate(s) to run per-skill static-shape
  // verification against after import. Ordered, de-duplicated. The
  // CLI accepts `--smoke <substrate>` repeated and `--smoke all`
  // (which the parser expands to `["codex", "pi-dev", "grok"]`). Absent /
  // empty → Phase-1 behavior (no verify, no substrate columns in
  // the report).
  smokeSubstrates?: ClaudeSkillsSmokeSubstrate[];
  // #120 — LLM agent used to compress SKILL.md frontmatter
  // descriptions that exceed the 1024-char substrate limit (codex +
  // pi-dev both cap there) or are missing entirely. Default `"none"`
  // → oversize/missing descriptions classify as `refused-description-
  // limit` and the skill is not imported. Set to `"claude" | "codex"
  // | "pi"` to dispatch the rewrite to that agent before write.
  rewriteDescriptionsAgent?: RewriteDescriptionsAgent;
  // #120 — test-only injection point for the LLM dispatcher. When
  // present, replaces the per-agent dispatcher so fixture tests can
  // exercise the rewrite path without invoking a real LLM. Absent in
  // production. The dispatcher receives a structured request and
  // returns the rewritten description text; the migrator handles SHA
  // computation, length validation, and frontmatter splicing.
  rewriteDispatchOverride?: RewriteDispatchOverride;
  // #125 — per-skill progress emitter for plan / apply phases.
  // Optional; absent → no-op emitter (library callers don't get
  // surprise stderr noise). The CLI wires a real stderr-backed
  // emitter that respects `--quiet` and TTY detection. The
  // migrator threads phase boundaries (discovery, read+classify,
  // rewrite, apply write, smoke verify) through the emitter.
  // The `quiet` flag belongs to the CLI surface (not the migrator)
  // — pass a no-op emitter to suppress progress instead.
  progressEmitter?: import("./claude-skills-progress").ProgressEmitter;
}

/**
 * #120 — LLM agent enum for `--rewrite-descriptions`. `none` is the
 * default (no rewrite; oversize/missing descriptions refuse loud).
 * Other values dispatch the rewrite to the corresponding agent:
 *   - `claude` — subscription-billed `claude` subprocess (Sonnet).
 *   - `codex`  — `codex exec` subprocess (cross-vendor GPT path).
 *   - `pi`     — Pi.dev local LLM API (refused loud if unavailable).
 *   - `auto`   — non-interactive batch approval; dispatches via the
 *                default provider (`codex`) without prompting.
 */
export type RewriteDescriptionsAgent = "claude" | "codex" | "pi" | "none" | "auto";

/**
 * #120 — status of a skill's frontmatter description relative to the
 * 1024-char substrate limit.
 *   - `ok`       — description present AND ≤ 1024 chars.
 *   - `oversize` — description present AND > 1024 chars.
 *   - `missing`  — no frontmatter OR no `description:` line.
 *
 * `length` records the original description length (0 when missing).
 * `threshold` is the hard substrate cap; carried in-band so callers
 * don't need to import a separate constant.
 */
export interface DescriptionStatus {
  kind: "ok" | "oversize" | "missing";
  length: number;
  threshold: 1024;
}

/**
 * #120 — test-only override for the LLM dispatcher. Replaces the
 * real subprocess invocation with a pure function the test can
 * inspect / control. Receives the same request shape the real
 * dispatcher would; returns the rewritten text only (SHA / length
 * validation lives in the migrator, not the dispatcher).
 */
export type RewriteDispatchOverride = (request: {
  agent: Exclude<RewriteDescriptionsAgent, "none">;
  sourceName: string;
  status: DescriptionStatus;
  originalDescription: string;
  skillMdBody: string;
  targetMaxLength: number;
}) => Promise<string>;

// Heuristic portability tag assigned to every source skill. Phase 1
// rules:
//   - `portable`        — no `~/.claude/` path refs, no hook bindings,
//                          no `/<slash-command>` refs in prose.
//   - `needs-adapt`     — has `~/.claude/...` refs that the existing
//                          `skill-content-normalizer.ts` rewrite table can
//                          deterministically resolve.
//   - `claude-specific` — has Claude-Code-only primitives that have
//                          no portable equivalent: hook bindings
//                          (`Stop:`, `UserPromptSubmit:`,
//                          `PreToolUse:`, `PostToolUse:`,
//                          `SessionStart:`, `SubagentStop:`) OR
//                          `/<slash-command>` refs in prose.
export type ClaudeSkillPortabilityTag = "portable" | "needs-adapt" | "claude-specific";

export interface ClaudeSkillOutcome {
  // Source directory name (e.g. "Art", "ExtractWisdom").
  sourceName: string;
  // Kebab-cased target slug (e.g. "art", "extract-wisdom").
  kebabName: string;
  // Per-skill classifier verdict.
  tag: ClaudeSkillPortabilityTag;
  // Human-readable reason for the classifier verdict. One line.
  reason: string;
  // Phase 1 final disposition. `imported` = written to `<somaHome>/skills/<kebab>/`.
  // `skipped-claude-specific` = classifier verdict was `claude-specific`
  // and `includeClaudeSpecific` was false. `skipped-idempotent` =
  // source SHA matched the manifest entry on rerun.
  //
  // #118 — `refused-other` is the per-skill log-and-continue verdict
  // (mirrors `PaiPackOutcomeKind.refused-other`). Genuine errors while
  // reading a source skill (out-of-home symlink target, symlink cycle,
  // broken target, secret refusal, …) classify the surrounding skill
  // as `refused-other` and let the other skills continue. The CLI
  // turns any `refused-other` outcome into a non-zero exit ONLY in
  // apply mode (matches #112's mode-gated exit policy).
  // #120 — `refused-description-limit` is the new outcome for a
  // skill whose frontmatter description exceeds 1024 chars OR whose
  // SKILL.md has no frontmatter, AND `--rewrite-descriptions` was
  // absent or set to `none`. The skill is NOT imported; the CLI
  // footer suggests re-running with `--rewrite-descriptions auto`
  // (or claude / codex / pi) so the LLM dispatcher can compress the text.
  disposition:
    | "imported"
    | "skipped-claude-specific"
    | "skipped-idempotent"
    | "refused-other"
    | "refused-description-limit";
  // SHA-256 of the source SKILL.md bytes (hex). Stable identity for
  // idempotency checks. Populated even on classify-only / plan runs.
  sourceSha: string;
  // Absolute path of the imported skill root under
  // `<somaHome>/skills/<kebab>/`. Null when `disposition` is
  // `skipped-claude-specific`.
  target: string | null;
  // Number of file SHAs recorded under this skill's manifest entry
  // on the apply path (SKILL.md + every Workflows/Tools/References/
  // file copied or rewritten). Zero when the skill was skipped.
  fileCount: number;
  // #115 Phase 2 — per-substrate static-shape verify results. Keyed
  // by substrate id. Populated only when the migrator was invoked
  // with `--smoke <substrate>` AND the skill was actually imported
  // (skipped skills have nothing to verify). Empty/undefined when
  // no smoke run was requested — preserves Phase 1 report shape.
  substrates?: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifyResult>>;
  /**
   * #118 — per-skill audit trail. Each entry records a non-fatal event
   * the source-side walker decided to handle silently (followed
   * symlink resolutions to date). The audit feeds the portability
   * report so principals can see which symlinks were resolved without
   * grepping for them. Absent when the skill walked clean.
   *
   * Kinds:
   *   - `followed-user-owned-symlink` — a symlink whose realpath
   *     target stayed within `$HOME` was resolved + its bytes
   *     imported. `detail` carries `<rel> → <realpath>`.
   */
  audit?: ClaudeSkillAuditEntry[];
  /**
   * #118 — reason text for the `refused-other` disposition. Includes
   * the `<sourceName>/<rel>` path of the symlink (or other refusal
   * trigger) so principals can locate it without grep. Absent for
   * non-refused dispositions; the higher-level `reason` field carries
   * the classifier verdict for those.
   */
  refusalReason?: string;
  /**
   * #120 — frontmatter description status against the 1024-char
   * substrate cap. Computed unconditionally for every successfully-
   * read skill so the portability report can show the original
   * length even when no rewrite was requested. `kind: "missing"` →
   * no frontmatter OR no `description:` line in frontmatter.
   * Absent only when the skill itself was refused before the
   * description could be inspected (`refused-other`).
   */
  descriptionStatus?: DescriptionStatus;
  /**
   * #120 — when `--rewrite-descriptions <agent>` actually compressed
   * the description for this skill, this slot records the agent,
   * the resulting length, and the rewritten SHA so the portability
   * report and manifest carry the provenance trail (AC-5). Absent
   * when the skill's description was already within the cap or when
   * no rewrite was attempted.
   */
  descriptionRewrite?: ClaudeSkillDescriptionRewrite;
  /**
   * #126 — one-hop cross-skill code/documentation dependencies found
   * while scanning source payloads for `~/.claude/skills/<Other>/...`
   * references. `skill` is the kebab-cased referenced skill name;
   * `references` are the relative paths inside that referenced skill
   * (for example `Tools/ComposeAgent.ts`); `sourceFiles` are the
   * current skill files that mention the dependency.
   */
  dependencies?: ClaudeSkillDependency[];
  /**
   * #126 — referenced skills whose own migration outcome means they
   * will not be available in the projected skill tree. The dependent
   * skill still imports, but reports and CLI output surface this
   * loudly so the principal does not discover it at runtime.
   */
  dependencyMissing?: string[];
}

export interface ClaudeSkillDependency {
  skill: string;
  references: string[];
  sourceFiles: string[];
}

/**
 * #120 — provenance for a single description rewrite. Recorded on
 * both `ClaudeSkillOutcome` (for the portability report row) and
 * `ClaudeSkillsMigrationManifestEntry` (for idempotency on rerun).
 *
 * `originalDescriptionSha` is the SHA-256 of the source description
 * bytes BEFORE rewrite (empty string when status was `missing` and
 * we synthesized from body). `rewrittenDescriptionSha` is the SHA
 * of the post-rewrite text. The manifest stores both so a rerun
 * with an unchanged source description can short-circuit; a rerun
 * with a CHANGED source description re-runs the rewrite.
 */
export interface ClaudeSkillDescriptionRewrite {
  agent: Exclude<RewriteDescriptionsAgent, "none">;
  rewrittenAt: string;
  originalDescriptionSha: string;
  rewrittenDescriptionSha: string;
  originalLength: number;
  rewrittenLength: number;
}

export interface ClaudeSkillAuditEntry {
  kind: "followed-user-owned-symlink";
  /** POSIX-style path relative to the skill root that triggered the event. */
  relPath: string;
  /** Resolved realpath of the symlink target (for principal audit). */
  detail: string;
}

export interface ClaudeSkillsMigrationPlan {
  apply: boolean;
  // Absolute path of the resolved `--from <skills-dir>`.
  from: string;
  // Absolute path of the resolved Soma home.
  somaHome: string;
  // Whether the source directory passed the "flat skills tree" guard
  // (i.e. at least one `<Name>/SKILL.md` direct child). When false,
  // `outcomes` is empty and the formatter renders a hard refusal.
  isFlatSkillsTree: boolean;
  // Present only when `isFlatSkillsTree` is false: the accurate reason
  // (missing dir / empty dir / non-flat layout) so the formatter does
  // not misdiagnose a fresh, empty `~/.claude/skills/` as "not flat".
  flatTreeRefusalReason?: string;
  // One outcome per source `<Name>/SKILL.md`. Always ordered by
  // `sourceName` so the report and CLI rendering are deterministic.
  outcomes: ClaudeSkillOutcome[];
  // Mirror of `options.includeClaudeSpecific` so the formatter and
  // the manifest renderer can both reflect the same intent without
  // re-threading the option through helpers.
  includeClaudeSpecific: boolean;
  // #115 Phase 2 — substrates requested for static-shape verify.
  // Empty when `--smoke` was not passed; the report omits substrate
  // columns in that case so Phase-1 formatter output is byte-stable.
  smokeSubstrates: ClaudeSkillsSmokeSubstrate[];
  // #120 — mirror of `options.rewriteDescriptionsAgent` so the
  // formatter and report can both reflect the intent without
  // re-threading the option through helpers. `none` when the flag
  // was absent.
  rewriteDescriptionsAgent: RewriteDescriptionsAgent;
}

export interface ClaudeSkillsMigrationResult extends ClaudeSkillsMigrationPlan {
  // ISO-8601 timestamp of the last successful apply. Stable across
  // reruns when nothing changed.
  importedAt: string;
  // Absolute path of the SHA manifest file under
  // `<somaHome>/imports/claude-skills/.manifest.json`.
  manifestPath: string;
  // Absolute path of the portability report under
  // `<somaHome>/imports/claude-skills/.portability-report.md`.
  reportPath: string;
  // Skills actually written this run (`disposition: "imported"`,
  // SHA not already present in prior manifest).
  writtenCount: number;
  // Skills skipped due to SHA-match idempotency on rerun.
  skippedIdempotentCount: number;
  // Skills skipped because verdict was `claude-specific` and the
  // override flag was off.
  skippedClaudeSpecificCount: number;
  // #118 — skills that hit a genuine read failure (out-of-home symlink,
  // symlink cycle, broken target, denylisted target, etc.). Other
  // skills continue. The CLI gates exit-code on this count being > 0
  // in apply mode (mirror of #112's plan/apply split).
  refusedOtherCount: number;
  // #120 — skills refused because their frontmatter description
  // exceeded the 1024-char substrate cap (or was missing) AND no
  // `--rewrite-descriptions <agent>` was set. The CLI footer
  // suggests re-running with `--rewrite-descriptions auto`
  // (or claude / codex / pi) so the LLM dispatcher compresses the text.
  refusedDescriptionLimitCount: number;
  // #120 — skills whose description was actually rewritten via the
  // LLM dispatcher this run. Reported separately from `writtenCount`
  // so principals can see the rewrite footprint without grepping
  // the per-skill table.
  descriptionRewrittenCount: number;
  // #115 Phase 2 — per-substrate verify aggregate counts. Keyed by
  // substrate id; entries present only for substrates requested via
  // `--smoke`. Each entry counts `verified` / `verified-with-
  // warnings` / `failed` across imported skills.
  substrateVerifySummary?: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifySummary>>;
  // #125 — per-phase elapsed-time summary. Populated by the
  // migrator and rendered into the stdout summary's Timing block.
  // `phases` is ordered: discovery + read+classify, description
  // rewrites, apply write, smoke verify. Phases that didn't run
  // (e.g. `--smoke` absent) carry `unit: "(not requested)"`.
  timing?: import("./claude-skills-progress").PhaseTimings;
}

export interface ClaudeSkillSubstrateVerifySummary {
  verified: number;
  verifiedWithWarnings: number;
  failed: number;
}

export interface ClaudeSkillsMigrationManifestEntry {
  // Source directory name (`<Name>` from `<from>/<Name>/SKILL.md`).
  sourceName: string;
  // Kebab-cased target slug.
  kebabName: string;
  tag: ClaudeSkillPortabilityTag;
  // SHA-256 of the source SKILL.md bytes — the idempotency key.
  sourceSha: string;
  // Per-file SHAs of every payload file that landed under
  // `<somaHome>/skills/<kebab>/`. POSIX-style paths relative to
  // the skill root. Includes SKILL.md.
  fileShas: Record<string, string>;
  // #115 Phase 2 — last-seen per-substrate verify verdicts. Mirror
  // of `ClaudeSkillOutcome.substrates`. Idempotency contract: a
  // re-run with the same `sourceSha` AND a substrate already
  // `verified` here skips re-verification. A `failed`/`verified-
  // with-warnings` entry is re-run every invocation so a fix to the
  // adapter can flip the verdict without source churn.
  substrates?: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifyResult>>;
  // #120 — description-rewrite provenance. Present only for skills
  // whose description was actually rewritten via `--rewrite-
  // descriptions <agent>`. Idempotency: a rerun with matching
  // `originalDescriptionSha` (i.e. source description unchanged
  // since the rewrite) reuses the prior rewritten text instead of
  // calling the LLM again.
  descriptionRewrite?: ClaudeSkillDescriptionRewrite;
}

export interface ClaudeSkillsMigrationManifestOutcome {
  sourceName: string;
  kebabName: string;
  tag: ClaudeSkillPortabilityTag;
  disposition: ClaudeSkillOutcome["disposition"];
  reason: string;
  refusalReason?: string;
  remediation?: string;
  dependencyMissing?: string[];
}

export interface ClaudeSkillsMigrationManifestLastRun {
  totals: {
    imported: number;
    skippedIdempotent: number;
    skippedClaudeSpecific: number;
    refusedOther: number;
    refusedDescriptionLimit: number;
  };
  outcomes: ClaudeSkillsMigrationManifestOutcome[];
}

export interface ClaudeSkillsMigrationManifest {
  schema: "soma.claude-skills-migration.v1";
  from: string;
  somaHome: string;
  importedAt: string;
  // Whether `--include-claude-specific` was passed on the run that
  // wrote this manifest. Recorded so the next apply can detect a
  // policy change (override flipped off) and re-classify accordingly.
  includeClaudeSpecific: boolean;
  // One entry per skill that was actually imported. Skipped skills
  // (claude-specific without override) are NOT recorded — their
  // SHA isn't an idempotency anchor for anything that landed.
  // Sorted by `kebabName` for byte-stable reruns.
  skills: ClaudeSkillsMigrationManifestEntry[];
  // #175 — latest actionable skipped/refused outcomes. `skills`
  // stays the idempotency anchor for landed payloads; this ledger lets
  // `--status` report unresolved migration work without scraping the
  // Markdown portability report.
  lastRun?: ClaudeSkillsMigrationManifestLastRun;
  // #115 Phase 2 — substrate list captured at last write. Absent
  // when no `--smoke` was ever run; present so the next invocation
  // can detect a substrate-set change.
  smokeSubstrates?: ClaudeSkillsSmokeSubstrate[];
}


// Classification of a detected Claude skills source dir (sage review on
// #309): `not-importable` (non-flat layout, file-at-path) and `unreadable`
// (probe could not read the source at all) must never be conflated with
// `empty` in user-facing output.
export type ClaudeSkillsSourceStatus = "importable" | "empty" | "missing" | "not-importable" | "unreadable";
