export type SubstrateId = "codex" | "pi-dev" | "claude-code" | "cortex" | "custom";

export interface AssistantIdentity {
  name: string;
  displayName?: string;
  voiceId?: string;
  traits?: Record<string, number | string | boolean>;
}

export interface PrincipalIdentity {
  name: string;
  preferredName?: string;
  profile?: Record<string, unknown>;
}

export interface Telos {
  mission?: string;
  goals: string[];
  principles: string[];
  commitments: string[];
}

export interface IdealStateCriterion {
  id: string;
  text: string;
  status: "open" | "passed" | "failed" | "dropped";
  verification?: string;
}

export interface IdealStateArtifact {
  slug: string;
  phase: "observe" | "think" | "plan" | "build" | "execute" | "verify" | "learn" | "complete";
  goal: string;
  criteria: IdealStateCriterion[];
}

export interface SomaSkill {
  name: string;
  path: string;
  description: string;
  triggers: string[];
}

export interface SomaMemoryLayout {
  root: string;
  work: string;
  knowledge: string;
  learning: string;
  relationship: string;
  state: string;
}

export interface SomaProfile {
  assistant: AssistantIdentity;
  principal: PrincipalIdentity;
  telos: Telos;
  memory: SomaMemoryLayout;
  skills: SomaSkill[];
}

export interface SomaContextInput {
  profile: SomaProfile;
  activeIsa?: IdealStateArtifact;
  prompt?: string;
}

export interface SomaContextBundle {
  substrate: SubstrateId;
  instructions: string;
  files: {
    path: string;
    content: string;
  }[];
}

export interface SomaTask {
  id: string;
  substrate: SubstrateId;
  prompt: string;
  cwd?: string;
}

export interface SomaRunResult {
  taskId: string;
  substrate: SubstrateId;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  artifacts?: string[];
}

export interface SomaAdapter {
  name: SubstrateId;
  detect(): Promise<boolean>;
  buildContext(input: SomaContextInput): Promise<SomaContextBundle>;
  run(task: SomaTask): Promise<SomaRunResult>;
}
