import { diagnoseClaudeCodeProjectionDrift } from "./claude-code/doctor";
import { diagnoseCodexProjectionDrift } from "./codex/doctor";
import type { SomaDoctorFinding, SubstrateId } from "../types";

type DoctorSubstrate = Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor">;

// Single source of truth for the substrates `soma doctor` can diagnose, and
// the error strings shown when an unsupported one is requested. Shared so the
// CLI parser, the diagnosis entrypoint, and this dispatcher stay in lockstep.
export const DOCTOR_SUPPORTED_SUBSTRATES = ["codex", "claude-code"] as const satisfies readonly DoctorSubstrate[];
export const DOCTOR_UNSUPPORTED_SUBSTRATE_MESSAGE =
  "soma doctor currently supports --substrate codex and claude-code only.";
export const DOCTOR_UNSUPPORTED_DRIFT_MESSAGE =
  "soma doctor currently supports projection drift checks for --substrate codex and claude-code only.";

export async function diagnoseProjectionDrift(options: {
  substrate: DoctorSubstrate;
  homeDir: string;
  profileMtime: number | null;
}): Promise<SomaDoctorFinding[]> {
  if (options.substrate === "codex") {
    return diagnoseCodexProjectionDrift(options);
  }
  if (options.substrate === "claude-code") {
    return diagnoseClaudeCodeProjectionDrift(options);
  }
  throw new Error(DOCTOR_UNSUPPORTED_DRIFT_MESSAGE);
}
