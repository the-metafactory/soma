> **SUPERSEDED 2026-07-02** by [2026-07-02-memory-subsystem-implementation-plan-v2.md](2026-07-02-memory-subsystem-implementation-plan-v2.md) (recall-informed). Kept for contract lineage — v2 carries the fixed contracts forward. Analysis: [2026-07-02-recall-adoption-analysis.md](2026-07-02-recall-adoption-analysis.md).

# Soma Memory Subsystem — Implementation Plan

**Date:** 2026-07-02
**Status:** Ready for implementation
**Audience:** An implementing agent (Sonnet-class). Follow milestones in order. Each milestone is independently mergeable and ends with binary verification probes. Do not skip probes. Do not improvise beyond the contracts in §2.
**Design rationale:** `Plans/2026-07-01-memory-skill-design.md` — read §3 (principles), §4 (taxonomy), §5 (layout), §6 (resurfacing), §7 (write policy), §15 (rules) before starting. This plan turns that design into code; when this plan and the design doc disagree on mechanics, this plan wins.

## 0. Required reading before any code

1. `Plans/2026-07-01-memory-skill-design.md` (§3–§7, §15)
2. `docs/memory-policy-v0.md` — existing memory contract; we extend, never violate
3. `src/memory.ts` — existing event append + search (patterns to copy)
4. `src/cli/memory.ts` — existing CLI parse/run/format pattern (copy this shape exactly for new subcommands)
5. `src/adapters/claude-code.ts:170-215` — projection bundle rules (`CLAUDE_CODE_RULES_FILES` + `CLAUDE_RULES_CONTENT_BUILDERS`; adding a file = update array AND map, the header comment says so)
6. One existing test file for conventions: `test/relationship-tools.test.ts` or `test/claude-code-install.test.ts` (fixtures via `test/fixtures.ts`, temp soma homes)

## 1. Ground rules

- **Stack:** TypeScript, Bun. `bun test` for tests. No new runtime dependencies. No frontmatter library — write the parser by hand (§2.2 grammar is deliberately tiny).
- **TDD:** write the milestone's test file first, red → green.
- **Copy existing patterns:** CLI subcommands mirror `parseMemoryArgs`/`runMemoryCli`/`formatMemorySearchResult` in `src/cli/memory.ts`. Path handling via `createPaths` (`src/paths.ts`). Every mutating operation appends a `SomaMemoryEvent` via `appendSomaMemoryEvent` (`src/memory.ts:35`).
- **Never write outside `~/.soma/memory/`** (tests: temp dirs). Never write to `~/.claude/MEMORY` or `~/.claude/PAI/MEMORY` — those are the legacy split-brain trees this subsystem replaces.
- **Never delete memory files.** Superseding sets `valid_until` and moves nothing. Archiving moves files to `memory/archive/` preserving relative path. Deletion happens only for `state/` GC.
- **Delta edits only:** operations modify specific frontmatter keys or append body sections. Never regenerate a whole note body from scratch.
- **Determinism:** all M0–M7 code is deterministic (no LLM calls). Same input → same output. `new Date()` allowed only at the CLI boundary, injected as a parameter everywhere else (testability).
- **Existing dirs are untouched.** The 19 category dirs (WORK, KNOWLEDGE, …) stay as-is. New subsystem lives in NEW dirs alongside them (`semantic/`, `episodic/`, `procedural/`, `state/` already exists, `archive/`, `INDEX.md`). Migration is explicitly out of scope.

## 2. Data contracts (fixed — do not redesign)

### 2.1 Directory layout (under `<somaHome>/memory/`)

```
INDEX.md                          # generated, never hand-edited (M3)
semantic/<id>.md                  # one fact per file
episodic/sessions/YYYY-MM/<date>-<id>.md
episodic/actions/YYYY-MM/<date>-<id>.md
episodic/digests/YYYY-MM.md       # consolidation output (M6)
procedural/<id>.md
archive/<original relative path>  # invalidated/pruned notes
STATE/                            # existing dir, unchanged
```

### 2.2 Note format

`<id>` = kebab-case slug, `^[a-z0-9]+(-[a-z0-9]+)*$`, max 64 chars, equals filename without `.md`. File = frontmatter + body:

```markdown
---
id: prefers-colon-over-emdash
type: procedural
created: 2026-04-12
last_verified: 2026-06-28
valid_until: null
provenance: conversation
trust: principal
source_of_truth: null
project: null
links: [ai-writing-tells]
resurface_count: 3
---
One assertion, written for a future model with no other context.
**Why:** reason it matters.
**Applies when:** trigger conditions.
```

