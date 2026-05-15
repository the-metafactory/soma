# PAI Pack Normalization Research

Issue: [#18 Normalize PAI packs during import](https://github.com/the-metafactory/soma/issues/18)

## Summary

PAI pack normalization should happen during import, but only for deterministic,
auditable transformations. The importer should not silently rewrite skill
meaning. It should normalize structure and known substrate bindings, preserve
source provenance, and surface anything ambiguous as a warning or TODO.

This document records the concrete issues found while evaluating candidate PAI
pack imports for Soma.

## Evidence Gathered

The findings below came from dry-run imports of representative PAI packs:

- `CreateSkill`
- `Thinking`
- `Research`
- `Prompting`

Additional inspection focused on `CreateSkill` references to notification hooks,
Claude home paths, customization overlays, execution logging, public/private
skill naming, and dynamic loading.

## Issues That Need Care

### 1. Mandatory Runtime Hooks Must Not Become Portable Behavior

`CreateSkill` contains mandatory voice notification sections in `SKILL.md` and
every workflow. These instruct the assistant to call a localhost notification
endpoint before doing work.

Normalization rule:

- Remove or neutralize mandatory runtime hook instructions from portable Soma
  skill bodies.
- Preserve the original text in source provenance.
- Record a normalization action such as `removed-substrate-notification-hook`.

Care point: a normalizer can safely remove the obligation to execute the hook,
but should not delete the fact that PAI originally had notification behavior.
That belongs in provenance or an import report.

### 2. Claude-Home Paths Are Widespread And Have Different Meanings

`CreateSkill` references Claude-home paths for skill payloads, source
documentation, user customization overlays, memory/writeback, and history or
backup locations.

Normalization rule:

- Deterministically rewrite only paths with a clear Soma equivalent.
- Otherwise leave a warning/TODO rather than inventing a mapping.

Care point: these paths are not all equivalent. A single string replacement from
the Claude home to the Soma home would be wrong.

### 3. Public/Private Naming Rules Conflict With Soma Skill Naming

PAI `CreateSkill` teaches public skill names as `TitleCase` and private skills
as underscore-prefixed all-caps names. Soma currently normalizes imported skill
names to lowercase kebab-case, for example `CreateSkill` becomes `create-skill`.

Normalization rule:

- Preserve PAI naming doctrine as source-history guidance, not as Soma runtime
  naming law.
- Generate Soma runtime metadata using Soma's normalized skill name.
- If a skill teaches naming rules, add a warning that the rules may need a
  Soma-specific adaptation.

Care point: this is semantic doctrine, not just syntax. A deterministic import
can normalize the imported file name and frontmatter, but it should not silently
rewrite the whole skill-development methodology.

### 4. User Customization Overlays Need A Soma Equivalent

`CreateSkill` routes personal overrides through a PAI user customization
directory. Soma has portable skill directories and workspace overlays, but the
PAI customization path is Claude-specific.

Normalization rule:

- Mark customization overlay references as requiring a Soma overlay decision.
- Do not drop the customization concept; it is important for separating generic
  public skill behavior from user-specific private context.

Care point: this is a real portability requirement. It likely belongs in the
skill registry or overlay model rather than in a per-substrate adapter.

### 5. Release-Safety Checks Contain Substrate-Local Assumptions

`CreateSkill` includes release-readiness checks that scan a Claude skill
directory for personal or sensitive content. The underlying principle is
valuable, but the paths and exact checks are Claude/PAI-specific.

Normalization rule:

- Preserve the security principle.
- Rewrite only path targets that have a deterministic Soma equivalent.
- Emit warnings for hard-coded policy patterns that need Soma policy integration.

Care point: these checks overlap with Soma's private-source guard and policy
model. The import normalizer should not duplicate or bypass policy enforcement.

### 6. Workflow Instructions Create Or Mutate Claude Directories

Several `CreateSkill` workflows instruct creation, backup, listing, or execution
inside Claude-specific skill and history directories.

Normalization rule:

- In portable skill content, convert direct Claude mutation commands into
  examples or TODO warnings unless a safe Soma command exists.
- Do not preserve executable instructions that would mutate Claude state when
  invoked from another substrate.

Care point: commands embedded in imported skill bodies can become behavioral
instructions. A normalizer must treat shell snippets that mutate substrate homes
as higher-risk than passive prose references.

### 7. Execution Logging Targets Claude Memory

`CreateSkill` includes an execution log append to a Claude-local PAI memory
path.

Normalization rule:

- Replace with a Soma writeback concept only if the write path and schema are
  explicit.
- Otherwise emit a warning that execution logging needs a Soma memory event
  mapping.

Care point: Soma already has append-only memory event writeback. The normalizer
should route toward that contract instead of preserving a Claude-local JSONL
path.

### 8. Source Docs Are Useful But Not Runtime Instructions

The PAI pack importer already stores original `README.md`, `INSTALL.md`, and
`VERIFY.md` under `references/PAI-PACK-*.md`. Those docs often describe
Claude-oriented installation behavior.

Normalization rule:

- Keep source docs as references.
- Do not project source install instructions as Soma runtime behavior.
- Clearly classify them as source history or migration context.

Care point: references are valuable for audit, but they should not be loaded by
default as live instructions.

### 9. Multi-Skill Packs Are Currently Misclassified

The `Thinking` pack dry-run is refused because nested skill directories and
workflows under mode-specific subdirectories are classified as
`substrate-specific`. This affects nested thinking modes such as creative
thinking, council debate, first-principles reasoning, red-team analysis, and
scientific investigation.

Normalization rule:

- Detect multi-skill or bundle-shaped packs explicitly.
- Either split them into multiple Soma skills or import them as a bundle with
  nested routing metadata.
- Do not treat all nested skill material as substrate-specific by default.

Care point: this is a routing/classification problem, not a content cleanup
problem. Import-time normalization may need a preflight pack-shape detector.

### 10. Support Files Outside Current Allowlists May Be Portable

The `Research` pack dry-run is refused because support files such as quick
references, URL verification guidance, migration notes, and templates are
outside the V0 portable/template/doc allowlist.

Normalization rule:

- Extend routing to distinguish portable references from true
  substrate-specific files.
- Preserve reference files with descriptions in generated `soma-skill.json`.

Care point: refusal is safe, but too coarse. Some files currently blocked as
substrate-specific are important portable runtime references.

### 11. Symlink Handling Needs An Explicit Import Policy

The `Prompting` pack dry-run is refused because it contains a symlink under a
template tool path.

Normalization rule:

- Continue refusing symlinks by default.
- If symlink support is added later, it must resolve within the pack root and
  preserve the link target in provenance.

Care point: symlinks can escape the pack root or hide unexpected source
material. The current refusal is correct for V0.

### 12. Generated Routing Metadata Is Missing

The progressive skill loading design says importers should create
`soma-skill.json` during import. Current PAI pack imports generate
`soma-pack.json` provenance, but not runtime routing metadata.

Normalization rule:

- Generate `soma-skill.json` as part of import-time normalization.
- Include triggers, anti-triggers, tags, substrate support, estimated tokens,
  default load behavior, entrypoint, references, and tools when determinable.

Care point: `soma-pack.json` and `soma-skill.json` have different jobs.
`soma-pack.json` records import provenance; `soma-skill.json` powers runtime
skill routing.

## Recommended Normalization Boundaries

Safe deterministic transformations:

- frontmatter rewrite
- skill name normalization
- generated `soma-skill.json`
- removal or neutralization of mandatory substrate runtime hooks
- source path classification
- provenance and warning generation
- deterministic path placeholder rewrites
- token estimate generation

Unsafe without review:

- rewriting skill doctrine
- changing workflow intent
- inventing Soma equivalents for ambiguous Claude paths
- translating personal/private context conventions
- executing installers or embedded commands
- resolving symlinks without an explicit policy

## Import Report Proposal

Each import should produce reviewable normalization metadata. This could live in
`soma-pack.json` or a sibling report.

Suggested fields:

```json
{
  "normalization": {
    "mode": "deterministic",
    "actions": [
      {
        "file": "SKILL.md",
        "kind": "removed-substrate-notification-hook",
        "detail": "Removed mandatory localhost notification instruction"
      }
    ],
    "warnings": [
      {
        "file": "Workflows/CreateSkill.md",
        "kind": "ambiguous-substrate-path",
        "detail": "Claude documentation path has no deterministic Soma mapping"
      }
    ]
  }
}
```

## Test Fixtures To Add

- `CreateSkill`-style mandatory notification block in `SKILL.md`.
- Workflow file with substrate-home mutation commands.
- User customization path reference.
- Execution logging path reference.
- Multi-skill nested pack fixture.
- Portable reference file outside current allowlist.
- Symlink fixture confirming refusal remains default.
- `soma-skill.json` generation fixture.

## Conclusion

Import-time normalization is the right extension point, but only if it is
deterministic, provenance-preserving, and warning-oriented. The normalizer should
make imported skills safe to project as Soma skills without pretending that
Claude-specific doctrine has been fully redesigned.
