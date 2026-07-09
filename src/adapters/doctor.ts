import { diagnoseClaudeCodeInstallArtifactDrift } from "./claude-code/doctor";
import { diagnoseContentCompareDrift } from "./content-compare-doctor";
import { diagnoseGrokProjectionDrift } from "./grok/doctor";
import type { SomaDoctorFinding, SubstrateId } from "../types";

type DoctorSubstrate = Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor" | "grok">;

// Single source of truth for the substrates `soma doctor` can diagnose, and
// the error strings shown when an unsupported one is requested. Shared so the
// CLI parser, the diagnosis entrypoint, and this dispatcher stay in lockstep.
// soma#370: extended to all 5 install substrates — content-compare drift
// (../content-compare-doctor.ts) is substrate-agnostic, so cursor and
// pi-dev, which had no drift diagnosis at all before, are now covered too.
export const DOCTOR_SUPPORTED_SUBSTRATES = ["codex", "claude-code", "cursor", "grok", "pi-dev"] as const satisfies readonly DoctorSubstrate[];

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
  somaHome: string;
  somaRepoPath?: string;
}): Promise<SomaDoctorFinding[]> {
  // soma#370: every doctor-supported substrate's home projection is a pure
  // function of ProjectionInput, so content-compare runs uniformly for all
  // 5 — this REPLACES the old codex/claude-code profile-mtime heuristics
  // outright (they only ever approximated what content-compare now checks
  // directly) and is the FIRST drift diagnosis cursor/pi-dev have ever had.

  if (options.substrate === "claude-code") {
    // Install-artifact checks (hook files on disk, settings.json wiring) are
    // NOT part of the projected `rules/soma/*` bundle content-compare diffs,
    // so they stay as a separate, narrower check.
    const [contentFindings, artifactFindings] = await Promise.all([
      diagnoseContentCompareDrift(options),
      diagnoseClaudeCodeInstallArtifactDrift(options),
    ]);
    return [...contentFindings, ...artifactFindings];
  }
  if (options.substrate === "grok") {
    // grok ADDITIONALLY keeps its `grok inspect --json` oracle-based checks
    // (../grok/doctor.ts): whether Grok's runtime has actually discovered a
    // file is a different, non-deterministic question from whether the
    // file's bytes match a fresh projection, so oracle and content-compare
    // findings are composed rather than one replacing the other — see
    // content-compare-doctor.ts's module doc for the full rationale. The two
    // read disjoint inputs (projected bytes vs `grok inspect`/hook files)
    // with no ordering dependency, so run them concurrently; order is
    // preserved (content findings first, then oracle).
    const [contentFindings, grokFindings] = await Promise.all([
      diagnoseContentCompareDrift(options),
      diagnoseGrokProjectionDrift({ homeDir: options.homeDir }),
    ]);
    return [...contentFindings, ...grokFindings];
  }
  return diagnoseContentCompareDrift(options);
}
