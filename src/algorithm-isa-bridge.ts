/**
 * Algorithm ↔ ISA bridge (#39).
 *
 * Soma's Algorithm runs are independent of any active ISA: a typical
 * run can complete end-to-end with no ISA set (AC-7). When an active
 * ISA IS present, these helpers route Algorithm decisions, changes,
 * and verification flags through the Layer 7 lifecycle hook (#38) so
 * the writeback gate + audit trail are honored.
 *
 * No function in this module halts or throws on missing ISA. The
 * forcing-function pattern (`requireIsaAtObserve`) is explicitly
 * forbidden — see AC-5 + Plans/2026-05-17-autonomous-sprint-3-4.md.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendSomaMemoryEvent } from "./memory";
import { getActiveIsa, readIsa, writeIsa } from "./isa";
import { runSomaLifecycleIsaUpdated } from "./lifecycle";
import { getCriteria } from "./isa-accessors";
import type { AlgorithmEffortTier, AlgorithmPhase, IdealStateArtifact, SubstrateId } from "./types";

export interface AlgorithmIsaOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  timestamp?: string;
  phase?: AlgorithmPhase;
}

export interface HintConfig {
  /** Disable hint emission entirely. Default: false. */
  suppressed?: boolean;
}

interface InternalSomaHomeResolved {
  somaHome: string;
}

function resolveSomaHome(options: AlgorithmIsaOptions = {}): InternalSomaHomeResolved {
  return {
    somaHome: resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma")),
  };
}

function substrate(options: AlgorithmIsaOptions): SubstrateId {
  return options.substrate ?? "custom";
}

/**
 * Append an Algorithm decision to the active ISA's Decisions section.
 * Silent no-op when no active ISA is set — emits a `no-active-isa`
 * telemetry event instead (AC-2 + AC-6).
 */
export async function recordAlgorithmIsaDecision(
  text: string,
  options: AlgorithmIsaOptions = {},
): Promise<{ recorded: boolean; slug: string | null }> {
  return routeAlgorithmIsaEntry({ kind: "decisions", text }, options, "decision");
}

/**
 * Append an Algorithm change entry to the active ISA's Changelog
 * section. Silent no-op when no active ISA is set — emits a
 * `no-active-isa` telemetry event instead.
 */
export async function recordAlgorithmIsaChange(
  text: string,
  options: AlgorithmIsaOptions = {},
): Promise<{ recorded: boolean; slug: string | null }> {
  return routeAlgorithmIsaEntry({ kind: "changelog", text }, options, "change");
}

async function routeAlgorithmIsaEntry(
  entry: { kind: "decisions" | "changelog"; text: string },
  options: AlgorithmIsaOptions,
  callerLabel: string,
): Promise<{ recorded: boolean; slug: string | null }> {
  const { somaHome } = resolveSomaHome(options);
  const state = await getActiveIsa({ somaHome });
  const slug = state?.activeSlug ?? null;
  if (slug === null) {
    // Telemetry failure must NOT break the silent-no-op contract
    // (Sage round-2 finding on #63 — same fix shape as the hint path).
    try {
      await appendSomaMemoryEvent(somaHome, {
        substrate: substrate(options),
        kind: "algorithm.isa_route.no-active-isa",
        summary: `Algorithm ${callerLabel} not recorded: no active ISA set.`,
        timestamp: options.timestamp ?? new Date().toISOString(),
        metadata: { callerLabel, text: entry.text },
      });
    } catch {
      // intentional: no-op contract must hold even when audit can't be persisted
    }
    return { recorded: false, slug: null };
  }
  const payload =
    entry.kind === "decisions"
      ? { decisions: [{ text: entry.text, phase: options.phase, timestamp: options.timestamp }] }
      : { changelogEntries: [{ text: entry.text, phase: options.phase, timestamp: options.timestamp }] };
  await runSomaLifecycleIsaUpdated(payload, {
    homeDir: options.homeDir,
    somaHome,
    substrate: options.substrate,
    timestamp: options.timestamp,
  });
  return { recorded: true, slug };
}

