---
feature: "Canonical work registry filesystem contract"
spec: "./spec.md"
status: "approved"
---

# Technical Plan: Canonical Work Registry Filesystem Contract

## Architecture Overview

```
src/work-registry.ts
  ├─ readWorkRegistry(paths)
  ├─ upsertWorkRegistryEntry(paths, entry)
  └─ listWorkRegistryEntries(paths)

memory/STATE/work.json
memory/STATE/session-names.json
memory/STATE/current-work-<session-id>.json
memory/WORK/<slug>/
```

## Data Model

```typescript
interface SomaWorkRegistryEntry {
  sessionUUID: string;
  sessionName: string;
  task: string;
  substrate: string;
  phase: string;
  progress: string;
  started: string;
  updatedAt: string;
  artifacts: Record<string, string>;
}
```

## Implementation Strategy

### Phase 1: Test Public Helper

- Add a behavior test for writing and reading canonical work state.

### Phase 2: Implement Helper

- Add `src/work-registry.ts` and export it.

### Phase 3: Reuse in Later Features

- Use the helper from learning harvest and lifecycle writeback.

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Diverges from PAI shape | Medium | Medium | Preserve key names used by PAI where safe |
| Stores too much data | High | Low | Narrow input type to metadata only |

## Dependencies

- `src/soma-home.ts`
- `src/fs-utils.ts`

## Estimated Complexity

- **New files:** 1
- **Modified files:** 2
- **Test files:** 1
