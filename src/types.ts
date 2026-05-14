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

export interface WrittenContextBundle {
  substrate: SubstrateId;
  rootDir: string;
  files: string[];
}

export interface SomaHomeProjectionOptions {
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
}

export interface SomaHomeProjection {
  substrate: SubstrateId;
  somaHome: string;
  substrateHome: string;
  bundle: SomaContextBundle;
}

export interface SomaHomeBootstrapOptions {
  homeDir?: string;
  somaHome?: string;
}

export interface SomaHomeBootstrapResult {
  somaHome: string;
  context: SomaContextInput;
  files: string[];
}

export interface SomaInstallOptions {
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
}

export interface SomaInstallResult {
  substrate: SubstrateId;
  somaHome: SomaHomeBootstrapResult;
  substrateHome: WrittenContextBundle;
}

export interface SomaInstallPlan {
  substrate: SubstrateId;
  apply: boolean;
  somaHome: string;
  substrateHome: string;
  somaDirectories: string[];
  somaFiles: string[];
  substrateFiles: string[];
}

export interface PaiImportOptions {
  homeDir?: string;
  claudeHome?: string;
  somaHome?: string;
}

export interface PaiImportPlan {
  apply: boolean;
  claudeHome: string;
  somaHome: string;
  sourceFiles: string[];
  targetFiles: string[];
}

export interface PaiImportResult {
  claudeHome: string;
  somaHome: string;
  files: string[];
}

export interface SomaMemoryEventInput {
  id?: string;
  timestamp?: string;
  substrate: SubstrateId;
  kind: string;
  summary: string;
  artifactPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface SomaMemoryEvent {
  id: string;
  timestamp: string;
  substrate: SubstrateId;
  kind: string;
  summary: string;
  artifactPaths?: string[];
  metadata?: Record<string, unknown>;
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
