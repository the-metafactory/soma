# Soma Agent Instructions

Soma is the substrate-portable Personal AI Assistant core. It extracts the
assistant body from any one host: identity, telos, ISA, skills, memory, policy,
learning, and adapter contracts.

## How To Work In This Repo

- Treat `ISA.md` as the current source of truth for scope, criteria, decisions,
  and verification.
- Read `README.md`, `docs/architecture.md`, and
  `docs/substrate-adapters.md` before changing architecture.
- Keep substrate-specific behavior behind adapter boundaries.
- Keep the core filesystem-native and model-provider-neutral.
- Prefer deterministic TypeScript contracts over prompt-only conventions.
- Use Bun for scripts and tests.
- Verify changes with `bun test` and `bun run typecheck`.

## Substrate Adapters

Shipped adapters, each projecting the same Soma core into substrate-native
primitives (see `docs/substrate-adapters.md`):

- **codex** — `~/.codex/` rules + lifecycle hook
- **claude-code** — `CLAUDE.md`, `~/.claude/` rules, hooks, skills
- **cursor** — `.cursorrules` + `.cursor/rules/soma/`
- **pi-dev** — `~/.pi/agent/` core extension + skills
- **grok** — `~/.grok/` auto-loaded skills + `AGENTS.md` pointer, native
  subagent surfaces, and fail-closed `PreToolUse` hooks (Windows-verified)

## Codex Bootstrap

Codex currently consumes Soma through this repo-level `AGENTS.md`. That makes
the repository inhabitable by Codex before a dedicated plugin or daemon exists.

The first Codex implementation target is:

```text
src/adapters/codex.ts
```

That adapter should implement the `SomaAdapter` interface from `src/types.ts`
and produce a `Projection` that Codex can use as a local instruction
package.

## Design Boundaries

Soma does not replace:

- Cortex as the collaboration surface
- Myelin as the bus/protocol stack
- Arc as the package manager
- Signal as observability
- Spawn as isolated execution
- Compass as governance

Soma supplies the portable personal assistant core those systems can host,
install, observe, execute, or govern.

## Public/Private Boundary

Do not add private principal data, credentials, customer data, or local secrets
to public templates. Use placeholders and generic examples.

## Agent skills

### Issue tracker

Issues live in the-metafactory/soma GitHub Issues, accessed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) used as-is. See `docs/agents/triage-labels.md`.

### Design Decisions

Single-context repo. Design Decisions follow the **metafactory DD format** (numbered DD-N) at `design/design-decisions.md`. `ISA.md` is the live source of truth; DDs are the durable rule-record. See `docs/agents/domain.md`.

## Next Step

When asked to continue the Codex bootstrap, implement the smallest useful Codex
adapter:

1. Add `src/adapters/codex.ts`.
2. Export it from `src/index.ts`.
3. Add tests proving it builds a projection from a minimal `SomaProfile`.
4. Document the adapter behavior in `docs/substrate-adapters.md`.

