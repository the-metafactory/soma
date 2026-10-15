import type { SomaFeedbackClassification, SomaFeedbackKind } from "./types";

export const SOMA_FEEDBACK_STDIN_MAX_BYTES = 64 * 1024;

export interface SomaFeedbackPatternSpec {
  kind: Exclude<SomaFeedbackKind, "none">;
  confidence: SomaFeedbackClassification["confidence"];
  reason: string;
  patternSources: string[];
  automaticHook?: boolean;
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
    patternSources: ["from now on", "next time", "next time you should", "please always"],
  },
  {
    kind: "preference",
    confidence: "high",
    reason: "Prompt states a future operating preference.",
    patternSources: ["prefer", "don'?t", "do not"],
    automaticHook: false,
  },
  {
    kind: "relationship-note",
    confidence: "medium",
    reason: "Prompt asks Soma to remember personal or relationship context.",
    patternSources: ["remember (?:that|this|my|i)", "my preference"],
  },
  {
    kind: "task-learning",
    confidence: "medium",
    reason: "Prompt reports task outcome or a reusable process observation.",
    patternSources: ["that worked", "this worked", "works now", "root cause", "the issue was"],
  },
];

export const SOMA_FEEDBACK_HOOK_TRIGGER_PATTERN_SOURCE = `\\b(?:${SOMA_FEEDBACK_PATTERN_SPECS.flatMap((spec) => spec.patternSources).join("|")})\\b`;
export const SOMA_FEEDBACK_AUTOMATIC_HOOK_TRIGGER_PATTERN_SOURCE = `\\b(?:${SOMA_FEEDBACK_PATTERN_SPECS.flatMap((spec) =>
  spec.automaticHook === false ? [] : spec.patternSources,
).join("|")})\\b`;

// node #846 (soma#785 Q6): a feedback.candidate event carries the #647 v1
// envelope fields in its metadata until #647 lifts them onto the envelope.
export const SOMA_FEEDBACK_EVENT_SCHEMA_VERSION = 1;

// soma#785 Q13: who authored the prompt. `automated` = a ranger worker
// (RANGER_JOURNAL_PATH set), `sdk` = a headless run, `interactive` = a person.
export const SOMA_FEEDBACK_ACTORS = ["interactive", "sdk", "automated"] as const;

// soma#785 Q13: prompts the harness or a paste wrote, not the principal. A
// trimmed prompt starting with one of these is never captured.
export const SOMA_FEEDBACK_MACHINE_PROMPT_PREFIXES = ["<task-notification>", "<pasted_content"] as const;

export function isSomaFeedbackMachinePrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return SOMA_FEEDBACK_MACHINE_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}
