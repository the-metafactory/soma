---
task: "Soma: one portable assistant that stays aimed at its operator's confirmed intent"
slug: soma
effort: E3
phase: observe
started: 2026-11-16
updated: 2026-11-16
---

## Problem

Soma extracted the assistant core (ISA.md, 30/30 criteria) and projects it into six substrates (AGENTS.md "Substrate Adapters"). The core is portable, but nothing in it keeps the work aimed at intent. Evidence read on 2026-11-16 (read-only, from the repo and public GitHub data):

- No product-level ideal state exists. The repo root has `ISA.md`, an extraction project closed at `phase: verify` with `progress: 30/30` (ISA.md:5-6), and AGENTS.md still names it the source of truth.
- Nothing makes a session read the ideal state before it edits. The Claude Code hook only mirrors VSA edits into a run (`src/substrates/adapters/claude-code/hook-runner.mjs:222-236`); no hook denies an edit.
- The VSA format has no levels on `main`. `soma vsa check --project` and the three-level Vision are in review as the-metafactory/soma#1171 (`src/cli/vsa.ts:265`, 6 tests in `test/vsa-project-check.test.ts`).
- Goal records do not have to say how a goal moves. `soma goal add` requires only `--wording` (`src/cli/goal.ts:54`).
- Errata do not reach evals. `soma errata` has no verb that links an eval check (`src/cli/errata.ts:13-18`).
- Permissions are prose. "Ask before" rules live as paragraphs in a home's `policy/behavior.md` "Permission boundaries" section (`src/policy/behavior-policy.ts:245`); no table exists for the policy guard to read.
- Volume is high: 84 PRs merged in the last 30 days and 126 open issues, 49 of them older than 90 days (`gh`, read-only).

## Vision

- **Level 1 — Life outcome.** An operator switches or mixes AI substrates without re-teaching their assistant, and the goals they set move because the assistant aims at them. They spend their time on decisions they chose, not on keeping the assistant coherent.
- **Level 2 — System behavior.** One Soma home gives every substrate the same identity, purpose, memory, skills and method. Every session that changes a product first reads the ideal state its maintainers confirmed. Every goal says how it is measured, what moves it and what happens next. Every miss the operator reports becomes an eval check, and every risky action is decided by one permissions table.
- **Level 3 — Mechanism.** A three-level VSA format with `soma vsa check --project`; a read-the-VSA hook for interactive sessions; goal records that require Sensor, Mechanism and First move; the `evals` skill as the one criterion-eval system, with errata linking to it; a permissions table read by the policy guard.

Euphoric surprise: an operator opens Codex instead of Claude Code for a week, and nothing about their assistant's behavior, goals or guardrails changes.

## Out of Scope

- Replacing Cortex, Myelin, Arc, Signal, Spawn, Compass or ranger (carried from ISA.md). Soma supplies the core they host.
- Building ranger's claim gate or Sage's flip check. They live in ranger and Sage.
- A marketplace or multi-user organizational routing (carried from ISA.md).
- The content of any one operator's home: their goals, memory, skills and the size of their context.
- Running the goals themselves. Soma records them; ranger, Reflex and the skills move them.

## Principles

- Substrates are adapters, not the product (ISA.md).
- Filesystem-native state is the portability layer, and deterministic code owns formats, validation and migration (ISA.md).
- Intent over steps: state done and how to tell, then let the builder choose the route.
- Misses sharpen checks, not prompts.
- For each addition, name what it removes.

## Constraints

- TypeScript and Bun.
- The core must work without Claude Code hooks and without a daemon (ISA.md). A hook may enforce a rule, but the rule lives in the core.
- The repo is public and shared. VSA.md, templates and tests name goals by ID only; goal wording and private context stay in each operator's soma home (`format.md` "Frontmatter").
- No yes-gate on deploy, money, delete, publish or outbound message is removed or loosened.
- Each change lands as its own PR, reviewed by Sage.

## Goal

Soma has a confirmed `VSA.md` that `soma vsa check --project` passes. Interactive sessions read it before editing, new goal records carry measure, mover and first move, misses become eval checks, and permissions come from one table.

## Checkpoints

### Ideal state
- [ ] ISC-1: `soma vsa check --project .` exits 0 on the soma repo root.
- [x] ISC-2: Decisions records the maintainers' dated confirmation of Levels 1 and 2 (`confirmed: levels 1-2`).
- [x] ISC-3: AGENTS.md names `VSA.md`, not `ISA.md`, as the source of truth.

