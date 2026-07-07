# HANDOVER — VerificationGate + PreCompact ports & PAI hook cleanup

*Written 2026-07-07. Read this first when resuming. Sibling doc: `Plans/2026-07-06-HANDOVER-remove-pai-from-claude.md` (the de-PAI migration — still the source of truth for tree removal + settings.json cleanup).*

## The frame

**First finish line = Soma-as-a-standalone-product** (the composability epic: #381 AI-native install doc, #373 greenfield CI across adapters, #370 provenance/doctor, #371 compact skill registry — no milestone defined yet). JC's sequencing: **clean up the local installation first**, then the product work.

"Clean up local installation" = finish de-PAI: retire the legacy PAI hooks, remove the 18 MB `~/.claude/PAI/` tree, and port the FEW PAI hooks that carry real value into Soma. This session did the hook triage + the first port (VerificationGate). PreCompact is the remaining port.

## Git state

- Branch **`feat/verification-gate-and-precompact`** (off `main`), **1 commit `41d9830`** (VerificationGate), **NOT pushed**, tree clean.
- `main` is at `232e974` (the merged skill-projection PR #437). `~/.claude/bin/soma` symlinks to this dev tree, so `soma install` runs whatever is checked out — **stay on `main` or a rebased branch when running `soma install`**, or you'll install half-built code.
- Prior merged work this arc: PR #437 (bundled skills project as invocable dirs — `the-algorithm`/`Memory` now real dirs in `~/.claude/skills`, applied + verified live). Open follow-up: **issue #438** (portable-skill manifest clobbers across same-substrate multi-home installs — deferred).

## ✅ DONE this session: VerificationGate (ports PAI EvidenceGate)

Committed on the branch (`41d9830`), **1851 tests pass, typecheck clean**. Not yet pushed / no PR.

- **What**: the block-mode, record-time counterpart to #330's audit-time gate. `verifyAlgorithmCriterion` now REFUSES to record a `passed` on specification-only or rote ("done"/"verified"/…) evidence. Helper: `verificationGateViolation(status, evidence, evidenceKind)` in `src/vsa-accessors.ts`.
- **Layer (b) already existed**: `learnGateViolations` (`src/algorithm.ts`) blocks a hollow pass from entering LEARN → completing (`:298` completeness, `:459` gate). VerificationGate (layer a) just moved the same bar to record time. JC's decisions: **Block**, layers **a + b**, name **VerificationGate**.
- **Reconstruction opt-out**: `verifyAlgorithmCriterion(..., enforceGate=true)`. The VSA→run sync (`src/algorithm-vsa-sync.ts`, two call sites) passes `false` — it reconstructs already-declared `[x]` state (bare checkboxes carry no probe kind); synced hollow passes are still caught by the audit-time LEARN gate. The strictness belongs on the ASSERTION surface, not on mirroring on-disk state.
- **Escape hatches**: `evidenceKind: "probed"|"tested"`, or `status: "deferred-probe"`. The CLI already accepts `--evidence-kind`.
- **Tests touched**: `algorithm-verification-evidence.test.ts` (2 new negative tests: spec-only + rote refused at record time; the old "grandfathered" / "blocks advance to LEARN" tests rewritten to the record-time contract), plus probe kinds added to agent-verify setups in `algorithm.test.ts`, `lifecycle.test.ts`, `cli.test.ts`.
- **Open question for JC**: I did NOT port EvidenceGate's fuller rote-text matching — Soma's structured `evidenceKind` is the real discriminator, so the gate leans on that + a bare-word blocklist only. Flag if the fuller text matching is wanted.
- ⚠️ **Debugging gotcha for next session**: a test named `records per-hop substrate provenance for Algorithm mutations` exists in BOTH `algorithm.test.ts` AND `algorithm-meta-reflection.test.ts`. When the full suite reports it failing, check `algorithm.test.ts` FIRST — a same-named test in another file makes "run it alone → passes" misleading. Also: single-line `grep "verifyAlgorithmCriterion.*passed"` MISSES multi-line calls; use `grep -A6`.

## ⏭️ NEXT: PreCompact port (the remaining port — NOT started)

Task: port PAI's `PreCompact.hook.ts` (auto handover-on-compaction) into a Soma-owned claude-code hook. **JC's decision: emit + PERSIST** (his words: "the output gets cleared before the user has a chance to read it, so a persistence into the next section would be good"). This effectively realizes part of the deferred **M5b** (SessionEnd digest).

**Source hook** (read for the output format): `~/.claude/hooks/PreCompact.hook.ts` — reads PAI `MEMORY/STATE/current-work*.json` (gone in Soma) + the active ISA, emits a `# Pre-Compaction Handover` markdown to stdout (Active Work / ISA Summary / Files Modified / Key Decisions / Working Directory / Session ID). Non-blocking, PreCompact event.

**Soma side (grounded this session):**
- Data source: **`buildSomaStartupContext()`** at `src/lifecycle.ts:199` already assembles work-state (`SomaStartupContext` has a `context: string`). Reuse it rather than re-derive.
- Existing claude-code hook assets to mirror: `src/adapters/claude-code/{mode-classifier-hook.mjs, policy-guard-hook.mjs, hook-runner.mjs}`; install wiring `installClaudeCodeSomaHooks` in `src/adapters/claude-code/hooks.ts`; config JSON pattern; marker-guarded `settings.json` patch. The de-PAI pass REMOVED the `PreCompact` event from `settings.json` — **re-add it as Soma-owned**.

**Design decisions to make while building:**
1. **Where to persist** so it survives into the post-compaction section: a Soma episodic digest (ties to M5b — needs the digest-authorship model JC deferred) OR a simpler durable `last-handover` file that the next `UserPromptSubmit` (`soma-claude-code-hook.mjs`) or session-start re-injects. Recommend the simpler file first; wire M5b episodic later.
2. **Re-surface mechanism**: claude-code compaction does NOT re-run session-start, so emitting alone isn't enough (that's JC's exact complaint). The persisted handover must be re-injected by the per-prompt hook (`soma-claude-code-hook.mjs`, UserPromptSubmit) reading the durable file. Design this loop explicitly.
3. Substrate scope: PreCompact is claude-code-specific (other substrates have no compaction event) — a claude-code adapter hook, fine.

**Build the same way as VerificationGate**: verification-first, tests, then commit on this branch. Then push both + PR (the skill-projection arc went via PR + Sage review — see below).

## PAI hook cleanup ledger (decided with JC this session)

The `~/.claude/hooks/` triage is DONE. Full analysis in this session's transcript. Disposition:

**PORT into Soma:** EvidenceGate → VerificationGate ✅ DONE. PreCompact → ⏭️ TODO (above).

**KEEP (not PAI):** `ACR.hook.ts` (JC's recall), the 4 `Cortex*.hook.ts` symlinks, `ContextReduction.hook.sh` (RTK auto-rewrite), `PrePushSmokeTest.hook.ts` (JC's), and **caduceus** = `SkillNudgeInject.hook.ts` + `handlers/SkillNudge.ts` + `lib/skill-stats-log` (JC's experiment; ⚠️ currently UNWIRED by the de-PAI pass — re-wire if JC wants it firing).

**RETIRE** (move to `~/.claude/hooks/_retired-2026-07/`, don't delete yet):
- *Soma-covered:* PromptGuard, SecurityPipeline, ContentScanner, ContainmentGuard (→ `soma-policy-guard`), ModeClassifier (→ `soma-mode-classifier`), LoadContext (→ projection + `soma-claude-code-hook`).
- *Flinch (JC retracted the experiment completely):* FlinchDetect, FlinchReview — **and delete the Soma `flinch` skill** (`~/.soma/skills/flinch`).
- *Voice (JC won't port):* VoiceCompletion.
- *Cruft:* FileChangeTracker, SkillEnforcer, SkillGuard, SkillLoadLogger, LastResponseCache, KittyEnvPersist, SetQuestionTab, QuestionAnswered.
- *PAI-infra:* KVSync, UpdateCounts, AgentInvocation, StopFailureHandler, IntegrityCheck, DocIntegrity.

⚠️ **5 retire-list hooks still `import` from `../PAI/…`** (ContainmentGuard, FlinchDetect, FlinchReview, IntegrityCheck, VoiceCompletion) — they hard-break when the PAI tree is removed. They're unwired so it's inert, but retire them WITH the tree removal. (ContainmentGuard's pattern list was already emptied in the migration — a no-op today.)

## Then: finish de-PAI (from the 2026-07-06 handover)

1. **Clear `settings.json` PAI residue** (`autoMode`/`daidentity`/`spinnerTipsOverride` + the 1 live ref INTO the PAI tree) — this is the safety blocker for removing the tree. ⚠️ `settings.json` is GITIGNORED; back it up first (a `settings.json.backup-preSkillInstall` already exists from this session).
2. **Retire the ~19 hook FILES** → `_retired-2026-07/` (per the ledger above), after confirming no KEPT hook imports from `hooks/lib/` shared by PAI.
3. **Remove the 18 MB `~/.claude/PAI/` tree** — backup-copy first (not git-reversible for ignored paths), grep-confirm zero refs, then delete. The symbolic "PAI is gone" moment.
4. Migrate the kept `CLAUDE.md` guidance (completion guard / MODES) into `~/.soma` (#5 in the old handover); decide #403 (per-prompt recall as ACR's Soma-native successor).

## PR / review workflow (how the last arc landed)

The skill-projection PR (#437) went: push branch → `gh pr create` (use `--body-file`, NOT an inline `$(cat <<EOF)` subshell — the runtime policy blocks that as `env-egress`) → **`sage review the-metafactory/soma#<N> --substrate <pi|codex> --post --emit-verdict-block`** (runs the botanical reviewer on a pi.dev or Codex LLM substrate; posts to the PR). Sage tends NOT to converge to `approve` (it surfaces fresh nits each round, even regresses) — so triage its findings (verify each; several were false alarms / misreads / pre-existing) and, once the real ones are fixed, the repo's `REVIEW_REQUIRED` ruleset needs an admin-override merge (`gh pr merge <N> --squash --admin --delete-branch`) since Sage's verdict posts as a COMMENT, not an approval. JC authorized admin-merge when Sage won't approve.

## Verify before declaring done

- `bun run typecheck` + `bun test` (full suite ~1851 pass; the 5000ms failures are environmental timeout flakes under parallel load — re-run or run the file alone to confirm).
- For anything touching `~/.claude` (installs, hook removal): back up gitignored `settings.json`, keep the 117 native skill dirs intact, keep `settings.json` at 0 PAI / 8 soma hooks, and don't pass `--claude-md` (leaves the de-PAI'd CLAUDE.md alone).
