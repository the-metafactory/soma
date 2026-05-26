---
feature: "Canonical work registry filesystem contract"
plan: "./plan.md"
status: "pending"
total_tasks: 4
completed: 0
---

# Tasks: Canonical Work Registry Filesystem Contract

## Task Groups

### Group 1: Registry Helper

- [ ] **T-1.1** Add registry write/read test [T]
  - File: `test/work-registry.test.ts`
  - Description: Prove canonical state files are created and no transcript text
    is required.

- [ ] **T-1.2** Implement registry helper [T]
  - File: `src/work-registry.ts`
  - Description: Add minimal types plus read/upsert/list helpers.

### Group 2: Exports

- [ ] **T-2.1** Export registry API [T]
  - File: `src/index.ts`
  - Test: `test/work-registry.test.ts`
  - Description: Make helpers available to adapters and tools.

### Group 3: Documentation

- [ ] **T-3.1** Link docs to concrete helper behavior
  - Files: `docs/substrate-adapters.md`
  - Description: Document the state files produced by the helper.
