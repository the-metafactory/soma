import type { SomaPathsOptions } from "../../paths";

export type WisdomObservationType = "principle" | "contextual-rule" | "prediction" | "anti-pattern" | "evolution";
export type FrameHealthStatus = "growing" | "stable" | "stale";

export interface WisdomToolOptions extends SomaPathsOptions {
  now?: Date;
  similarityThreshold?: number;
}

export interface WisdomFrameSummary {
  domain: string;
  path: string;
  observationCount: number;
  lastUpdated?: string;
}

export interface DomainClassification {
  domain: string;
  path: string;
  relevance: number;
  matches: string[];
}

export interface WisdomFrame {
  domain: string;
  path: string;
  content: string;
  observationCount: number;
  lastUpdated?: string;
  principles: string[];
}

export interface FrameUpdateInput extends WisdomToolOptions {
  domain: string;
  type: WisdomObservationType;
  observation: string;
}

export interface FrameUpdateResult {
  domain: string;
  path: string;
  created: boolean;
  observationCount: number;
}

export interface CrossFramePrinciple {
  domains: string[];
  principle: string;
  similarity: number;
}

export interface FrameHealth {
  domain: string;
  status: FrameHealthStatus;
  observationCount: number;
  lastUpdated?: string;
}

export interface WisdomSynthesisResult {
  principles: CrossFramePrinciple[];
  health: FrameHealth[];
  principlesPath?: string;
  healthPath?: string;
}
