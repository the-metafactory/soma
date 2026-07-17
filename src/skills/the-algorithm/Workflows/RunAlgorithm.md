# Run The Algorithm

Use this workflow to execute the portable Algorithm inside any substrate.

## Portable Contract

1. Restate the user's intent in one sentence before planning.
2. Create a harness run with the installed Soma lifecycle tool or the repo-local CLI, using your substrate's prefix from the Harness CLI section below — e.g. `<prefix> algorithm new ...`. Do not assume a global `soma` binary exists.
3. Choose the smallest sufficient effort tier: E1, E2, E3, E4, or E5.
4. Treat the work as a transition from current state to ideal state.
5. Create or update the VSA that belongs to the thing being articulated.
6. Write criteria as atomic yes/no claims with nameable probes.
7. Preserve anti-criteria with `Anti:` criteria when something must not happen.
8. Execute through the seven phases unless an E1 fast path clearly applies.
9. Verify every criterion with evidence before declaring completion.
10. Record decisions, changelog, and verification in the VSA rather than parallel artifacts.

## Seven Phases

1. OBSERVE: restate intent, identify current state, choose VSA home, draft problem/goal/criteria.
2. THINK: refine assumptions, split vague criteria, select thinking capabilities.
3. PLAN: map criteria to implementation steps, capabilities, dependencies, and verification probes.
4. BUILD: create or modify artifacts while updating criteria when reality sharpens the ideal state.
5. EXECUTE: run the concrete steps and keep criteria state current.
6. VERIFY: prove each criterion and anti-criterion with evidence.
7. LEARN: capture decisions, refutations, lessons, and next iteration.

## Harness CLI

The harness is mutable run state, not just a document. Use the repo-local CLI for the active substrate:

- Codex prefix: `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma`
- Pi.dev prefix: `cd $(cat ~/.pi/agent/soma/soma-repo.txt) && bun run soma`

Common commands:

- `algorithm classify --prompt "..."`
- `algorithm new --id <run-id> --prompt "..." --intent "..." --current-state "..." --goal "..." --criterion "C1:..." --effort E2`
- `algorithm list`
- `algorithm show --id <run-id>`
- `algorithm capabilities --id <run-id> --capability <CapabilityName> --reason <why>`
- `algorithm invoke --id <run-id> --capability <CapabilityName> --evidence <what happened>`
- `algorithm remove-capability --id <run-id> --capability <CapabilityName> --reason <why no longer needed>`
- `algorithm plan --id <run-id> --step "P1:C1[,C2]:Do the concrete work."`
- `algorithm decision --id <run-id> --text "Decision made and why."`
- `algorithm change --id <run-id> --text "Artifact changed."`
- `algorithm step --id <run-id> --step-id P1 --status done --evidence "Probe output or file path."`
- `algorithm verify --id <run-id> --criterion-id C1 --status passed --evidence "Verification evidence."`
- `algorithm learn --id <run-id> --text "Reusable lesson."`
- `algorithm batch --id <run-id> --op "decision:Decision made." --op "change:Artifact changed." --op "step:P1:done:Evidence."`
- `algorithm advance --id <run-id>`

Prefer `algorithm batch` when recording routine decision/change/step/verify/learn evidence from a substrate. It avoids long shell `&&` chains and reduces repeated approval prompts.

`algorithm classify` decides MINIMAL, NATIVE, or ALGORITHM and maps Algorithm prompts to E1-E5. `algorithm new` uses the same classifier when `--effort` is omitted; explicit `/eN`, `EN`, or `--effort EN` overrides classification.

`algorithm advance` is the deterministic gate. If required capabilities, capability invocation evidence, plan steps, build changes, verification, or learning are missing, Soma rejects the transition and the substrate must fill the missing state before trying again.

## Effort Tiers

- E1 Standard: quick work; minimal VSA with Goal and Criteria is enough.
- E2 Extended: structured work; include Problem, Goal, Criteria, Test Strategy.
- E3 Advanced: substantial multi-file or multi-step work; include project-grade sections.
- E4 Deep: architecture/doctrine/cross-cutting work; all twelve VSA sections.
- E5 Comprehensive: long-running comprehensive work; all twelve sections plus interview/refinement before build.

## Substrate Adaptation

- Codex: use repository edits, tests, and final verification reports as the execution surface.
- Pi.dev: use the Soma system-prompt context and `soma_context` tool for identity detail; use Pi tools for work.
- Claude Code: defer live home integration until no active Claude Code sub-agents depend on `~/.claude`.
- Cortex/Myelin: later, the VSA becomes bus-visible work state.

## Completion Gate

Before final response, re-read the user's latest request and check every explicit ask against shipped artifacts. Do not claim done if any explicit ask is missing.