/**
 * If every criterion on the given ISA is `passed` or `dropped`, set
 * the ISA's frontmatter `verified: true` and persist. Returns whether
 * the verified flag flipped. No-op if the ISA is already marked
 * verified or if any criterion is still open / failed.
 *
 * Per Sage round-1 on #41 / Holly's reconciliation: criteria-flag
 * computation lives behind `checkCompleteness` + `getCriteria`; this
 * function ties the boolean to the actual frontmatter field.
 */
export async function markIsaVerifiedFromCriteria(
  slug: string,
  options: AlgorithmIsaOptions = {},
): Promise<{ verified: boolean; flipped: boolean }> {
  const isa = await readIsa(slug, options);
  const criteria = getCriteria(isa);
  if (criteria.length === 0) return { verified: false, flipped: false };
  const allClosed = criteria.every((c) => c.status === "passed" || c.status === "dropped");
  if (!allClosed) return { verified: false, flipped: false };
  if (isa.frontmatter.verified) return { verified: true, flipped: false };
  const next: IdealStateArtifact = {
    ...isa,
    frontmatter: {
      ...isa.frontmatter,
      verified: true,
      updated: options.timestamp ?? new Date().toISOString(),
    },
  };
  await writeIsa(slug, next, options);
  return { verified: true, flipped: true };
}

export interface PromptShape {
  effort: AlgorithmEffortTier;
  multiStep: boolean;
}

let hintSessionFired = false;

export interface SuggestIsaResult {
  emitted: boolean;
  reason?: "no-active-set" | "already-active" | "below-threshold" | "single-step" | "suppressed-config" | "suppressed-env" | "already-emitted";
  hint?: string;
}

const HINT_TEXT =
  "hint: no active ISA; run 'soma isa scaffold --slug <name> --effort <E1|E2|E3|E4|E5> --goal \"...\"' to articulate done";

/**
 * Non-blocking advisory hint. Emits when ALL of:
 *   - prompt shape is E3+ AND multi-step
 *   - no active ISA is set
 *   - hint hasn't already fired this session
 *   - suppression is not active via config or `SOMA_NO_HINTS=1` env
 *
 * Always returns normally — never throws, never halts (AC-4 + AC-5).
 * Suppression env var matches the documented `SOMA_NO_HINTS` switch.
 */
export async function suggestIsaAtObserve(
  shape: PromptShape,
  options: AlgorithmIsaOptions & { hintConfig?: HintConfig } = {},
): Promise<SuggestIsaResult> {
  if (process.env.SOMA_NO_HINTS === "1") {
    return { emitted: false, reason: "suppressed-env" };
  }
  if (options.hintConfig?.suppressed === true) {
    return { emitted: false, reason: "suppressed-config" };
  }
  if (hintSessionFired) {
    return { emitted: false, reason: "already-emitted" };
  }
  const tierIndex = ["E1", "E2", "E3", "E4", "E5"].indexOf(shape.effort);
  if (tierIndex < 2) {
    return { emitted: false, reason: "below-threshold" };
  }
  if (!shape.multiStep) {
    return { emitted: false, reason: "single-step" };
  }
  const { somaHome } = resolveSomaHome(options);
  const state = await getActiveIsa({ somaHome });
  if (state?.activeSlug != null) {
    return { emitted: false, reason: "already-active" };
  }
  hintSessionFired = true;
  // Telemetry failure must NOT break the non-blocking advisory contract
  // (Sage round-1 finding on #63). Swallow + best-effort.
  try {
    await appendSomaMemoryEvent(somaHome, {
      substrate: substrate(options),
      kind: "algorithm.isa_hint.suggested",
      summary: HINT_TEXT,
      timestamp: options.timestamp ?? new Date().toISOString(),
      metadata: { effort: shape.effort, multiStep: shape.multiStep },
    });
  } catch {
    // intentional: telemetry must never throw out of the hint path
  }
  return { emitted: true, reason: "no-active-set", hint: HINT_TEXT };
}

/**
 * Test-only — reset the session-fired flag so tests can exercise
 * multiple hint emissions in one process. Not exposed via index.ts.
 */
export function _resetSuggestSessionForTests(): void {
  hintSessionFired = false;
}