### VSA format and gate
- [ ] ISC-4: On main, `soma vsa check --project` exits non-zero on a VSA whose Vision lacks Level 2, and the message names "Level 2".
- [ ] ISC-5: In a repo with a `VSA.md`, the Claude Code hook denies the first Edit or Write of an interactive session that has not read that file.
- [ ] ISC-6: After a Read of `VSA.md`, the same session's Edit is allowed, and ranger worker sessions are never denied.
- [ ] ISC-7: Anti: The hook never blocks a session in a repo without a `VSA.md`, and never blocks a read.

### Goals carry measure, mover, first move
- [ ] ISC-8: `soma goal add` without any one of Sensor, Mechanism or First move fails with an error that names the missing field.

### Errata feed evals
- [ ] ISC-9: An errata entry for "rejected after passing" cannot close until it links an eval check that fails on the rejected artifact and passes on the fix.

### Permissions
- [ ] ISC-10: One permissions table covers deploy, money, delete and outbound message, and the policy guard denies an outbound send that the table does not allow.
- [ ] ISC-11: Anti: No ask or deny rule stated in a home's `policy/behavior.md` "Permission boundaries" section is missing from the table.

### Portable core (carried from ISA.md)
- [x] ISC-12: `bun run test:portability` passes: the projections keep the same semantic content and active VSA state across substrates.
- [x] ISC-13: `bun run check:boundaries` reports 0 violations.
- [x] ISC-14: Anti: `bun run check-release-privacy` finds no private markers in the repo.
- [ ] ISC-15: `bun run test` and `bun run typecheck` pass on main.

## Test Strategy

| ISC | Probe |
| --- | --- |
| 1 | `soma vsa check --project .` exit code at the repo root. |
| 2 | `grep -n "confirmed: levels 1-2" VSA.md` returns a dated line. |
| 3 | `grep -n "VSA.md" AGENTS.md` under "How To Work In This Repo"; no "Treat `ISA.md`" line. |
| 4 | `bun test test/vsa-project-check.test.ts` on main, with the missing-level fixture. |
| 5, 6, 7 | Scripted Claude Code hook run: Edit before Read denies; Read then Edit allows; ranger worker allows; repo without `VSA.md` allows; Read always allows. |
| 8 | `soma goal add --wording x` three times in a temp home, each missing one field: three non-zero exits naming the field. |
| 9 | Errata CLI test: close without a link fails; with a check that fails old and passes new, it succeeds. |
| 10 | policy-guard unit test with an outbound send absent from the table: deny. |
| 11 | Test with a fixture `behavior.md`: every action its "Permission boundaries" section lists is present in the table as ask or deny. |
| 12 | `bun run test:portability`. |
| 13 | `bun run check:boundaries`. |
| 14 | `bun run check-release-privacy`. |
| 15 | `bun run test && bun run typecheck`. |

## Features

| Feature | Satisfies | Depends on |
| --- | --- | --- |
| F-vsa: confirm this VSA, retire ISA.md as source of truth | ISC-1–3 | F-levels |
| F-levels: three-level format and `--project` check (#1171) | ISC-4 | none |
| F-hook: read-the-VSA hook for interactive Claude Code sessions | ISC-5–7 | F-vsa |
| F-goal-fields: required Sensor, Mechanism, First move | ISC-8 | none |
| F-errata-evals: link errata to eval checks | ISC-9 | none |
| F-permissions: permissions table read by the policy guard | ISC-10, 11 | none |
| Portable core upkeep | ISC-12–15 | none |

Order: F-levels, then F-vsa, then F-hook, because the hook gates on a VSA that must already pass the check.

## Decisions

- 2026-11-16: This `VSA.md` is Soma's living product ideal state and supersedes `ISA.md`. ISA.md recorded the 2026-05/06 extraction (30/30 criteria). Its Principles, Constraints and Out of Scope that still describe the product are carried over above and marked "(ISA.md)". Its first-iteration exclusion of a dashboard is dropped, since the mission dashboard prototype shipped on 2026-10-18 (ISA.md:209).
- 2026-11-16: `ISA.md` becomes a one-line pointer to `VSA.md`; its history stays in git. ISC-3 covers the AGENTS.md side.
- 2026-11-16: This file describes the shared product. Criteria about one operator's home (their goal records, eval folders, context size or skill count) belong in that operator's own VSA, not here.
- 2026-11-16: Effort is E3, the project-VSA minimum. Changelog and Verification sections can be added when the first ISC flips.
- 2026-11-16: ISC-12–14 were verified on a main checkout at `b7d5d7a` (2026-10-31): portability 3 pass, boundaries 0 violations over 329 files, release privacy ok. ISC-4's tests pass (6/6) on the #1171 branch but are not on main, so ISC-4 stays open.
- 2026-11-16: confirmed: levels 1-2 (jcfischer). Level 3 stays the builders' to change.
