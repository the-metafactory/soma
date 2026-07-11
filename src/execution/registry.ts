import type { ProjectionSubstrate, SubstrateId } from "../types";
import { REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS, type ExecutionConformanceScenarioId } from "./conformance";
import type { SubstrateExecutor } from "./types";

export const KNOWN_SUBSTRATES = new Set<SubstrateId>(["codex", "pi-dev", "claude-code", "cursor", "grok", "cortex", "custom"]);
export const KNOWN_EXECUTION_SUBSTRATES = new Set<ProjectionSubstrate>([...KNOWN_SUBSTRATES, "anthropic-cowork"]);

export function isKnownSubstrate(substrate: string): substrate is SubstrateId {
  return KNOWN_SUBSTRATES.has(substrate as SubstrateId);
}

export function isKnownExecutionSubstrate(substrate: string): substrate is ProjectionSubstrate {
  return KNOWN_EXECUTION_SUBSTRATES.has(substrate as ProjectionSubstrate);
}

export interface RegisteredSubstrateExecutor {
  executor: SubstrateExecutor;
  conformanceScenarios: readonly ExecutionConformanceScenarioId[];
}

export type ExecutorRegistryResolution =
  | { status: "ready"; executor: SubstrateExecutor }
  | { status: "unsupported"; substrate: string; reason: "unknown-substrate" | "projection-only" };

export class ExecutorRegistry {
  private readonly entries = new Map<ProjectionSubstrate, RegisteredSubstrateExecutor>();

  register(entry: RegisteredSubstrateExecutor): void {
    const substrate = entry.executor.substrate;
    if (!isKnownExecutionSubstrate(substrate)) throw new Error(`Executor registry only accepts ProjectionSubstrate entries: ${entry.executor.substrate}.`);
    const missing = REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS.filter((scenario) => !entry.conformanceScenarios.includes(scenario));
    if (missing.length > 0) throw new Error(`Executor registration missing required conformance scenarios: ${missing.join(", ")}.`);
    if (this.entries.has(substrate)) throw new Error(`Executor already registered for ${entry.executor.substrate}.`);
    this.entries.set(substrate, entry);
  }

  resolve(substrate: string): ExecutorRegistryResolution {
    if (!isKnownExecutionSubstrate(substrate)) return { status: "unsupported", substrate, reason: "unknown-substrate" };
    const entry = this.entries.get(substrate);
    return entry === undefined ? { status: "unsupported", substrate, reason: "projection-only" } : { status: "ready", executor: entry.executor };
  }
}
