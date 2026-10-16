import type { SubstrateId } from "../types";

/** A projected artifact the self-repair pass can heal (exec bit) and drift-check. */
export interface ProjectedArtifact {
  /** Absolute path of the projected file under the substrate home. */
  path: string;
  /**
   * True when the substrate execs the file directly via its shebang (a script
   * registered as a command), so a lost exec bit silently breaks it. False for
   * bun-invoked hooks, whose exec bit the runtime ignores.
   */
  directExec: boolean;
  /**
   * Fresh in-memory projection of the file's expected bytes, when the artifact is a
   * pure function of its projection inputs. Present ⇒ eligible for drift
   * detection; absent ⇒ exec-bit repair only.
   */
  expected?: string;
}

/**
 * A substrate-registered SessionEnd transcript-digest handler. Dependency INVERSION:
 * the home registry owns this neutral hook point; a substrate adapter (e.g. claude-code)
 * registers its transcript→digest fallback, so core never imports an adapter. The
 * transcript FORMAT stays entirely inside the adapter.
 */
export type SessionEndTranscriptHandler = (input: {
  homeDir?: string;
  somaHome: string;
  now: Date;
  substrate: SubstrateId;
  sessionId: string;
  transcriptPath: string;
  subagentId?: string;
  subagentType?: string;
  forcePrimary?: boolean;
  forceSubagent?: boolean;
}) => Promise<{ outcome: string; path?: string }>;

const sessionEndTranscriptHandlers = new Map<SubstrateId, SessionEndTranscriptHandler>();

/** Register a transcript-digest fallback; returns a disposer restoring the previous handler. */
export function registerSessionEndTranscriptHandler(substrate: SubstrateId, handler: SessionEndTranscriptHandler): () => void {
  const previous = sessionEndTranscriptHandlers.get(substrate);
  sessionEndTranscriptHandlers.set(substrate, handler);
  return () => {
    if (sessionEndTranscriptHandlers.get(substrate) !== handler) return;
    if (previous === undefined) sessionEndTranscriptHandlers.delete(substrate);
    else sessionEndTranscriptHandlers.set(substrate, previous);
  };
}

/**
 * A substrate-registered projection self-repair provider (soma#460). Same
 * dependency INVERSION as the transcript handler above: core owns the neutral
 * SessionStart repair step and looks the provider up by substrate, so core never
 * imports an adapter. The provider resolves its own substrate home and returns
 * the artifact descriptors to repair.
 */
export type ProjectionRepairProvider = (input: {
  homeDir?: string;
  somaHome: string;
}) => { substrateHome: string; artifacts: readonly ProjectedArtifact[] };

const projectionRepairProviders = new Map<SubstrateId, ProjectionRepairProvider>();

/** Register a substrate's projection self-repair provider (see the type doc). */
export function registerProjectionRepairProvider(substrate: SubstrateId, provider: ProjectionRepairProvider): void {
  projectionRepairProviders.set(substrate, provider);
}

/** Look up the transcript fallback without exposing the mutable registry. */
export function getSessionEndTranscriptHandler(substrate: SubstrateId): SessionEndTranscriptHandler | undefined {
  return sessionEndTranscriptHandlers.get(substrate);
}

/** Look up the projection repair provider registered by a substrate. */
export function getProjectionRepairProvider(substrate: SubstrateId): ProjectionRepairProvider | undefined {
  return projectionRepairProviders.get(substrate);
}
