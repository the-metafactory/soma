import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendSomaMemoryEvent } from "../events/index";
import {
  SOMA_FEEDBACK_EVENT_SCHEMA_VERSION,
  SOMA_FEEDBACK_HOOK_TRIGGER_PATTERN_SOURCE,
  SOMA_FEEDBACK_PATTERN_SPECS,
  isSomaFeedbackMachinePrompt,
} from "../events/index";
import type { SomaFeedbackClassification } from "../events/index";
import type { SomaFeedbackCaptureOptions, SomaFeedbackCaptureResult } from "./types";

const FEEDBACK_PATTERNS = SOMA_FEEDBACK_PATTERN_SPECS.map((spec) => ({
  ...spec,
  patterns: spec.patternSources.map((source) => new RegExp(`\\b${source}\\b`, "i")),
}));
const FEEDBACK_TRIGGER_PATTERN = new RegExp(SOMA_FEEDBACK_HOOK_TRIGGER_PATTERN_SOURCE, "i");
const FEEDBACK_EXCERPT_MAX_LENGTH = 280;
const SECRET_EXCERPT_PATTERNS = [
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][-_A-Za-z0-9]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[-._~+/A-Za-z0-9]+=*/gi,
  /\b(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["']?[^"'\s]+/gi,
];

export function maybeSomaFeedbackPrompt(text: string): boolean {
  return FEEDBACK_TRIGGER_PATTERN.test(text);
}

function resolveSomaHome(options: Pick<SomaFeedbackCaptureOptions, "homeDir" | "somaHome"> = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function redactedFeedbackExcerpt(text: string): { text: string; truncated: boolean } {
  const normalized = text.trim().replace(/\s+/g, " ");
  const redacted = redactSomaFeedbackText(normalized);
  if (redacted.length <= FEEDBACK_EXCERPT_MAX_LENGTH) {
    return { text: redacted, truncated: false };
  }
  return { text: `${redacted.slice(0, FEEDBACK_EXCERPT_MAX_LENGTH)}...`, truncated: true };
}

/** Shared best-effort redaction for feedback excerpts and private Errata complaints. */
export function redactSomaFeedbackText(text: string): string {
  return SECRET_EXCERPT_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted]"), text);
}

export function classifySomaFeedback(text: string): SomaFeedbackClassification {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      kind: "none",
      confidence: "high",
      reason: "Prompt is empty.",
    };
  }

  if (isSomaFeedbackMachinePrompt(trimmed)) {
    return {
      kind: "none",
      confidence: "high",
      reason: "Prompt is machine-authored (task notification or pasted content).",
    };
  }

  if (!maybeSomaFeedbackPrompt(trimmed)) {
    return {
      kind: "none",
      confidence: "high",
      reason: "Prompt does not look like actionable feedback.",
    };
  }

  for (const candidate of FEEDBACK_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(trimmed))) {
      return {
        kind: candidate.kind,
        confidence: candidate.confidence,
        reason: candidate.reason,
      };
    }
  }

  return {
    kind: "none",
    confidence: "high",
    reason: "Prompt does not look like actionable feedback.",
  };
}

export async function captureSomaFeedback(options: SomaFeedbackCaptureOptions): Promise<SomaFeedbackCaptureResult> {
  const somaHome = resolveSomaHome(options);
  const classification = classifySomaFeedback(options.text);

  if (classification.kind === "none") {
    return {
      somaHome,
      captured: false,
      classification,
    };
  }

  const source = options.source ?? "prompt";
  const substrate = options.substrate ?? "custom";
  const excerpt = options.storeExcerpt === true ? redactedFeedbackExcerpt(options.text) : undefined;

  const event = await appendSomaMemoryEvent(somaHome, {
    timestamp: options.timestamp,
    substrate,
    kind: "feedback.candidate",
    summary: `Feedback candidate captured: ${classification.kind}.`,
    metadata: {
      // #647 v1 envelope fields (soma#785 Q6), carried in metadata until #647
      // lifts them onto the memory event envelope.
      schemaVersion: SOMA_FEEDBACK_EVENT_SCHEMA_VERSION,
      substrate,
      actor: options.actor ?? "interactive",
      ...(nonEmpty(options.sessionId) ? { sessionId: options.sessionId } : {}),
      ...(nonEmpty(options.transcriptPath) ? { transcriptPath: options.transcriptPath } : {}),
      feedbackKind: classification.kind,
      confidence: classification.confidence,
      reason: classification.reason,
      source,
      promptStored: false,
      excerptStored: Boolean(excerpt),
      ...(excerpt
        ? {
            redactedExcerpt: excerpt.text,
            excerptTruncated: excerpt.truncated,
          }
        : {}),
    },
  });

  return {
    somaHome,
    captured: true,
    classification,
    event,
  };
}
