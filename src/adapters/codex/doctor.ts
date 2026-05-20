import { join } from "node:path";
import { pathMtimeMs } from "../../fs-utils";
import type { SomaDoctorFinding } from "../../types";

export async function diagnoseCodexProjectionDrift(options: {
  homeDir: string;
  profileMtime: number | null;
}): Promise<SomaDoctorFinding[]> {
  const projectionMtime = await pathMtimeMs(join(options.homeDir, ".codex/rules/soma.rules"));
  if (options.profileMtime === null || (projectionMtime !== null && projectionMtime >= options.profileMtime)) {
    return [];
  }
  return [
    {
      id: "codex-projection-stale",
      severity: "warning",
      message: projectionMtime === null
        ? "Codex projection is missing."
        : "Codex projection is older than the Soma profile files.",
      action: "soma reproject codex",
    },
  ];
}
