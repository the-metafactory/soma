import type { SubstrateId, ProjectionSubstrate } from "../core/types";
import type { ShippedSubstrate } from "../policy/types";
import type { ProjectionInput } from "../home/types";
import type { InstallSubstrate } from "../policy/types";

export interface Projection {
  substrate: ProjectionSubstrate;
  instructions: string;
  files: {
    path: string;
    content: string;
    /**
     * When true, the file is chmod'd executable (0o755) at write
     * time. Used by hook entries that the substrate execs directly
     * via shebang (soma#73 sage r2). Defaults to false; ordinary
     * markdown/config files stay 0o644.
     */
    executable?: boolean;
  }[];
}

export interface WrittenProjection {
  substrate: ProjectionSubstrate;
  rootDir: string;
  files: string[];
}

export interface SomaHomeProjectionOptions {
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  somaRepoPath?: string;
  codeOnly?: boolean;
}

export interface SomaHomeProjection {
  substrate: ProjectionSubstrate;
  somaHome: string;
  substrateHome: string;
  bundle: Projection;
}

export interface SomaHomeBootstrapResult {
  somaHome: string;
  context: ProjectionInput;
  files: string[];
}

export interface SomaInstallOptions {
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  somaRepoPath?: string;
  /**
   * @internal Test seam (node #914): the source the runtime artifacts are
   * staged from. Omitted → `somaRepoPath`. It moves the staged runtime only;
   * bundled skills and projections still read `somaRepoPath`. Tests that do
   * not exercise the staged runtime pass a stub so each install does not
   * stage the whole soma tree.
   */
  runtimeSourceRoot?: string;
  codeOnly?: boolean;
  /**
   * Narrow the registry→loader projection to these skill names (soma#638).
   * Omitted → a `loader` substrate takes the whole curated registry. Lives on
   * the install options, not the CLI, so a programmatic install projects the
   * same skills a CLI install does.
   */
  skills?: string[];
}

/** A skill linked into a substrate's loader by install (soma#638). */
export interface InstalledSkill {
  skill: string;
  path: string;
  status: string;
}

/** A registry entry install could not project, and why (soma#638). */
export interface UninstallableSkillReport {
  dir: string;
  reason: string;
}

export interface SomaInstallResult {
  substrate: InstallSubstrate;
  /** Present when a guarded substrate was projected against the frozen runtime. */
  runtimeArtifact?: { path: string; hash: string; previous?: string };
  somaHome: SomaHomeBootstrapResult;
  substrateHome: WrittenProjection;
  /**
   * Registry skills linked into the substrate's loader, and registry entries
   * that could not be (soma#638). Empty for a `catalog` substrate, whose
   * projected catalog already advertises the registry.
   */
  projectedSkills: InstalledSkill[];
  unprojectableSkills: UninstallableSkillReport[];
}

export interface SomaSkillBaseline {
  version: string;
  files: Record<string, string>;
  installedAt: string;
}

export type SomaSkillBaselines = Record<string, SomaSkillBaseline>;

export interface VsaSkillInstallOptions {
  homeDir?: string;
  somaHome?: string;
  somaRepoPath?: string;
  force?: boolean;
  /**
   * Absolute destination directory for the installed skill (#37). When
   * omitted the installer writes to `<somaHome>/skills/VSA` (preserves
   * pre-#37 behavior). When set — used by substrate adapters that want
   * to install the same versioned skill under their own root, e.g.
   * `~/.codex/skills/VSA`. The baseline + drift detection logic is
   * shared regardless of destination.
   */
  skillDestinationDir?: string;
}

export type VsaSkillInstallAction = "fresh" | "upgraded" | "unchanged" | "preserved-local-edits" | "no-source";

export interface VsaSkillInstallResult {
  somaHome: string;
  skillDir: string;
  sourceVersion: string;
  runtimeVersion: string | null;
  action: VsaSkillInstallAction;
  filesWritten: string[];
  filesPreservedUserAdditions: string[];
  upgradeMarker?: string;
}

export interface SkillNormalizationAction {
  file: string;
  kind:
    | "removed-substrate-notification-hook"
    | "rewrote-claude-home-path"
    | "rewrote-pai-doc-path"
    | "rewrote-pai-template-path"
    | "rewrote-pai-algorithm-path"
    | "rewrote-pai-memory-path"
    | "rewrote-unmapped-claude-path"
    | "stripped-mandatory-runtime-block"
    | "stripped-pai-customization-block";
  detail: string;
}

export interface SkillNormalizationWarning {
  file: string;
  kind:
    | "ambiguous-substrate-path"
    | "substrate-mutation-command"
    | "execution-logging-path"
    | "customization-overlay-reference"
    | "release-safety-path"
    | "unmapped-claude-home-path";
  detail: string;
}

