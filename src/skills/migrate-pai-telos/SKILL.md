---
name: migrate-pai-telos
description: "Finish a PAI→Soma migration by placing the TELOS life-OS correctly: keep Purpose as a lean 4-field distillation, promote the rich TELOS categories (beliefs, models, frames, challenges, lessons) into Soma memory as recall-able notes, and protect the curated purpose.md from being clobbered. USE WHEN migrating from PAI, after `soma migrate pai`, porting TELOS, or a fresh Soma install that has PAI TELOS files under profile/imports."
metadata:
  short-description: Port PAI TELOS into Soma memory + Purpose the right way
---

# Migrate PAI TELOS into Soma

`soma migrate pai` moves identity + memory + a mechanical `purpose.md`. It does **not** decide where the rest of the TELOS life-OS belongs, and its identity phase **overwrites `purpose.md`** with a raw concatenation each run. This skill finishes the job: it keeps Purpose lean and curated, and routes the rich TELOS breadth into Soma memory where recall can surface it — without bloating the Purpose that ships in every prompt.

## Core principle

Soma's **Purpose** is four *portable* fields — `Mission / Goals / Principles / Commitments` — the durable "why" projected into every session. The PAI **TELOS** is a ~19-category life-OS. They are not the same size and must not be conflated:

- **Purpose-grade** content → *distilled* into the four Purpose fields (a few lines each).
- **Context-grade** content (mental models, frames, challenges, lessons, narratives) → **Soma memory notes**, surfaced on demand by recall.
- **Time-bound** content (status, projects) → work-state / algorithm-runs, never Purpose.

Never dump whole TELOS files into `purpose.md`. The full snapshots already live under `profile/imports/claude/TELOS/`; memory notes carry a **distillation** plus a `--source-of-truth` pointer back to the snapshot.

## Disposition table

