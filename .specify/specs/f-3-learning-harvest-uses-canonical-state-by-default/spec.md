---
id: "F-3"
feature: "Learning harvest uses canonical state by default"
status: "approved"
created: "2026-05-26"
---

# Specification: Learning Harvest Uses Canonical State By Default

## Overview

`soma learning harvest` must stop silently reading from an unproduced raw
transcript default. Default harvesting should use canonical work state when no
`--session-dir` is provided. Raw transcript harvesting remains available only
when a caller passes `--session-dir`.

## User Scenarios

### Scenario 1: Default Harvest Has No Fake Transcript Path

**As a** CLI user
**I want to** run learning harvest without options
**So that** Soma uses canonical state or reports no work, not an orphan path.

**Acceptance Criteria:**
- [ ] Default harvest does not resolve `memory/STATE/sessions`.
- [ ] Missing work registry yields an empty harvest result.

### Scenario 2: Explicit Raw Transcript Harvest

**As a** user with a policy-approved transcript source
**I want to** pass `--session-dir`
**So that** Soma harvests raw transcript JSONL files only when explicit.

**Acceptance Criteria:**
- [ ] Existing explicit `--session-dir` behavior keeps working.
- [ ] Docs describe this as explicit raw transcript harvest.

## Functional Requirements

### FR-1: Work-State Default

When no session directory is provided, the harvester reads canonical registry
entries and produces harvestable session summaries from metadata and artifacts.

**Validation:** Tests cover default behavior without injecting `sessionDir`.

### FR-2: Explicit Transcript Mode

Raw transcript parsing requires a configured session directory.

**Validation:** Existing transcript tests continue passing with explicit
directories.

## Non-Functional Requirements

- **Security:** No default raw transcript mirroring.
- **Failure Behavior:** Missing work registry is an empty result, not a thrown
  missing-directory error.

## Out of Scope

- Summarizing private transcript contents by default.