/**
 * The substrates `soma doctor` can diagnose: the shipped substrates. Used to
 * parameterize the projection finding-id type below so only supported-substrate
 * ids are type-valid.
 */
export type SomaDoctorSubstrate = ShippedSubstrate;

/**
 * Content-compare drift findings (soma#370) are substrate-parameterized: the
 * same shapes apply uniformly whichever of the 5 doctor-supported
 * substrates produced them. Declared as a template-literal type over the
 * doctor-supported substrate union (`SomaDoctorSubstrate`) — NOT the broader
 * `SubstrateId`, which would admit `cortex-*`/`custom-*` ids the doctor can
 * never emit — rather than duplicating the suffix cross product by hand for
 * every substrate. The pre-existing substrate-specific strings this
 * generalizes (`codex-projection-stale`, `claude-code-projection-stale`,
 * `claude-code-projection-unmanaged-edit`, `grok-projection-stale`) are exact
 * members of this pattern, so no finding id string actually changes.
 *
 * `-not-diagnosable` is the honest "could not check" outcome (soma#370): Soma
 * is not installed / the Soma home is incomplete, so the source projection
 * cannot be built to compare against and NO comparison was performed. It is
 * emitted as `severity: "info"` so a legitimately-uninstalled home does not
 * hard-fail CI, but the output says "not diagnosed" rather than a bare "ok" —
 * never fail open.
 */
export type SomaDoctorProjectionFindingId =
  | `${SomaDoctorSubstrate}-projection-missing`
  | `${SomaDoctorSubstrate}-projection-stale`
  | `${SomaDoctorSubstrate}-projection-unmanaged-edit`
  | `${SomaDoctorSubstrate}-not-diagnosable`;

export type SomaDoctorFindingId =
  | "starter-profile"
  | "claude-skills-not-migrated"
  | SomaDoctorProjectionFindingId
  // soma#542: eager-loader stub integrity. Not a projection-drift id — the
  // stub's own bytes are correct; what rots is the body it points at.
  | "skill-stub-dangling"
  | "skill-stub-unreadable"
  | "claude-code-hook-missing"
  | "claude-code-settings-missing"
  | "grok-hook-missing"
  | "grok-hook-files-incomplete"
  | "grok-hook-interpreter-missing"
  | "grok-inspect-unavailable"
  | "runtime-artifact-missing"
  | "runtime-artifact-unloadable";

export interface SomaDoctorFinding {
  id: SomaDoctorFindingId;
  /**
   * `error` (soma#370) is reserved for a projection file that is entirely
   * ABSENT on disk — a broken/never-installed projection, not merely an
   * out-of-date one. It is the only severity that flips `soma doctor`'s
   * process exit code to 2 (see `SomaDoctorDiagnosis.status` and the CLI
   * doctor handler); `warning` (drift/hand-edit) maps to exit 1, and no
   * findings above `info` maps to exit 0.
   */
  severity: "info" | "warning" | "error";
  /** Human-readable explanation of the drift; carries the narrative guidance. */
  message: string;
  /**
   * The remediation step the onboarding/doctor surfaces print verbatim.
   * Command-first: use an executable CLI command (e.g. `soma reproject grok`,
   * `soma install claude-code --apply`) wherever a single command remediates
   * the finding, so an agent or user can run it directly. Only when no single
   * command applies — e.g. `starter-profile`, where the
   * user must hand-author profile files — use a concise imperative
   * instruction instead. Either way the narrative explanation belongs in
   * `message`, not here. (The grok doctor's
   * `grok-inspect-unavailable` action was prose where re-running the check is
   * the right command; it now uses the command and the prose moved to
   * `message`. Documented so future findings keep the command-first
   * convention.)
   */
  action: string;
}

export interface SomaLifecycleOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  sessionId?: string;
  timestamp?: string;
  /** Working directory of the substrate session (from the hook payload). */
  cwd?: string;
  /** Git branch of `cwd`, when known. Detected from `cwd` when omitted. */
  gitBranch?: string;
  /** Optional adapter-provided deadline for the session work-registry writeback. */
  workRegistryLockTimeoutMs?: number;
  /**
   * On `session-end`: path to the substrate session transcript. When set (and the
   * substrate has a transcript adapter, e.g. claude-code), the handler attempts the
   * deterministic digest FALLBACK. Substrate-owned — core does not parse it.
   */
  transcriptPath?: string;
  /** Claude Code sub-agent markers from the hook payload (suppress the fallback per ADR 0014). */
  subagentId?: string;
  subagentType?: string;
}

export interface SomaAdapter {
  name: ProjectionSubstrate;
  detect(): Promise<boolean>;
  project(input: ProjectionInput): Promise<Projection>;
}
