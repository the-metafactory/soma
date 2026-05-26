---
feature: "Learning harvest uses canonical state by default"
spec: "./spec.md"
status: "approved"
---

# Technical Plan: Learning Harvest Uses Canonical State By Default

## Architecture Overview

```
soma learning harvest
      |
      +-- --session-dir present --> transcript JSONL mode
      |
      +-- no --session-dir ------> work registry mode
```

## Implementation Strategy

### Phase 1: Failing Default Test

- Add a test that runs harvest without `sessionDir` and expects work-registry
  behavior rather than `STATE/sessions`.

### Phase 2: Harvester Branch

- Change `harvestSessions` to branch on explicit `sessionDir`.
- Add `harvestWorkRegistrySessions` using the registry helper.

### Phase 3: CLI/Docs

- Update CLI help or docs to describe explicit transcript mode.

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Breaks explicit transcript harvest | High | Low | Keep existing explicit session-dir tests |
| Work registry lacks enough data | Medium | Medium | Emit metadata-only learning candidates |

## Dependencies

- F-2 registry helper
- `src/tools/learning/session-harvester.ts`

## Estimated Complexity

- **Modified files:** 3
- **Test files:** 1
