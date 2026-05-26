---
feature: "Document canonical shared work state"
spec: "./spec.md"
status: "approved"
---

# Technical Plan: Document Canonical Shared Work State

## Architecture Overview

Documentation establishes the contract consumed by the later implementation
features.

```
CONTEXT.md glossary
        |
        v
design/design-decisions.md DD-5
        |
        v
docs/learning-contracts.md and docs/substrate-adapters.md
```

## Implementation Strategy

### Phase 1: Glossary

- Define canonical state terms in `CONTEXT.md`.

### Phase 2: Decision Record

- Add a numbered design decision for shared work state.

### Phase 3: User-Facing Docs

- Update learning and substrate adapter docs once implementation confirms exact
  behavior.

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Docs expose private paths | High | Low | Use `SOMA_HOME` placeholders |
| Docs overpromise telemetry | Medium | Medium | Keep full observability out of scope |

## Dependencies

- Existing `CONTEXT.md`
- Existing `design/design-decisions.md`

## Estimated Complexity

- **Modified files:** 4
- **Test files:** 0 directly; behavior verified by later features
