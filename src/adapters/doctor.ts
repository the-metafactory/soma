import { diagnoseCodexProjectionDrift } from "./codex/doctor";
import type { SomaDoctorFinding, SubstrateId } from "../types";

type DoctorSubstrate = Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor">;

export async function diagnoseProjectionDrift(options: {
  substrate: DoctorSubstrate;
  homeDir: string;
  profileMtime: number | null;
}): Promise<SomaDoctorFinding[]> {
  if (options.substrate === "codex") {
    return diagnoseCodexProjectionDrift(options);
  }
  throw new Error("soma doctor currently supports projection drift checks for --substrate codex only.");
}
