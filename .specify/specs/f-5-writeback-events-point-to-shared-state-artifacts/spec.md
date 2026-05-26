---
id: "F-5"
feature: "Writeback events point to shared state artifacts"
status: "approved"
created: "2026-05-26"
---

# Specification: Writeback Events Point To Shared State Artifacts

## Overview

Session-end writeback should append a minimal observability event that names the
state files and artifacts updated during writeback.

## User Scenarios

### Scenario 1: Audit Writeback

**As a** maintainer
**I want to** inspect the event stream
**So that** I can see which shared state artifacts were updated.

**Acceptance Criteria:**
- [ ] Event is appended to `memory/STATE/events.jsonl`.
- [ ] Event includes type, timestamp, session ID, substrate, and artifact paths.
- [ ] Event does not contain full prompts or results.

## Functional Requirements

### FR-1: Minimal Event Contract

Define an event type for shared work-state writeback.

**Validation:** Tests read the JSONL event and inspect fields.

### FR-2: Artifact Pointers

The event points to `work.json`, `session-names.json`, current-work pointer, and
WORK artifact directory when present.

**Validation:** Tests confirm paths are included.

## Non-Functional Requirements

- **Security:** Event is metadata-only.
- **Reliability:** Event append should be stable JSONL.

## Out of Scope

- Tool activity events.
- Failure telemetry events.
