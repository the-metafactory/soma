# Soma ISA Rollout — Sprint Plan

**Period:** 2026-05-16 → ~2026-06-20 (5 sprints, ~1 week each)
**Scope:** Ship the unified ISA primitive (#41) and its consumers (#32, #33, #34, #36, #37, #38, #39), plus the deferred merge (#35) and the quick-win (#18). Unblock the PAI-migration chain (#28, #29, #30). Excludes #42 and #43 (untriaged).

---

## Development Cycle (canonical loop)

Every issue follows this loop. No exceptions.

```
┌────────────────────────────────────────────────────────────────────┐
│  1. CLAIM         pick top issue from current sprint               │
│                   post intent to soma channel                      │
│                                                                    │
│  2. WORKTREE      create a dedicated git worktree for the issue    │
│                   git worktree add ../soma-issue-<N> -b feat/issue-<N>-<slug>  │
│                   cd ../soma-issue-<N>                             │
│                   isolates filesystem state from main checkout     │
│                                                                    │
│  3. IMPLEMENT     write code + tests against issue ACs             │
│                   self-verify all ACs locally in the worktree      │
│                                                                    │
│  4. PR            push branch, open PR linking the issue           │
│                   title: feat(area): <summary> (#<N>)              │
│                   body: AC checklist, test evidence                │
│                                                                    │
│  5. SAGE REVIEW   ping Sage for code review                        │
│                   wait for verdict                                 │
│                                                                    │
│  6. FIX           address every Sage finding IN THE WORKTREE       │
│                   push fix commits to same PR                      │
│                   re-ping Sage                                     │
│                                                                    │
│  7. ITERATE       loop steps 5-6 until Sage approves               │
│                                                                    │
│  8. MERGE         squash-merge into main                           │
│                   git worktree remove ../soma-issue-<N>            │
│                   delete branch                                    │
│                   close issue with merge SHA                       │
│                                                                    │
│  9. NEXT          return to step 1, claim next issue,              │
│                   new worktree (never reuse the old one)           │
└────────────────────────────────────────────────────────────────────┘
```

### Cycle invariants

- **One issue at a time per implementer.** No parallel claims within one person's queue.
- **One worktree per issue.** Never reuse a worktree across issues. Always create fresh from main.
- **Parallel issues = parallel worktrees.** Sprint 3's fan-out (#36, #37, #38, #39) runs each in its own worktree — isolated branches, isolated filesystem state, no cross-contamination.
- **Sage is the gate.** No merge without Sage approval. Disagreement with Sage findings goes back as a PR comment, not bypass.
- **Push fixes, never amend a reviewed commit.** Sage tracks per-commit deltas.
- **AC checklist in PR body.** Each Sage round verifies the checklist matches code.
- **Re-ping after every fix push.** Sage does not auto-poll.
- **Always remove the worktree after merge.** `git worktree remove ../soma-issue-<N>` — leaving stale worktrees breaks the next claim.

### Worktree conventions

- **Location:** `~/work/mf/soma-issue-<N>/` (sibling to main checkout at `~/work/mf/soma/`)
- **Branch naming:** `feat/issue-<N>-<short-slug>` — slug matches issue title, kebab-case, <=4 words
- **Setup once per worktree:** `bun install` (separate `node_modules` per worktree)
- **Listing:** `git worktree list` from main checkout shows all active worktrees
- **Stuck worktree:** `git worktree prune` removes records for deleted directories

### Failure modes + escalation

| Failure | Response |
|---|---|
| Sage flags blocker | Fix in same PR. No new issue. |
| Sage flags out-of-scope concern | File new issue, link from PR, ignore in current cycle. |
| Sage and implementer disagree on a finding | Surface to principal in PR thread. Principal arbitrates. |
| Two Sage rounds with no progress | Pause issue, re-scope or close. Don't grind. |
| CI fails after Sage approval | Fix in same PR, re-ping Sage for delta only. |

---

## Sprint 1 — Foundation (this week)

**Goal:** Land the type unification (#41) and the two issues that need no upstream dependency. Three things in parallel.

| # | Title | Owner | Dependencies | Effort | Sage gate |
|---|---|---|---|---|---|
| #41 | ISA Layer 0: unify `IdealStateArtifact` + `SomaIsa` | TBD | none — Holly approved v3 | 2-3 days | All 15 ACs (AC-1..AC-15) pass; compat shim test + dual-phase removal verified |
| #33 | ISA Layer 2: ship skill source + bootstrap + versioning | TBD | none (independent of #41) | 2 days | Per-file baseline hashing works; CI version-bump check active; AC-6 not in this issue |
| #18 | Normalize PAI packs during import | TBD | none | 1 day | Quick win — Holly review not blocking |

**Sprint 1 exit criteria:**
- #41 merged → unblocks #32, #34, #36-#39
- #33 merged → unblocks #34, #37 (skill bundling)
- #18 merged → quick win delivered
- Holly notified that ISA chain foundation is live

---

## Sprint 2 — Library + Storage

**Goal:** Ship the storage layout (#32) and the library CRUD that everything else consumes (#34).

| # | Title | Dependencies | Effort | Sage gate |
|---|---|---|---|---|
| #32 | ISA Layer 1: storage contract + active-state | #41 merged | 1 day | `~/.soma/isa/`, `~/.soma/memory/STATE/active.json` schema; bootstrap idempotent |
| #34 | ISA Layer 3: library CRUD API | #32 + #41 merged | 3 days | All 7 functions exported; semantic-equivalence round-trip; `EffortTier` uppercase re-export; single-writer `events.jsonl` documented; `SECTION_NAME_MAP` exported from `src/isa-schema.ts` |

**Sprint 2 exit criteria:**
- #32 merged → storage contract canonical
- #34 merged → unblocks #36, #37, #38, #39 in parallel
- `src/isa.ts` + `src/isa-schema.ts` available to all downstream issues

---

## Sprint 3 — CLI + Adapters + Lifecycle + Algorithm (parallel fan-out)

**Goal:** Fan out four parallel implementers against #34's library. CLI sequential after others if implementer count limits.

| # | Title | Dependencies | Effort | Sage gate |
|---|---|---|---|---|
| #36 | ISA Layer 4: `soma isa` CLI surface | #34 + #33 merged | 2 days | All 7 subcommands work; `--dry-run` only on mutations; negative-path tests pass; `list --phase` and `archive` shipped |
| #37 | ISA Layer 6: adapter projections | #34 + #33 merged | 2 days | ✅ MERGED (#65 → `894bb5d`) — 1 Sage round commented (2 maintainability suggestions applied) |
| #38 | ISA Layer 7: lifecycle hooks | #34 merged | 2 days | ✅ MERGED (#62 → `99556b6`) — `runSomaLifecycleIsaUpdated` event ships; payload write-then-audit with refused-scope guard |
| #39 | ISA Layer 5: Algorithm integration (advisory) | #34 + #38 merged | 2 days | ✅ MERGED (#63 → `007d1f6`) — 3 Sage rounds (non-blocking telemetry contract, WeakSet→boolean, pass-through removal, test fixture dedup) |

**Sprint 3 parallelization:**

```
After #34 + #33 merged:
  Implementer A → #36
  Implementer B → #37
  Implementer C → #38, then #39 (sequential — #39 needs #38)
```

**Sprint 3 exit criteria:**
- ISA chain shipped end-to-end (excluding #35 deferred)
- `soma isa` command suite usable from any substrate
- Algorithm runs emit hint correctly, telemetry collects, suppression works

---

## Sprint 4 — Unblock PAI Migration

**Goal:** Resolve the architectural blocker on #29 (the `@~/` import path silently fails), then ship the migration chain.

**Prerequisite work (file before Sprint 4 begins):**

1. **New architecture issue: "Claude Code adapter — pivot from `@`-imports to `.claude/rules/` auto-discovery"**
   - Cite test harness evidence: home-dir `@`-imports fail silently in Claude Code v2.1.138
   - Propose `.claude/rules/` directory (auto-discovered by Claude Code, no import syntax needed)
   - Block #29 until this is decided
2. **Close #30 with redirect** — Holly's review: should be two CLI commands, not orchestrator. File `soma migrate-pai` + `soma adopt-claude` as separate issues.

| # | Title | Dependencies | Effort | Sage gate |
|---|---|---|---|---|
| #64 | Claude Code adapter `.claude/rules/` pivot architecture | — | 1 day spec | ✅ FILED — closed architecturally in issue body, no review cycle |
| #29 | Claude Code adapter: full install + projection | #64 resolved | 3 days | ✅ MERGED (#66 → `641d58e`) — minimal-correct (rules/soma/ skeleton + ISA skill projection + uninstaller). Hooks/settings/CLI deferred to follow-up. 2 Sage rounds (uninstall error-swallow, type narrowing, file-list dedup) |
| #28 | Automatic migration of existing PAI installation | #29 merged | 3 days | ✅ MERGED (#69 → `8567283`) — minimal-correct orchestrator (identity + algorithm + packs + MIGRATION.md). Per-category importers (skills/agents/commands/auto-memory) deferred. 4 Sage rounds (timestamp idempotency, ENOENT-only gates on packs+exists, bounded pack concurrency) |
| #67 | `soma migrate pai` CLI command | #28 merged | 1 day | OPEN — replaces #30 orchestrator |
| #68 | `soma adopt claude` CLI command | #29 merged | 1 day | OPEN — replaces #30 orchestrator |
| #30 | End-to-end migration | — | — | ✅ CLOSED — split into #67 + #68 per autonomous plan |

**Sprint 4 exit criteria:**
- PAI-on-Claude-Code → Soma + Claude Code adapter path works end-to-end
- No `@~/` imports anywhere in the codebase
- Two clean CLI commands instead of one orchestrator

---

## Sprint 5+ — Deferred + Polish

**Goal:** Ship the deferred merge (#35), revisit untriaged adapter polish (#42, #43 — out of this plan's scope).

**Gate check before starting #35:** confirm #34 has been merged for **≥2 weeks with zero breaking changes** to `IdealStateArtifact` type or `parseIsa`/`serializeIsa` interface. If breaking changes shipped, restart the 2-week clock.

| # | Title | Dependencies | Effort | Sage gate |
|---|---|---|---|---|
| #35 | ISA Layer 3b: `reconcileIsa` deterministic merge | #34 stable +2wk | 1-2 weeks | Design doc signed off by non-author of #34; all 9 adversarial inputs answered; property tests + correctness ACs pass; conflict policy in `~/.soma/isa/config.json` |

**Sprint 5+ exit criteria:**
- `reconcileIsa` shipped, callable from CLI (`soma isa reconcile`) + lifecycle
- Ephemeral feature-file workflow viable in Soma (parity with PAI Ralph Loop pattern)

---

## Dependency graph (full chain)

```
Sprint 1                Sprint 2          Sprint 3                  Sprint 4              Sprint 5+
─────────               ─────────         ─────────                 ─────────             ─────────
#41 ────┐
        ├──→ #32 ──┐                                                                                
#33 ────┤          ├──→ #34 ─┬──→ #36                                                              
        │          │         ├──→ #37                                                              
#18     │          │         ├──→ #38 ──→ #39                                                      
        │          │         └──→ #35 (after +2wk stability) ───────────────────────────────→  •
        │                                                                                          
                                          [new arch issue] ──→ #29 ──→ #28 ──→ migrate-pai      
                                                                            └─→ adopt-claude     
                                                                            (close #30)          
```

---

## Open architectural decisions (resolve before relevant sprint)

1. **Sprint 2 (before #34):** Validator config format — Holly's resolution said TypeScript constant in `src/isa-schema.ts`. Confirm this stays in-tree (vs externalized to JSON/YAML).
2. **Sprint 4 (before #29):** Pivot from `@`-imports to `.claude/rules/`. File new issue, get Holly adversarial review, decide before any PAI-migration work.
3. **Sprint 5 (before #35):** Conflict policy default — Holly's resolution said `~/.soma/isa/config.json`. Confirm the default value (`error` vs `prefer-master` vs `prefer-feature`).

---

## Risks to monitor

| Risk | Owner | Mitigation |
|---|---|---|
| #34 raw-spans round-trip diverges from semantic-equivalence promise | Implementer | Document in `src/isa.ts` header: "in-flight Algorithm runs always get semantic equivalence, never byte preservation, due to immutable spreads" |
| #35 design-doc sign-off gate stalls (one-person rotation) | Principal | Pair the #34 implementer with a second reviewer before #34 lands |
| #39 telemetry-command shipping slips, `no-active-isa` events accumulate unread | Implementer | `soma isa telemetry` is part of #39's merge gate, not a follow-up |
| #29 architecture pivot reveals deeper Claude Code limitations | Architecture lead | Spike on `.claude/rules/` discovery semantics before committing to spec |
| Sage and Holly disagree on a finding | Principal | Holly = design review (pre-PR), Sage = code review (post-PR). They operate on different artifacts; conflicts mean the spec drifted from the code |

---

## Out of this plan

- **#42** Codex Algorithm display banners — UNTRIAGED, needs Holly review before sprint allocation
- **#43** Pi.dev renderer extension — UNTRIAGED, needs Holly review before sprint allocation

Both should get adversarial reviews in parallel with Sprint 1, then slot into Sprint 4 or 5 depending on Holly's findings.

---

## Tracking

- **Issue board:** standard `the-metafactory/soma` GitHub Issues, filtered by `enhancement` label
- **Sprint reviews:** end of each sprint, post status to soma channel (open / in-review / merged / blocked)
- **Cycle compliance:** every merged PR must show Sage approval comment in its history. PRs merged without Sage review get reverted

---

*Updated: 2026-05-16. Owner: principal. Revise after Sprint 1 retrospective.*
