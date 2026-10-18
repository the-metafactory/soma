import { getRunPhase } from "./algorithm-lifecycle";
import type { AlgorithmPhase, SubstrateId } from "../core/types";
import type { AlgorithmProvenanceOperation, AlgorithmRun } from "./types";

export interface AlgorithmProvenanceInput {
  operation: AlgorithmProvenanceOperation;
  timestamp: string;
  substrate?: SubstrateId;
  phase?: AlgorithmPhase;
  detail?: string;
}

export function appendAlgorithmProvenance(run: AlgorithmRun, input: AlgorithmProvenanceInput): AlgorithmRun {
  const substrate = input.substrate ?? run.substrate ?? "custom";
  const detail = input.detail?.trim();
  return {
    ...run,
    provenance: [
      ...run.provenance,
      {
        timestamp: input.timestamp,
        phase: input.phase ?? getRunPhase(run),
        operation: input.operation,
        substrate,
        ...(detail ? { detail } : {}),
      },
    ],
  };
}

export function algorithmTouchedBy(run: Pick<AlgorithmRun, "substrate" | "provenance">): SubstrateId[] {
  const touched = new Set<SubstrateId>();
  if (run.substrate) touched.add(run.substrate);
  for (const entry of run.provenance) {
    touched.add(entry.substrate);
  }
  return Array.from(touched);
}
