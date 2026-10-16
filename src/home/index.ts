export { type CommunicationContract, DECISION_REFERENCE_LETTER, RESERVED_REFERENCE_LETTERS, ReservedReferenceLetterError, isReservedReferenceLetter, parseReferenceCode, requireReferenceCode } from "./communication-contract";
export { loadSomaHome, loadSomaProfile } from "./soma-home";
export { type ProjectedArtifact, type ProjectionRepairProvider, type SessionEndTranscriptHandler, getProjectionRepairProvider, getSessionEndTranscriptHandler, registerProjectionRepairProvider, registerSessionEndTranscriptHandler } from "./lifecycle-registry";
export { type SomaCurrentWorkPointer, type SomaCurrentWorkPointerLearningSources, type SomaCurrentWorkPointerSignals, type SomaCurrentWorkPointerStatus, type SomaWorkRegistry, type SomaWorkRegistryEntry, type UpsertSomaCurrentWorkPointerOptions, type UpsertSomaWorkRegistryEntryOptions, type UpsertSomaWorkRegistryEntryResult, listSomaWorkRegistryEntries, normalizeSomaWorkRegistryArtifacts, readSomaWorkRegistry, somaWorkRegistryPaths, upsertSomaCurrentWorkPointer, upsertSomaWorkRegistryEntry } from "./work-registry";
export { type GoalResource, loadGoalResources, parseGoalResources, resolveGoalResource } from "./goal-resources";
export { loadSomaConfig } from "./soma-config";
export { createSomaSnapshot, listSomaSnapshots, rollbackSomaSnapshot } from "./snapshots";
export type { AssistantIdentity, PrincipalIdentity, Purpose, SomaMemoryLayout, SomaProfile, ProjectionInput, SomaSnapshotEntry, SomaSnapshotListOptions, SomaSnapshotOptions, SomaSnapshotResult, SomaSnapshotRollbackOptions, SomaSnapshotRollbackResult } from "./types";
