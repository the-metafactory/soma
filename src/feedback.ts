import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendSomaMemoryEvent } from "./memory";
import { SOMA_FEEDBACK_HOOK_TRIGGER_PATTERN_SOURCE, SOMA_FEEDBACK_PATTERN_SPECS } from "./feedback-contract";
import type { SomaFeedbackCaptureOptions, SomaFeedbackCaptureResult, SomaFeedbackClassification } from "./types";

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

function redactedFeedbackExcerpt(text: string): { text: string; truncated: boolean } {
  const normalized = text.trim().replace(/\s+/g, " ");
  const redacted = SECRET_EXCERPT_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted]"), normalized);
  if (redacted.length <= FEEDBACK_EXCERPT_MAX_LENGTH) {
    return { text: redacted, truncated: false };
  }
  return { text: `${redacted.slice(0, FEEDBACK_EXCERPT_MAX_LENGTH)}...`, truncated: true };
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
  const excerpt = options.storeExcerpt ?? true ? redactedFeedbackExcerpt(options.text) : undefined;

  const event = await appendSomaMemoryEvent(somaHome, {
    timestamp: options.timestamp,
    substrate: options.substrate ?? "custom",
    kind: "feedback.candidate",
    summary: `Feedback candidate captured: ${classification.kind}.`,
    metadata: {
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
