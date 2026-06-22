> **⚠️ DEMOTED TO REFERENCE 2026-06-22 by `2026-06-22-soma-direction-verification-primitive.md`.**
> The migration spike is dropped — Kyle routed around migration entirely
> (agent-to-agent via `claude -p`). Keep only the `.af` block envelope (label =
> typed index, content = free body) as a reference for the memory-manifest shape.

# `.af` ⇆ Soma Compartment Field Map — Integration Spike v0 (REFERENCE ONLY)

**Created:** 2026-06-22
**Authors:** Jens-Christian Fischer + Ivy, scoping Luna's letta-code recommendation
**Companion:** `2026-06-22-soma-seam-thesis.md` (this is the "turn posture into a test" artifact)
**Status:** Spike scope. The field map below either proves the dividing line or breaks it.

---

## Why this doc exists

Luna's call: treat letta-code as the first **hosted content-pack** and the `.af`
round-trip as **v0 of the seam** — not a feature to match. This map collapses two
open thesis items (the boundary contract, the lossy-fields register) into one
concrete integration. If `.af` memory blocks map cleanly onto Soma Memory bodies +
manifest, the dividing line is real and shipping in production *by someone else*.
If they don't, the thesis has a hole.

---

## Verified facts (read from source 2026-06-22, not prior knowledge)

`letta-code` (github.com/letta-ai/letta-code), Apache-2.0:
- **Persistence is git, not a DB.** Uses **MemFS, a git-based VCS**: *"All context
  (including memory blocks) is tracked via git. Sync context to a custom GitHub
  repository by setting `/memory-repository set …`."* Local CLI by default; a
  running `letta server` / Constellation is only for hosted multi-machine access.
  → **Corrects Luna's "DB-stateful, impedance mismatch" assumption.** letta-code
  local is git/filesystem-native — the same shape as Soma. The heavy DB connector
  is only the *hosted server* path, not the default.
- Memory tooling: `/palace` (view memory), `/doctor` (audit memory quality),
  `/sleeptime` (periodic "dreaming" / consolidation). Memory blocks drive
  system-prompt learning + skill learning. By the creators of MemGPT.

`.af` Agent File (github.com/letta-ai/agent-file), Apache-2.0, TS + Python impls:
- **Top-level components:** system prompt; memory blocks (in-context personality /
  user info, labeled, agent-editable); tools (source code + JSON schema); tool
  rules (sequencing/constraints); model config (context-window limit, model name,
  embedding-model name); message history (with context-window indicators);
  environment variables.
- **Excluded:** **Passages (archival memory units) are NOT supported.** Secrets are
  set to `null` on export.
  → **The lossy register is partly pre-defined by Letta itself.**

---

## The field map

| `.af` component | → Soma target | Clean / Lossy | Notes |
|---|---|---|---|
| **memory blocks** (label + content) | **Memory** compartment: label → typed **manifest**, content → free-form **body** | **CLEAN** | This is the whole thesis. Letta ships Luna's named boundary contract in production: block label = typed index field, block content = assistant-authored body. **v0 lives here.** |
| **system prompt** | **Identity** + Algorithm/Telos content-pack (assembled into projection) | PARTIAL | Content round-trips; *structure* doesn't — Soma assembles the system prompt from Identity+Telos+pack, `.af` stores one blob. Ingest → store as a body; emit → Soma re-assembles. Lossy on provenance, clean on text. |
| **tools** (source + schema) | **Skills** compartment (skill tool + manifest) | PARTIAL | Letta tools are inline code+schema; Soma skills are folders. Map 1 tool ⇄ 1 skill-tool. Execution model differs — defer to a later pass, not v0. |
| **tool rules** (sequencing/constraints) | **Policy** (runtime policy config / governance) | PARTIAL | Maps to Soma policy rules, different shape. Not v0. |
| **model config** (ctx window, model, embed model) | substrate metadata (NOT Soma-owned) | **LOSSY / out-of-scope** | `docs/boundaries.md`: Soma does not own model provider. Store as opaque metadata, never author. |
| **message history** | **raw transcript source** / observability events | **LOSSY by design** | Soma does not store full transcripts by default. Drop, or keep a pointer. Never a Soma body. |
| **environment variables** (secrets `null`) | **Policy** (secrets stay substrate-side) | **LOSSY** | Secrets nulled by `.af` already. Nothing to round-trip. |
| **archival passages** | Soma archival Memory | **LOSSY — gap is Letta-side** | `.af` excludes Passages entirely. Document as a known boundary; not Soma's to fix. |

---

## v0 interop scope (bounded, per Luna)

- **One pair:** Soma ⇆ letta-code (local, git/MemFS — not Constellation server).
- **One direction first:** **ingest `.af` → Soma** (memory blocks → bodies+manifest).
  Emit (Soma → `.af`) is the second milestone, once the manifest shape is fixed.
- **One component:** **memory blocks only.** Everything else in the table is
  explicitly out of v0.
- **Lossy-fields register (v0, frozen):** message history (dropped), model config
  (metadata only), archival passages (excluded by `.af`), secrets (nulled), tools +
  tool rules (deferred). This *is* the bounded "lossless" scope the thesis demanded —
  grounded in a real schema, not an adjective.

**Acceptance test (proves/breaks the dividing line):** ingest a real `.af`
exported from letta-code; its memory blocks land as Soma Memory bodies, each with a
typed manifest derived from the block label; the index sees them; re-projecting into
Claude Code surfaces them as presence — **without any adapter code change**. If the
block→body+manifest mapping needs an adapter edit, the kernel/content-pack split
(thesis) has a hole.

---

## Risk register (corrected)

- ~~DB↔git impedance mismatch~~ → **downgraded.** letta-code local is git-native;
  only the hosted server is DB-backed. v0 targets the local path.
- **Schema dependency on a VC-backed company.** `.af` evolves on Letta's clock.
  Acceptable — interop with an adopted format beats a Soma-native format nobody
  uses — but it's a tracked line, not a freebie. Pin a `.af` schema version in v0.
- **`/sleeptime` consolidation mutates blocks out-of-band.** If Soma ingests a
  letta-code git repo that the Letta agent is also editing, define who owns the
  block between sessions. Writeback-gate concern, flag for the emit milestone.

---

## Next artifact

This doc is the field map. The next step is the **ingest spike**: a `soma import
af <file>` that lands memory blocks as bodies+manifest and nothing else. One
direction, one component, the frozen lossy register above. That spike is the
smallest thing that converts the seam thesis from posture into a passing (or
failing) test.
