# ISA Reconcile

`reconcileIsa` merges a derived or ephemeral feature ISA back into the master
ISA for the same work. The merge is deterministic and keyed by stable ISC IDs.
It is not a three-way merge and it does not try to infer author intent from
free-form prose.

The source of truth remains the master ISA under
`<soma-home>/isa/<slug>.md`. Feature ISAs are derived views. They may
contribute criterion status, criterion evidence, Decisions, Changelog,
Verification entries, and new non-conflicting sections. They do not replace the
master document wholesale.

## Interface

The file-backed function lives in `src/isa-reconcile.ts`:

```ts
reconcileIsa(slug, feature, options)
```

- `slug` identifies the master ISA in `<soma-home>/isa/<slug>.md`.
- `feature` is either a parsed `IdealStateArtifact` or a path to a feature ISA.
- `options.onConflict` can force a policy for tests or explicit callers.
- without an override, the default policy is read from
  `<soma-home>/isa/config.json`:

```json
{
  "defaultConflictPolicy": "error"
}
```

Valid policies are `error`, `prefer-master`, and `prefer-feature`.

Every file-backed reconcile appends an `isa.reconcile` event to
`memory/STATE/events.jsonl` with a full conflict report.

## Merge Rules

### Sections

Known ISA sections are matched by canonical section name. Header whitespace is
normalized by the parser, so `## Goal`, `##  Goal`, and `## Goal ` all identify
the same section.

Unknown sections are allowed only when they are absent from master. They append
after the canonical sections. If an unknown section exists in both inputs with
different content, it is a conflict.

Section rename detection is intentionally conservative. Soma currently has no
stable section IDs; section identity is the canonical name string. If a feature
references a section absent from master while master has a likely renamed
section with similar content, reconcile records a conflict instead of creating
two competing sections.

### Criteria

Criteria merge by stable ISC ID. The master order is preserved. Feature-only
criteria append to the Criteria section.

Status merge is monotonic by default:

```text
open < failed < passed
open < dropped
```

`passed` and `dropped` are terminal relative to feature regressions. A feature
with `[ ] ISC-3` never reopens a master `[x] ISC-3`. Tombstoned or dropped
criteria are preserved and never resurrected by feature content.

If both sides change the same criterion text or evidence differently, the
selected conflict policy applies.

### Logs

Decisions, Changelog, and Verification are append-only logs. Entries are keyed
by `(timestamp, phase, text)`.

Duplicate entries are de-duplicated. Same timestamp and phase with different
text is a conflict because ordering alone is not enough to prove author intent.
With `prefer-master`, only master entries are kept for that key. With
`prefer-feature`, the feature entry is appended after existing master entries.

### Whitespace

Reconcile uses Soma's existing parser and serializer. If no structural mutation
occurs, byte identity is preserved by the parser cache. When merge changes are
written, output is canonical Markdown with trailing whitespace removed and a
single trailing newline.

## Adversarial Inputs

1. **Section added in feature branch absent from master**
   - Canonical or unknown section absent from master is appended.
   - If the section appears to be a rename of an existing master section,
     reject under `error` and record `section-rename`.

2. **Same ISC ID in two sections of master**
   - Error. Criteria identity must be unique inside the master document.
   - Reconcile refuses to choose the first copy.

3. **User manually edited master between feature branch creation and reconcile**
   - V0 has no three-way merge baseline hash. The current master on disk wins
     unless a concrete field conflict is detected. Conflicts follow policy.

4. **Whitespace normalization**
   - Parse semantically, render canonically after mutation. Do not preserve
     arbitrary feature whitespace.

5. **Header formatting drift**
   - Treat whitespace-only drift as the same section. Semantic section renames
     are conflicts.

6. **ISC status regression**
   - Do not regress. Terminal master statuses stay terminal unless
     `prefer-feature` is explicitly forced and the master is not tombstoned.

7. **Conflicting Decisions entries with same timestamp**
   - `error`: conflict.
   - `prefer-master`: keep master entry.
   - `prefer-feature`: append feature entry after master entries.

8. **Tombstoned ISCs**
   - Dropped criteria are tombstones. Reconcile preserves them and does not
     resurrect them from feature content.

9. **Feature references a section renamed in master**
   - Because sections have no stable IDs, V0 detects likely rename drift and
     conflicts rather than duplicating both names.

## Acceptance Invariants

- `reconcile(master, master) === master`
- `reconcile(reconcile(master, feature), feature) === reconcile(master, feature)`
- non-conflicting feature ISC IDs appear in the output
- master content untouched by the feature stays present
- conflict reports are written to the append-only memory event log

## Sign-Off

This design requires review by someone other than the Layer 3 CRUD author
before release. The PR review is the sign-off surface for this issue.
