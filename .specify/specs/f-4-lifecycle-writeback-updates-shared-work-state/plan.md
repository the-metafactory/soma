---
feature: "Lifecycle writeback updates shared work state"
spec: "./spec.md"
status: "approved"
---

# Technical Plan: Lifecycle Writeback Updates Shared Work State

## Architecture Overview

```
adapter lifecycle hook
        |
        v
core lifecycle/writeback module
        |
        v
work registry helper
```

## Implementation Strategy

### Phase 1: Locate Lifecycle Writeback

- Reuse existing lifecycle hook entry points rather than adding a new daemon.

### Phase 2: Test Metadata Writeback

- Add a behavior test that invokes lifecycle writeback and reads canonical
  registry files.

### Phase 3: Wire Helper

- Call the registry helper from the lifecycle writeback path.

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Hook lacks stable session ID | Medium | Medium | Generate a stable fallback when absent |
| Writes host-specific paths | Medium | Low | Use relative artifact paths |

## Dependencies

- F-2 registry helper
- Existing lifecycle hook implementation

## Estimated Complexity

- **Modified files:** 2-4
- **Test files:** 1
