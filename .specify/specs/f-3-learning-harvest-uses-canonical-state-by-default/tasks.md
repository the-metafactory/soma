---
feature: "Learning harvest uses canonical state by default"
plan: "./plan.md"
status: "pending"
total_tasks: 4
completed: 0
---

# Tasks: Learning Harvest Uses Canonical State By Default

## Task Groups

### Group 1: Default Behavior

- [ ] **T-1.1** Add default harvest test [T]
  - File: `test/learning-tools.test.ts`
  - Description: Prove no `--session-dir` uses canonical state, not
    `STATE/sessions`.

- [ ] **T-1.2** Implement work-state harvest [T]
  - File: `src/tools/learning/session-harvester.ts`
  - Description: Branch default mode to registry entries.

### Group 2: Explicit Transcript Mode

- [ ] **T-2.1** Preserve explicit transcript harvest [T]
  - File: `test/learning-tools.test.ts`
  - Description: Existing explicit session-dir behavior stays green.

### Group 3: Docs

- [ ] **T-3.1** Document default and explicit modes
  - File: `docs/learning-contracts.md`
  - Description: Clarify raw transcripts are explicit/policy-gated.
