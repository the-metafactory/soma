import { diagnoseClaudeCodeProjectionDrift } from "./claude-code/doctor";
import { diagnoseCodexProjectionDrift } from "./codex/doctor";
import { diagnoseGrokProjectionDrift } from "./grok/doctor";
import type { SomaDoctorFinding, SubstrateId } from "../types";

type DoctorSubstrate = Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor" | "grok">;

// Single source of truth for the substrates `soma doctor` can diagnose, and
// the error strings shown when an unsupported one is requested. Shared so the
// CLI parser, the diagnosis entrypoint, and this dispatcher stay in lockstep.
export const DOCTOR_SUPPORTED_SUBSTRATES = ["codex", "claude-code", "grok"] as const satisfies readonly DoctorSubstrate[];

export type SupportedDoctorSubstrate = (typeof DOCTOR_SUPPORTED_SUBSTRATES)[number];

export function isDoctorSubstrate(value: string): value is SupportedDoctorSubstrate {
  return (DOCTOR_SUPPORTED_SUBSTRATES as readonly string[]).includes(value);
}

function formatSubstrateList(substrates: readonly string[]): string {
  if (substrates.length <= 1) return substrates.join("");
  return `${substrates.slice(0, -1).join(", ")} and ${substrates[substrates.length - 1]}`;
}

const SUPPORTED_LIST = formatSubstrateList(DOCTOR_SUPPORTED_SUBSTRATES);
export const DOCTOR_UNSUPPORTED_SUBSTRATE_MESSAGE =
  `soma doctor currently supports --substrate ${SUPPORTED_LIST} only.`;
export const DOCTOR_UNSUPPORTED_DRIFT_MESSAGE =
  `soma doctor currently supports projection drift checks for --substrate ${SUPPORTED_LIST} only.`;

export async function diagnoseProjectionDrift(options: {
  substrate: SupportedDoctorSubstrate;
  homeDir: string;
  profileMtime: number | null;
}): Promise<SomaDoctorFinding[]> {
  if (options.substrate === "codex") {
    return diagnoseCodexProjectionDrift(options);
  }
  if (options.substrate === "claude-code") {
    return diagnoseClaudeCodeProjectionDrift(options);
  }
  if (options.substrate === "grok") {
    // grok drift is judged by Grok's own discovery oracle, not the
    // profile-mtime heuristic, so profileMtime is deliberately unused here.
    return diagnoseGrokProjectionDrift({ homeDir: options.homeDir });
  }
  throw new Error(DOCTOR_UNSUPPORTED_DRIFT_MESSAGE);
}