| TELOS file | Goes to | As |
|---|---|---|
| `MISSION.md` (M#) | Purpose → **Mission** (1–2 sentences) + **Goals** (the durable M0–Mn) | curated `purpose.md` |
| `BELIEFS.md` (B#) | Purpose → **Principles** (the load-bearing few) **and** a memory note (full B-set) | both |
| `STRATEGIES.md` (S#) + Master-Narrativ filter | Purpose → **Commitments** (the decision filters) | curated `purpose.md` |
| `MODELS.md` (MO#) | memory note | `semantic` |
| `FRAMES.md` (FR#) | memory note | `semantic` |
| `CHALLENGES.md` (C#) | memory note | `semantic` |
| `LEARNED.md` | memory note | `semantic` |
| `NARRATIVES.md`, `WISDOM.md`, `PROBLEMS.md`, `IDEAS.md`, `TRAUMAS.md`, `WRONG.md`, `PREDICTIONS.md`, `BOOKS.md`, `MOVIES.md` | memory note **iff non-empty** (see step 2) | `semantic` / `reference` |
| `STATUS.md`, `PROJECTS.md` | work-state, not Purpose or durable memory | leave in archive |
| `GOALS.md` (G#) | only durable goals → Purpose.Goals; project/time-bound rows → work-state | curated `purpose.md` |

## Procedure

### Step 0 — Preconditions
The migration must have run so the snapshots exist:
```
ls "$SOMA_HOME/profile/imports/claude/TELOS/"      # expect MISSION.md, BELIEFS.md, …
```
If absent, run `soma migrate pai --apply` first (`SOMA_HOME` defaults to `~/.soma`).

### Step 1 — Guard `purpose.md` (do this FIRST; it is the trap)
`soma migrate pai`'s identity phase **regenerates and overwrites `profile/purpose.md`** on every run with a mechanical dump: the `Mission:` line becomes the PAI *template placeholder* ("Deine Kernmissionen …"), and Goals/Principles/Commitments become raw `GOALS/BELIEFS/STRATEGIES` concatenations with `---`, tables, and ascii diagrams. `soma-home.ts` reads Mission + section bullets straight from this file, so a clobbered `purpose.md` propagates garbage into every substrate on the next `reproject`.

- Detect the clobber: `grep -q "Deine Kernmission\|^- ---" "$SOMA_HOME/profile/purpose.md"` → if it matches, it is the raw dump, not a curation.
- Recover: if a good projection still exists at `~/.claude/rules/soma/PURPOSE.md` (or any substrate's `PURPOSE.md`), reconstruct `purpose.md` from it in the parser's format — `Mission: <one line>` then `## Goals` / `## Principles` / `## Commitments` with `- ` bullets. Otherwise curate a fresh 4-field distillation from `MISSION.md` + `BELIEFS.md` + `STRATEGIES.md` with the principal.
- Verify the parse: `soma precompact capture --session-id x` (or any startup-context read) must show the real mission, not the placeholder.
- **File/flag the upstream fix:** `purpose.md` should be a *reserved* target the identity importer won't overwrite once it exists (the `--overwrite-reserved` flag implies reserved-handling exists but does not currently protect it). Until fixed, re-running `soma migrate pai` re-clobbers curation — always re-run Step 1 after any migrate.

### Step 2 — Skip empty template files
Many TELOS files ship as unfilled templates (e.g. `WISDOM.md`, `NARRATIVES.md` often contain only `[Aphorism 1]`, `[Your one-line description]`, `[Quote]`). Promote a category **only if it has real content**:
```
grep -qE '\[[A-Za-z][^]]*\]|\bYour\b|\[Quote\]|\[Aphorism' FILE   # matches → likely a template; inspect before promoting
```
Read the file; if the substantive sections are placeholders, skip it. Do not create empty notes.

### Step 3 — Write one memory note per promotable category
For each non-empty context-grade file, **distill** it (don't paste the whole file) and write a note. Keep the principal's own voice/language in the body; write the `--recall-trigger` and `description`-facing text in the language the assistant reasons in (usually English) so lexical recall matches how topics arise.

```
soma memory write \
  --trigger <see Step 4> \
  --id <principal-<category>> --type semantic \
  --source-of-truth "profile/imports/claude/TELOS/<FILE>.md" \
  --recall-trigger "<one line: what this is + WHEN to surface it>" \
  --links "<sibling ids, comma-separated>" \
  --body "<a distilled few-line summary, one bullet per numbered item>"
```
Suggested ids: `principal-core-beliefs`, `principal-mental-models`, `principal-decision-frames`, `principal-challenges`, `principal-lessons-learned`. Cross-link siblings with `--links` so `[[id]]` graph edges form.

### Step 4 — Trust (governance): pick the trigger deliberately
Trust is DERIVED from `--trigger`; there is no `--trust` flag. Governance **refuses** `--provenance import` under principal trust — imported content cannot silently ride in as principal.

- **Principal-in-the-loop (recommended for install/onboarding):** show each distilled note to the principal; on their confirmation, write with `--trigger principal-correction --principal-authority` (default provenance `conversation`). This mints **principal** trust, so the note's pointer is admitted to `INDEX.md` immediately and surfaces in every session. The PAI origin stays honest via `--source-of-truth`.
- **Unattended/automated:** write with `--trigger import`. This mints **imported** trust: the note is searchable now (`soma memory search`) and climbs into the INDEX after being resurfaced-and-verified ≥2× — the designed lifecycle. Do NOT fake conversation-provenance to force principal trust on bulk imports.

### Step 5 — Reindex and verify
```
soma memory reindex
grep "principal-" "$SOMA_HOME/memory/INDEX.md"     # principal-trust notes should be listed
soma memory search --query "conditional yes"        # on-demand recall should return the relevant note
```
If notes were written at principal trust, run a `reproject` so the projected `rules/soma/MEMORY.md` bundle (loaded into each session) picks up the new pointers.

## How recall surfaces these (set expectations honestly)
- **INDEX pointers** (always-on): principal-trust notes appear in the projected memory bundle every session — the assistant always *sees they exist* and pulls the full note when relevant. Imported-trust notes appear only after ≥2 resurfaces.
- **On-demand search**: `soma memory search`/`recall` finds any note by lexical match at any trust — so `--recall-trigger`/description vocabulary matters.
- There is **no** per-prompt auto-recall hook today (evented recall is roadmap). So it is "pointers present + full text on recognition/search", not "the exact paragraph auto-appears."

## Gotchas
- **`migrate pai` re-clobbers `purpose.md`** every run → always re-do Step 1 after migrating (until the reserved-target fix lands).
- **Empty templates** masquerade as content → Step 2 grep before promoting.
- **Don't dump** TELOS into `purpose.md` → it ships in every prompt; keep it to the four distilled fields.
- **Reading `~/.soma` (private) while `cd`'d inside a public tree** (e.g. `~/.claude/PAI`) trips the fail-closed policy guard as private→public egress → run from a neutral cwd with absolute paths.
