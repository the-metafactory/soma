---
feature: "Writeback events point to shared state artifacts"
plan: "./plan.md"
status: "pending"
total_tasks: 3
completed: 0
---

# Tasks: Writeback Events Point To Shared State Artifacts

## Task Groups

### Group 1: Event Contract

- [ ] **T-1.1** Add event writeback test [T]
  - File: `test/lifecycle.test.ts`
  - Description: Prove session-end writeback appends metadata-only event.

- [ ] **T-1.2** Implement event payload [T]
  - Files: `src/lifecycle.ts`, registry helper as needed
  - Description: Append artifact pointers after shared state write.

### Group 2: Documentation

- [ ] **T-2.1** Document minimal observability boundary
  - Files: `docs/substrate-adapters.md`, `design/design-decisions.md`
  - Description: Clarify full telemetry remains separate.
