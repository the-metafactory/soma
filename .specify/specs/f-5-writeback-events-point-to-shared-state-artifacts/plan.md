---
feature: "Writeback events point to shared state artifacts"
spec: "./spec.md"
status: "approved"
---

# Technical Plan: Writeback Events Point To Shared State Artifacts

## Architecture Overview

```
lifecycle writeback
        |
        +-- registry helper writes state
        |
        +-- event append records artifact pointers
```

## Implementation Strategy

### Phase 1: Failing Event Test

- Extend lifecycle test to assert a metadata-only event is appended.

### Phase 2: Event Append

- Reuse existing event append logic where available.
- Include relative artifact paths from registry write result.

### Phase 3: Docs

- Document this as minimal writeback observability, not full telemetry.

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Event leaks transcript data | High | Low | Narrow event payload to pointers |
| Event path shape changes | Low | Medium | Tests assert stable relative paths |

## Dependencies

- F-4 lifecycle writeback
- Existing `events.jsonl` convention

## Estimated Complexity

- **Modified files:** 2
- **Test files:** 1
