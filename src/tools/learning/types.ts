import type { InferenceBackend } from "../inference";

export interface LearningToolOptions {
  homeDir?: string;
  somaHome?: string;
  now?: Date;
}

export interface Rating {
  timestamp: string;
  rating: number;
  session_id?: string;
  source?: string;
  sentiment_summary: string;
  confidence?: number;
  comment?: string;
}

export interface PatternGroup {
  pattern: string;
  count: number;
  avgRating: number;
  avgConfidence: number;
  examples: string[];
}

export interface SynthesisResult {
  period: "Weekly" | "Monthly" | "All Time";
  totalRatings: number;
  avgRating: number;
  frustrations: PatternGroup[];
  successes: PatternGroup[];
  topIssues: string[];
  recommendations: string[];
  report?: string;
  path?: string;
}

export type OpinionCategory = "communication" | "technical" | "relationship" | "work_style";
export type EvidenceType = "supporting" | "counter" | "confirmation" | "contradiction";

export interface OpinionEvidence {
  date: string;
  type: EvidenceType;
  description: string;
  sessionId?: string;
}

export interface Opinion {
  statement: string;
  confidence: number;
  category: OpinionCategory;
  evidence: OpinionEvidence[];
  created: string;
  lastUpdated: string;
}

export interface OpinionEvidenceResult {
  opinion: Opinion;
  oldConfidence: number;
  confidenceChange: number;
  needsNotification: boolean;
}

export interface FailureCaptureInput extends LearningToolOptions {
  transcriptPath: string;
  rating: number;
  sentimentSummary: string;
  detailedContext?: string;
  sessionId?: string;
  backend?: InferenceBackend;
  allowRemoteInference?: boolean;
}

export interface ToolCall {
  name: string;
  input: unknown;
  output?: string;
  timestamp?: string;
}

export interface FailureCaptureResult {
  path: string | null;
  description?: string;
  skipped?: boolean;
  toolCalls?: ToolCall[];
}

export interface HarvestedLearning {
  sessionId: string;
  timestamp: string;
  category: "SYSTEM" | "ALGORITHM";
  type: "correction" | "error" | "insight";
  context: string;
  content: string;
  source: string;
  path?: string;
}

export interface HarvestOptions extends LearningToolOptions {
  recent?: number;
  all?: boolean;
  sessionId?: string;
  dryRun?: boolean;
  sessionDir?: string;
}

export interface SomaCounts {
  skills: number;
  workflows: number;
  signals: number;
  files: number;
  work: number;
  research: number;
  ratings: number;
}

export interface SessionProgressRecord {
  project: string;
  created: string;
  updated: string;
  status: "active" | "completed" | "blocked";
  objectives: string[];
  decisions: Array<{ text: string; timestamp: string }>;
  work_completed: Array<{ text: string; timestamp: string }>;
  blockers: Array<{ text: string; timestamp: string }>;
  handoff_notes: string[];
  next_steps: string[];
}
