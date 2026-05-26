---
feature: "Lifecycle writeback updates shared work state"
plan: "./plan.md"
status: "pending"
total_tasks: 3
completed: 0
---

# Tasks: Lifecycle Writeback Updates Shared Work State

## Task Groups

### Group 1: Lifecycle Behavior

- [ ] **T-1.1** Add lifecycle writeback test [T]
  - File: `test/lifecycle.test.ts`
  - Description: Prove lifecycle writeback updates canonical registry files.

- [ ] **T-1.2** Wire registry helper into lifecycle writeback [T]
  - Files: `src/lifecycle.ts`, adapter hook files as needed
  - Description: Convert lifecycle metadata into registry entries.

### Group 2: Privacy

- [ ] **T-2.1** Assert no full transcript fields are written [T]
  - File: `test/lifecycle.test.ts`
  - Description: Guard against prompt/result mirroring by default.
