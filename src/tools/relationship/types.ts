import type { LearningToolOptions } from "../learning";

export type RelationshipNoteKind = "W" | "B" | "O";

export interface RelationshipNote {
  kind: RelationshipNoteKind;
  entity: string;
  observation: string;
  date: string;
  path: string;
}

export interface RelationshipMilestone {
  id: string;
  description: string;
  evidence: string;
  date: string;
}

export interface RelationshipNotification {
  title: string;
  message: string;
}

export interface RelationshipNotifier {
  notify(notification: RelationshipNotification): Promise<void>;
}

export interface RelationshipReflectOptions extends LearningToolOptions {
  opinionsOnly?: boolean;
  milestonesOnly?: boolean;
  dryRun?: boolean;
  recentDays?: number;
  notifier?: RelationshipNotifier;
  milestones?: { id: string; description: string; pattern: RegExp }[];
}

export interface RelationshipReflectResult {
  notes: RelationshipNote[];
  opinionUpdates: { statement: string; oldConfidence: number; newConfidence: number; evidenceCount: number; notified: boolean }[];
  milestones: RelationshipMilestone[];
  storyPath?: string;
  dryRun: boolean;
}
