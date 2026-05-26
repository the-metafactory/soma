---
id: "F-4"
feature: "Lifecycle writeback updates shared work state"
status: "approved"
created: "2026-05-26"
---

# Specification: Lifecycle Writeback Updates Shared Work State

## Overview

Lifecycle writeback should update canonical work state so another substrate can
continue from minimal session metadata.

## User Scenarios

### Scenario 1: Session-End Writeback

**As a** lifecycle hook
**I want to** write session metadata on session end
**So that** shared state reflects completed work.

**Acceptance Criteria:**
- [ ] Work registry contains the session ID, session name, substrate, timestamps,
  phase, progress, and artifact pointers.
- [ ] Session-name registry maps session ID to a human-readable name.
- [ ] Current-work pointer exists for the session.

## Functional Requirements

### FR-1: Minimal Metadata

Lifecycle writeback must not require prompt text or result text.

**Validation:** Tests invoke lifecycle writeback with metadata-only input.

### FR-2: Cross-Substrate Shape

Registry entries use stable keys that are compatible with PAI work registry
expectations.

**Validation:** Tests inspect JSON fields in generated registry files.

## Non-Functional Requirements

- **Security:** No full transcript storage by default.
- **Portability:** No host-specific behavior in the core helper.

## Out of Scope

- Rich lifecycle analytics.