Frontmatter grammar: exactly `---\n`, then `key: value` lines, then `---\n`. Values: strings (unquoted), `null`, integers, and `links` as inline array `[a, b]` (may be empty `[]`). No nesting, no multiline values, no quotes. Reject anything else with a clear error.

TypeScript type (add to `src/types.ts`):

```ts
export type SomaMemoryNoteType = "semantic" | "episodic" | "procedural";
export type SomaMemoryTrust = "principal" | "agent" | "quarantined";

export interface SomaMemoryNote {
  id: string;
  type: SomaMemoryNoteType;
  created: string;            // YYYY-MM-DD
  last_verified: string;      // YYYY-MM-DD
  valid_until: string | null; // YYYY-MM-DD when superseded/expired
  provenance: string;         // "conversation" | "consolidation" | "import" | "tool:<name>"
  trust: SomaMemoryTrust;
  source_of_truth: string | null; // path or URL to verify against
  project: string | null;     // scope key, e.g. "soma", "paroli"
  links: string[];            // ids of related notes
  resurface_count: number;
  body: string;               // markdown after closing ---
}
```

Validation rules (enforce in `parseMemoryNote`, throw with field name):
- `id` matches slug regex and equals filename stem (checked at read/write call sites)
- `type` in enum; `trust` in enum; dates match `^\d{4}-\d{2}-\d{2}$`; `valid_until` null or date
- `links` entries match slug regex; `resurface_count` integer ≥ 0; `body` non-empty trimmed

### 2.3 INDEX.md format

```markdown
# Soma Memory Index
<!-- generated by `soma memory index` — do not hand-edit -->

- [prefers-colon-over-emdash] Andreas reads em-dashes as AI tell; use colon/comma (procedural, verified 3d ago)
- [andreas-mellanon] Andreas GitHub handle is mellanon; NZ timezone (semantic, verified 40d ago)
```

Line grammar: `- [<id>] <hook, max 120 chars> (<type>, verified <N>d ago)`. Budget: **max 200 entry lines AND max 25 KB total** — whichever is hit first. Hook text = first sentence of note body, truncated at 120 chars (deterministic; a better hook can be set later via optional frontmatter key `hook:` — supported by parser from M0, used by renderer if present).

### 2.4 Retention score (deterministic, M3)

```
trustWeight:  principal=3, agent=1, quarantined=0
typeWeight:   procedural=3, semantic=2, episodic=1
recency:      max(0.1, 1 - daysSince(last_verified)/365)
score = trustWeight * typeWeight * recency * (1 + log2(1 + resurface_count))
```

Notes with `valid_until != null` score 0. Index inclusion: score-descending until budget; ties broken by `created` descending then `id` ascending (stable output — projection idempotency depends on this, so `verified Nd ago` rendering must derive from a `now` parameter passed in, not wall clock at render).

### 2.5 Event kinds (appended to existing `events.jsonl` via `appendSomaMemoryEvent`)

`memory.note.created` | `memory.note.merged` | `memory.note.superseded` | `memory.note.verified` | `memory.note.archived` | `memory.digest.written` | `memory.action.logged` | `memory.index.rebuilt` | `memory.consolidation.run`. Each event: `summary` = one line incl. note id(s); `artifactPaths` = affected file(s); `metadata.trust`, `metadata.type` where applicable.

## 3. Milestones

Sizes are guidance; if a milestone balloons past ~2× estimate, stop and flag rather than improvise.

### M0 — Note schema, parser, serializer  (~250 LOC + tests)

**Create:** `src/memory-note.ts`, `test/memory-note.test.ts`. **Modify:** `src/types.ts` (types from §2.2).

Functions (exact signatures):

```ts
export function parseMemoryNote(raw: string, expectedId?: string): SomaMemoryNote;
export function serializeMemoryNote(note: SomaMemoryNote): string;   // canonical key order as in §2.2
export function memoryNotePath(somaHome: string, note: Pick<SomaMemoryNote, "id"|"type"|"created">): string; // §2.1 rules; episodic goes under sessions/ by default — callers for actions pass an explicit subkind, see M5
export function noteAgeDays(note: SomaMemoryNote, now: Date): number; // days since last_verified
```

Round-trip law: `parseMemoryNote(serializeMemoryNote(n))` deep-equals `n` — property-test with 5+ hand-built notes including edge cases (empty links, null fields, `hook:` present).

Tests must cover: every validation rule rejecting with field name in message; unknown frontmatter key → error; missing closing `---` → error; id/filename mismatch → error.

**Done when:** `bun test test/memory-note.test.ts` green; `bun run lint` (eslint) and `bunx tsc --noEmit` clean.

