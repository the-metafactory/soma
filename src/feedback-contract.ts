import type { SomaFeedbackClassification, SomaFeedbackKind } from "./types";

export const SOMA_FEEDBACK_STDIN_MAX_BYTES = 64 * 1024;

export interface SomaFeedbackPatternSpec {
  kind: Exclude<SomaFeedbackKind, "none">;
  confidence: SomaFeedbackClassification["confidence"];
  reason: string;
  patternSources: string[];
}

export const SOMA_FEEDBACK_PATTERN_SPECS: SomaFeedbackPatternSpec[] = [
  {
    kind: "missed-surface",
    confidence: "high",
    reason: "Prompt says the assistant missed, forgot, or left out a relevant surface.",
    patternSources: ["you missed", "missed the", "left out", "forgot", "didn'?t include"],
  },
  {
    kind: "correction",
    confidence: "high",
    reason: "Prompt corrects prior assistant behavior or result.",
    patternSources: ["you were wrong", "that'?s wrong", "you are wrong", "not correct", "error from", "bug in your"],
  },
  {
    kind: "preference",
    confidence: "high",
    reason: "Prompt states a future operating preference.",
    patternSources: ["from now on", "next time", "next time you should", "prefer", "please always", "don'?t", "do not"],
  },
  {
    kind: "relationship-note",
    confidence: "medium",
    reason: "Prompt asks Soma to remember personal or relationship context.",
    patternSources: ["remember (?:that|this|my|i)", "my preference", "for me"],
  },
  {
    kind: "task-learning",
    confidence: "medium",
    reason: "Prompt reports task outcome or a reusable process observation.",
    patternSources: ["that worked", "this worked", "works now", "root cause", "the issue was"],
  },
];

export const SOMA_FEEDBACK_HOOK_TRIGGER_PATTERN_SOURCE = `\\b(?:${SOMA_FEEDBACK_PATTERN_SPECS.flatMap((spec) => spec.patternSources).join("|")})\\b`;
