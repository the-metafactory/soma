---
id: "F-2"
feature: "Canonical work registry filesystem contract"
status: "approved"
created: "2026-05-26"
---

# Specification: Canonical Work Registry Filesystem Contract

## Overview

Soma needs deterministic helpers for canonical shared work state so adapters and
tools update the same files with the same minimal schema.

## User Scenarios

### Scenario 1: Adapter Writes Shared State

**As an** adapter
**I want to** upsert a session into the work registry
**So that** another substrate can continue from shared metadata.

**Acceptance Criteria:**
- [ ] Upsert creates `memory/STATE/work.json`.
- [ ] Upsert creates `memory/STATE/session-names.json`.
- [ ] Upsert creates `memory/STATE/current-work-<session-id>.json`.
- [ ] No full prompt or result text is required or written.

### Scenario 2: Tool Reads Shared State

**As a** Soma tool
**I want to** read registry entries
**So that** default behavior can use canonical state.

**Acceptance Criteria:**
- [ ] Missing registry files read as empty state.
- [ ] Malformed registry JSON fails with an actionable error.

## Functional Requirements

### FR-1: Registry Schema

Define a minimal `SomaWorkRegistryEntry` with session ID, substrate, task/name,
phase, progress, started timestamp, updated timestamp, and artifact pointers.

**Validation:** Unit tests call the public helper and inspect returned state.

### FR-2: Atomic Filesystem Writes

Use existing filesystem helpers and stable JSON formatting.

**Validation:** Tests confirm all expected files exist after writeback.

## Non-Functional Requirements

- **Security:** Store metadata and artifact pointers only by default.
- **Deterministic:** Same input produces stable state paths and JSON shape.

## Out of Scope

- Registry migrations for historical PAI files.
- Rich tool telemetry.