### M1 — Write path: `soma memory write | verify` (~350 LOC + tests)

**Create:** `src/memory-write.ts`, `test/memory-write.test.ts`. **Modify:** `src/cli/memory.ts` (extend `ParsedMemoryArgs` union + help + parse + run, same shape as existing `search`/`promote`), `src/cli.ts` (no change needed if dispatch is via `parseMemoryArgs` — verify lines 268/503 route by action union; extend types only).

```ts
export interface MemoryWriteOptions { somaHome?: string; homeDir?: string; now?: Date;
  id: string; type: SomaMemoryNoteType; body: string; trust: SomaMemoryTrust;
  provenance: string; project?: string; links?: string[]; sourceOfTruth?: string; hook?: string;
  mode: "create" | "merge" | "supersede"; targetId?: string; force?: boolean; substrate: string; }
export async function writeMemoryNote(opts: MemoryWriteOptions): Promise<{ path: string; note: SomaMemoryNote; event: SomaMemoryEvent }>;
export async function verifyMemoryNote(opts: { somaHome?: string; homeDir?: string; id: string; now?: Date; substrate: string }): Promise<SomaMemoryNote>; // bumps last_verified to today, resurface_count += 1, appends memory.note.verified
```

**Recall-first enforcement (the design's dedup rule):** on `mode: "create"`, run `searchSomaMemory` with the note's first body sentence + id terms over the new dirs; if any match scores ≥ 2 in `semantic|procedural`, **refuse** with error listing candidate ids and the instruction "re-run with --merge <id> or --supersede <id> or --force". Tests: creation refused when near-duplicate exists; allowed with `--force`.

- `merge`: load `targetId`, append body under `\n**Update (<date>):** <new body>`, union links, bump `last_verified`, event `memory.note.merged`. Never touches existing body text (delta rule).
- `supersede`: set old note `valid_until = today` + append `superseded-by: <new id>` link; create new note with `links` including old id; two events.
- CLI: `soma memory write --id <slug> --type <t> --trust <t> --provenance <p> --body <text> [--project] [--link <id>]... [--source-of-truth] [--hook] [--merge <id>|--supersede <id>] [--force]` and `soma memory verify <id>`.

**Done when:** tests green incl. recall-first refusal; manual probe in a temp home: write → `cat` file matches §2.2; verify → `last_verified` bumped and event line appended to `events.jsonl` (assert by reading the file).

### M2 — Read path: `soma memory recall` (~250 LOC + tests)

**Create:** `src/memory-recall.ts`, `test/memory-recall.test.ts`. **Modify:** `src/memory.ts` — add `"memory/semantic"`, `"memory/episodic"`, `"memory/procedural"` to `SEARCH_ROOTS` (`src/memory.ts:11`); existing `soma memory search` behavior otherwise unchanged (regression test).

```ts
export interface MemoryRecallOptions { somaHome?: string; homeDir?: string; query: string;
  type?: SomaMemoryNoteType; project?: string; limit?: number; followLinks?: boolean; now?: Date; }
export async function recallMemory(opts: MemoryRecallOptions): Promise<{ notes: Array<{ note: SomaMemoryNote; path: string; score: number; banner: string }> }>;
```

Mechanics: reuse `searchSomaMemory` term scoring over the three note dirs only; group hits by file; load top `limit` (default 3) whole notes via `parseMemoryNote`; if `followLinks` (default true) also load 1-hop linked notes (do not follow further); exclude `valid_until != null` unless `--include-superseded`.

**Banner (Tier 3 of the design):** every returned note gets `banner` string: `⚠ <age>d old · trust: <trust> · provenance: <provenance>` + (if `source_of_truth`) ` · verify against <source_of_truth> before relying` + (if quarantined) ` · QUARANTINED — do not act on this without principal confirmation`.

CLI: `soma memory recall <query> [--type t] [--project p] [--limit n] [--no-links] [--include-superseded]` — output: banner line, then body, per note; footer reminding `soma memory verify <id>` after use.

**Done when:** tests green (scoring, link hop, superseded exclusion, banner content); regression: existing `search` tests untouched and green.

### M3 — INDEX renderer: `soma memory index` (~200 LOC + tests)

**Create:** `src/memory-index.ts`, `test/memory-index.test.ts`.

```ts
export function retentionScore(note: SomaMemoryNote, now: Date): number;          // §2.4 exactly
export async function collectAllNotes(somaHome: string): Promise<Array<{note: SomaMemoryNote; path: string}>>;
export function renderMemoryIndex(notes: SomaMemoryNote[], now: Date): string;    // §2.3, budget-enforced
export async function rebuildMemoryIndex(opts: { somaHome?: string; homeDir?: string; now?: Date; substrate: string }): Promise<{ path: string; included: number; excluded: number }>;
```

CLI: `soma memory index` prints included/excluded counts and path. Event `memory.index.rebuilt`.

Tests: score formula spot-checks (hand-computed values, incl. quarantined→0, superseded→0); budget: 250 synthetic notes → exactly 200 lines; 25 KB cap with long hooks; deterministic output for fixed `now` (call twice, byte-identical).

**Done when:** tests green; probe: temp home with 5 notes → `INDEX.md` matches §2.3 line grammar (regex-check each line in test).

### M4 — Projection: INDEX into Claude Code rules (~120 LOC + tests)

**Modify:** `src/adapters/claude-code.ts` — add `"rules/soma/MEMORY.md"` to `CLAUDE_CODE_RULES_FILES` (line ~174) AND a builder in `CLAUDE_RULES_CONTENT_BUILDERS` (per the file's own header comment: array AND map). Builder reads rendered index content passed through `ProjectionInput` (extend `ProjectionInput['profile'].memory` with optional `indexContent: string`; populated by the install pipeline from `<somaHome>/memory/INDEX.md` if present, else a one-line placeholder `"No memory index yet — run soma memory index."`). Keep `MEMORY_LAYOUT.md` untouched (deprecation is a later decision, not this plan).
**Modify tests:** `test/claude-code-install.test.ts` — bundle now contains the new file; idempotency (AC-4) test must still pass: same input → byte-identical bundle. That means projection uses the stored INDEX.md content verbatim — it never re-renders with a live clock.

**Done when:** install tests green; probe: run `soma install claude-code --home-dir <tmp>` (see existing install test harness) → `<tmp>/.claude/rules/soma/MEMORY.md` exists with index content.

### M5 — Episodic capture: `soma memory digest | action` (~250 LOC + tests)

**Create:** `src/memory-episodic.ts`, `test/memory-episodic.test.ts`.

```ts
export async function writeSessionDigest(opts: { somaHome?: string; homeDir?: string; substrate: string; now?: Date;
  summary: string; changed?: string[]; openLoops?: string[]; project?: string; sessionId?: string }): Promise<{ path: string }>;
export async function logAction(opts: { somaHome?: string; homeDir?: string; substrate: string; now?: Date;
  intent: string; approval: "principal" | "policy" | "none"; outcome: "done" | "failed" | "pending"; project?: string }): Promise<{ path: string }>;
```

Both write episodic notes per §2.1/§2.2 (`type: episodic`, trust `agent`, provenance `tool:cli`; id auto-generated `YYYYMMDD-<slug-from-summary>`), under `episodic/sessions/YYYY-MM/` and `episodic/actions/YYYY-MM/` respectively (extend `memoryNotePath` with a subkind param, default `sessions`). Digest body template: `**What happened:** … / **Changed:** … / **Open loops:** …`. Events `memory.digest.written` / `memory.action.logged`.

CLI: `soma memory digest --summary <text> [--changed <x>]... [--open <x>]... [--project p]` and `soma memory action --intent <text> --approval <a> --outcome <o>`.

**Hook wiring (minimal, this milestone):** in the Claude Code adapter's SessionEnd hook path (`soma-claude-code-hook.mjs` lifecycle — locate its SessionEnd handler), invoke `soma memory digest` with the session summary it already has access to; if no summary is available, skip silently (do NOT block session end). One integration test at the lifecycle level if the existing hook tests permit; otherwise unit-test the exported handler function.

**Done when:** tests green; probe: run digest CLI in temp home → file exists at correct dated path, `recall` finds it.

### M6 — Consolidation v1, deterministic only: `soma memory consolidate` (~300 LOC + tests)

**Create:** `src/memory-consolidate.ts`, `test/memory-consolidate.test.ts`.

Pipeline (all deterministic; each step returns a report entry, `--dry-run` prints without writing):
1. **Prune episodic:** sessions/actions older than 90/180 days (from `created`, vs injected `now`) → append one line each (`- <date> <id>: <first body line>`) to `episodic/digests/YYYY-MM.md` (create if missing), then move raw note to `archive/episodic/...`. Event per moved batch.
2. **Expire index candidates:** semantic notes with `last_verified` older than 180d AND `resurface_count == 0` → add frontmatter key `review: stale` (parser: optional key, M0 already tolerates via explicit allowlist — add `review` and `hook` to allowed optional keys). Never auto-archive semantic notes.
3. **Contradiction sweep (mechanical only):** group notes sharing any link or ≥3 common id terms; if a group contains ≥2 non-superseded notes of same `type`, list them in the report for human/LLM review. No auto-merge.
4. **State GC:** delete `memory/STATE/current-work-*.json` older than 7 days (this is the one true deletion; guard with filename regex `^current-work-.*\.json$`).
5. **Rebuild index** (M3 function).
6. Event `memory.consolidation.run` with counts in metadata; print report.

LLM-assisted merge/promotion is **explicitly out of scope** (later layer behind the same CLI; leave a `// TODO(memory-v2)` marker).

**Done when:** tests green per step (fixture homes with pre-aged notes — build dates relative to injected `now`); `--dry-run` writes nothing (assert file tree unchanged).

### M7 — Skill + audit (~150 LOC + skill markdown + tests)

**Create:** `src/skills/Memory/SKILL.md` + `Workflows/{Remember,Recall,Consolidate,Audit}.md`, mirroring `src/skills/VSA/` structure and frontmatter exactly (name `Memory`, `effort: low`, `version: 0.1.0`, `pack-id: soma-memory-v0.1.0`). SKILL.md content: condensed contract from design doc §4–§7 — the four types, the five write triggers (design §7), recall-before-write, verify-after-use, banners are law, "telemetry is not memory". Workflows are step lists that call the CLI; no logic in prose that contradicts the CLI's enforcement.
**Create:** `src/memory-audit.ts` + test: `soma memory audit` prints health metrics (design §15): notes per type, % index entries verified <30d, quarantine queue count+oldest age, index budget headroom, archive counts, broken links (link target id with no file — report only).
**Modify:** whatever registers bundled skills for projection (find how VSA registers via `vsa-skill-installer.ts` / `projectableSkills` in `src/adapters/shared/index.ts:22` — note VSA is *excluded* there as managed; Memory should go the plain-portable route via the standard skills registry, i.e. land in `~/.soma/skills/Memory` on install like other bundled skills — copy whatever mechanism `the-algorithm` skill uses in `src/skills/`).

**Done when:** skill projected into a temp install (probe: `<tmp>/.soma/skills/Memory/SKILL.md` exists + appears in rendered `SKILLS.md`); audit CLI output snapshot-tested.

## 4. Milestone order & dependencies

M0 → M1 → M2 → M3 → M4; M5 needs M0–M1; M6 needs M0–M3+M5; M7 needs all. M4 can run parallel to M5. One PR per milestone, conventional commit style used in repo.

## 5. Gotchas (read twice)

- **Idempotent projection is a hard invariant (AC-4).** Anything time-derived in projected content must come from stored file content, not wall clock (M4). If `claude-code-install.test.ts` idempotency fails, you broke this.
- **Array AND map** when adding a projected rules file (`claude-code.ts` header comment) — miss one and the planner/writer drift guard fails.
- **Do not "fix" the 19-dir taxonomy, legacy readers, or the non-recursive `readRecentMarkdown`** (`lifecycle.ts:134`) in these PRs. Known issues, separate work. Scope discipline.
- **`events.jsonl` is append-only** — never rewrite it; consolidation reports derive from filesystem state, not event replay.
- **`memory promote` (existing) stays untouched.** PROMOTED/ dirs are a parallel legacy path; ignore them.
- **All new code takes `now?: Date`** and defaults at the CLI boundary only. Tests never sleep, never depend on real dates.
- **Slug collisions:** `writeMemoryNote` create-mode must fail if file exists (that's what merge/supersede are for).
- **Quarantined notes** never enter INDEX (score 0) and recall prints the quarantine banner — both are tested, not assumed.

## 6. Out of scope (do not build even if tempting)

Migration of any legacy memory · embeddings/vector index · LLM-assisted consolidation · Tana projection · hooks beyond the single SessionEnd digest call · deleting/deprecating MEMORY_LAYOUT.md · touching `~/.claude/*` trees.

## 7. Final acceptance (whole subsystem)

1. Fresh temp home: `write` (semantic + procedural) → `recall` returns both with banners → `verify` bumps → `index` includes both → `install claude-code` projects INDEX → `digest`+`action` land → age fixtures → `consolidate` prunes/reports → `audit` reports sane numbers. Scripted as one integration test: `test/memory-subsystem.test.ts`.
2. `bun test` fully green, `bunx tsc --noEmit` clean, eslint clean.
3. Every mutating CLI call produced exactly one event line (assert count in integration test).
4. Design-doc §15 invariants traceable: recall-first refusal (M1), verify-bumps-usage (M1), index-earned-not-given (M3), digest-per-session (M5), deterministic health metrics (M7).
