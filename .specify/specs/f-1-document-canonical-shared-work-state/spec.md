---
id: "F-1"
feature: "Document canonical shared work state"
status: "approved"
created: "2026-05-26"
---

# Specification: Document Canonical Shared Work State

## Overview

Soma must document the shared work-state model before code relies on it. The
canonical state follows the PAI-style work registry: `memory/STATE/work.json`,
`memory/STATE/session-names.json`, resolver-backed current-work pointer files,
and durable artifacts under `memory/WORK/<slug>/`.

## User Scenarios

### Scenario 1: Maintainer Understands Canonical State

**As a** Soma maintainer
**I want to** see one documented state model
**So that** adapters do not invent incompatible transcript defaults.

**Acceptance Criteria:**
- [ ] Docs name the work registry and session-name registry as canonical Soma state.
- [ ] Docs state that raw transcript sources are substrate-local unless explicit.

### Scenario 2: Adapter Author Avoids Private Transcript Mirroring

**As an** adapter author
**I want to** know what may be written by default
**So that** private prompts and results are not mirrored accidentally.

**Acceptance Criteria:**
- [ ] Docs say full prompt/result storage is out of default scope.
- [ ] Docs identify policy-gated transcript harvesting as a separate path.

## Functional Requirements

### FR-1: Canonical Registry Terms

Document `work registry`, `session name registry`, `current work pointer`,
`work artifact`, `raw transcript source`, and `observability event`.

**Validation:** Documentation review and tests that exercise the documented
paths.

### FR-2: Scope Boundary

Document that minimal writeback observability belongs in this issue while full
tool telemetry remains separate.

**Validation:** Design decision captures this boundary.

## Non-Functional Requirements

- **Security:** Public docs must use placeholders and generic examples.
- **Failure Behavior:** Ambiguous path references should be clarified rather
  than silently retained.

## Out of Scope

- Full observability telemetry.
- Migration of all imported legacy skill references.
