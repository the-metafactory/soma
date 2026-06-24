/**
 * Algorithm ↔ VSA bridge (#39).
 *
 * Soma's Algorithm runs are independent of any active VSA: a typical
 * run can complete end-to-end with no VSA set (AC-7). When an active
 * VSA IS present, these helpers route Algorithm decisions, changes,
 * and verification flags through the Layer 7 lifecycle hook (#38) so
 * the writeback gate + audit trail are honored.
 *
 * No function in this module halts or throws on missing VSA. The
 * forcing-function pattern (`requireVsaAtObserve`) is explicitly
 * forbidden — see AC-5 + Plans/2026-05-17-autonomous-sprint-3-4.md.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendSomaMemoryEvent } from "./memory";
import { getActiveVsa, readVsa, writeVsa } from "./vsa";
import { runSomaLifecycleVsaUpdated } from "./lifecycle";
import { getCriteria } from "./vsa-accessors";
import type { AlgorithmEffortTier, AlgorithmPhase, VerificationStateArtifact, SubstrateId } from "./types";

export interface AlgorithmVsaOptions {
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

function resolveSomaHome(options: AlgorithmVsaOptions = {}): InternalSomaHomeResolved {
  return {
    somaHome: resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma")),
  };
}

function substrate(options: AlgorithmVsaOptions): SubstrateId {
  return options.substrate ?? "custom";
}

/**
 * Append an Algorithm decision to the active VSA's Decisions section.
 * Silent no-op when no active VSA is set — emits a `no-active-vsa`
 * telemetry event instead (AC-2 + AC-6).
 */
export async function recordAlgorithmVsaDecision(
  text: string,
  options: AlgorithmVsaOptions = {},
): Promise<{ recorded: boolean; slug: string | null }> {
  return routeAlgorithmVsaEntry({ kind: "decisions", text }, options, "decision");
}

/**
 * Append an Algorithm change entry to the active VSA's Changelog
 * section. Silent no-op when no active VSA is set — emits a
 * `no-active-vsa` telemetry event instead.
 */
export async function recordAlgorithmVsaChange(
  text: string,
  options: AlgorithmVsaOptions = {},
): Promise<{ recorded: boolean; slug: string | null }> {
  return routeAlgorithmVsaEntry({ kind: "changelog", text }, options, "change");
}

async function routeAlgorithmVsaEntry(
  entry: { kind: "decisions" | "changelog"; text: string },
  options: AlgorithmVsaOptions,
  callerLabel: string,
): Promise<{ recorded: boolean; slug: string | null }> {
  const { somaHome } = resolveSomaHome(options);
  const state = await getActiveVsa({ somaHome });
  const slug = state?.activeSlug ?? null;
  if (slug === null) {
    // Telemetry failure must NOT break the silent-no-op contract
    // (Sage round-2 finding on #63 — same fix shape as the hint path).
    try {
      await appendSomaMemoryEvent(somaHome, {
        substrate: substrate(options),
        kind: "algorithm.isa_route.no-active-vsa",
        summary: `Algorithm ${callerLabel} not recorded: no active VSA set.`,
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
  await runSomaLifecycleVsaUpdated(payload, {
    homeDir: options.homeDir,
    somaHome,
    substrate: options.substrate,
    timestamp: options.timestamp,
  });
  return { recorded: true, slug };
}

/**
 * If every criterion on the given VSA is `passed` or `dropped`, set
 * the VSA's frontmatter `verified: true` and persist. Returns whether
 * the verified flag flipped. No-op if the VSA is already marked
 * verified or if any criterion is still open / failed.
 *
 * Per Sage round-1 on #41 / Holly's reconciliation: criteria-flag
 * computation lives behind `checkCompleteness` + `getCriteria`; this
 * function ties the boolean to the actual frontmatter field.
 */
export async function markVsaVerifiedFromCriteria(
  slug: string,
  options: AlgorithmVsaOptions = {},
): Promise<{ verified: boolean; flipped: boolean }> {
  const isa = await readVsa(slug, options);
  const criteria = getCriteria(isa);
  if (criteria.length === 0) return { verified: false, flipped: false };
  const allClosed = criteria.every((c) => c.status === "passed" || c.status === "dropped");
  if (!allClosed) return { verified: false, flipped: false };
  if (isa.frontmatter.verified) return { verified: true, flipped: false };
  const next: VerificationStateArtifact = {
    ...isa,
    frontmatter: {
      ...isa.frontmatter,
      verified: true,
      updated: options.timestamp ?? new Date().toISOString(),
    },
  };
  await writeVsa(slug, next, options);
  return { verified: true, flipped: true };
}

export interface PromptShape {
  effort: AlgorithmEffortTier;
  multiStep: boolean;
}

let hintSessionFired = false;

export interface SuggestVsaResult {
  emitted: boolean;
  reason?: "no-active-set" | "already-active" | "below-threshold" | "single-step" | "suppressed-config" | "suppressed-env" | "already-emitted";
  hint?: string;
}

const HINT_TEXT =
  "hint: no active VSA; run 'soma vsa scaffold --slug <name> --effort <E1|E2|E3|E4|E5> --goal \"...\"' to articulate done";

/**
 * Non-blocking advisory hint. Emits when ALL of:
 *   - prompt shape is E3+ AND multi-step
 *   - no active VSA is set
 *   - hint hasn't already fired this session
 *   - suppression is not active via config or `SOMA_NO_HINTS=1` env
 *
 * Always returns normally — never throws, never halts (AC-4 + AC-5).
 * Suppression env var matches the documented `SOMA_NO_HINTS` switch.
 */
export async function suggestVsaAtObserve(
  shape: PromptShape,
  options: AlgorithmVsaOptions & { hintConfig?: HintConfig } = {},
): Promise<SuggestVsaResult> {
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
  const state = await getActiveVsa({ somaHome });
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

