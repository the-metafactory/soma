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
- Verify changes with `bun run test` and `bun run typecheck` (`bun run test` passes `--timeout=60000`; bun's default 5 s per test is too short for the install tests on a loaded host).

## Enforced rules

Each rule pairs with the check that enforces it and the commit it was proven
on: the check fails on that commit's mistake and passes on the fix. When a
rule here is broken and nothing failed, fix the check, not only the code.

| Rule | Enforced by | Proven on |
| --- | --- | --- |
| A list of three or more string literals has one owner; other copies derive from it (`(typeof XS)[number]`). Add a substrate to `SHIPPED_SUBSTRATES` in `src/types.ts`, not per command. | `bun run check:literal-sets` (`scripts/check-literal-sets.ts`, shrink-only `scripts/literal-sets/baseline.json`), CI step "Literal sets". It catches a new list with the same members as another, or one member added or dropped; a copy that drifted further is a review call. | be80040 (#856, `GoalStatus` copied from `GOAL_STATUSES`) |
| A `catch` in `src/` reads its error. No `catch {}`, no unread binding, no `.catch(() => fallback)`. Reading it is the floor: handle the case you expect (`isEnoent(error)`) and rethrow the rest, or rethrow with `{ cause }`; logging and then returning a fallback still fails open, and that is a review call. | ESLint `soma/no-discarded-error` (`eslint.config.js`), grandfathered in `eslint-suppressions.json`; `bun run check:suppressions` fails when any file's suppressed count grows against the Git base | c2d2f92 (#723, unreadable ledger read as empty) |
| A runtime-policy prompt-rule change is judged on real text, not on the one case in front of it. A witnessed false positive lands in the corpus as a `"denied": true` row before its fix, and the fix flips it. | `test/runtime-policy-corpus.test.ts` over `test/fixtures/runtime-policy/corpus.jsonl` (372 passages from this repo's reviews, commits and docs) | 1240631^ (before #472: 32 passages denied that the current rules clear) |
| Use the glossary's words: CONTEXT.md "Not synonyms" lines name the banned alias for each term (`substrate`, not `host` or `harness`; `principal`, not `user`; no bare `agent`). | Docs only. Sage's ContextDrift lens flags it in review. A word lint fired mostly on correct text (`host` as a forge host or the machine, `harness-eval`, DeepSeek Harness), so none ships. | none (#577, #639, #763, #881, #925 flagged in review) |

## Substrate Adapters

Shipped adapters, each projecting the same Soma core into substrate-native
primitives (see `docs/substrate-adapters.md`):

- **codex** — `~/.codex/` rules + lifecycle hook
- **claude-code** — `CLAUDE.md`, `~/.claude/` rules, hooks, skills
- **cursor** — `.cursorrules` + `.cursor/rules/soma/`
- **pi-dev** — `~/.pi/agent/` core extension + skills
- **grok** — `~/.grok/` auto-loaded skills + `AGENTS.md` pointer, native
  subagent surfaces, and fail-closed `PreToolUse` hooks (Windows-verified)
- **dsh** — `~/.dsh/` auto-discovered skills + `AGENTS.md` pointer (DeepSeek
  Harness; loader-mode registry symlinks)

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

