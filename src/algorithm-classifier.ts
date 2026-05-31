import type { AlgorithmEffortTier, AlgorithmMode, AlgorithmPromptClassification } from "./types";

const EXPLICIT_EFFORT = /(?:^|\s)(?:\/e|e)([1-5])(?:\s|$)/i;

const MINIMAL_PROMPTS = new Set([
  "ok",
  "okay",
  "yes",
  "no",
  "thanks",
  "thank you",
  "ok thanks",
  "okay thanks",
  "works",
  "worked",
  "working",
  "great",
  "great works",
  "great that works",
  "great that works nicely",
  "nice",
  "excellent",
  "cool",
  "perfect",
  "looks good",
  "sounds good",
  "that works",
  "that worked",
  "go for it",
  "do it",
]);

const NATIVE_PATTERNS = [
  /\b(what'?s next|next step|status|is that installed|does that work|what changed|what did you change)\b/i,
  /^(what|who|when|where) (is|are|was|were)\b/i,
  /^what (time|date|day)\b/i,
  /^how (does|do|did|is|are)\b/i,
  /\b(run|execute)\b.+\b(tests?|command|script|lint|typecheck|date|pwd|ls)\b/i,
  /\b(read|show|summarize|inspect|check)\b.+\b(file|output|log|diff|status)\b/i,
  /\b(fix|change|rename|update)\b.+\b(typo|spelling|one line|single line)\b/i,
];

const ALGORITHM_PATTERNS = [
  /\b(build|create|make|implement|design|refactor|migrate|integrate|port|bootstrap|architect|evolve)\b/i,
  /\b(identify|analyze|reason|implications?|surprising|telos[- ]aligned|strategy|outcome)\b/i,
  /\b(system|doctrine|policy|hook|lifecycle|adapter|projection|daemon|framework|architecture)\b/i,
  /\b(multiple|multi[- ]file|cross[- ]cutting|end[- ]to[- ]end|portable|substrate)\b/i,
  /\b(algorithm|isa|ideal state|criteria|verification|harness|pai|soma)\b/i,
];

function explicitEffort(prompt: string): AlgorithmEffortTier | undefined {
  const match = EXPLICIT_EFFORT.exec(prompt);
  if (!match) return undefined;

  return `E${match[1]}` as AlgorithmEffortTier;
}

function classifyAlgorithmTier(prompt: string): AlgorithmEffortTier {
  const text = prompt.toLowerCase();

  if (/\b(comprehensive|no time pressure|exhaustive|full migration|whole system)\b/.test(text)) {
    return "E5";
  }

  if (/\b(deep|architecture|doctrine|cross-cutting|security model|policy enforcement)\b/.test(text)) {
    return "E4";
  }

  if (/\b(substantial|multi[- ]file|multiple files|migration|port|adapter|daemon|framework|bootstrap|refactor)\b/.test(text)) {
    return "E3";
  }

  if (/\b(thorough|quality|structured|workflow|harness|criteria|verify|tests?|clear reasoning|implications?|telos[- ]aligned|surprising|strategy)\b/.test(text)) {
    return "E2";
  }

  return "E1";
}

function classifyMode(prompt: string): AlgorithmMode {
  const text = prompt.trim();
  const normalized = text
    .toLowerCase()
    .replace(/[.!?,'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (MINIMAL_PROMPTS.has(normalized)) {
    return "minimal";
  }

  if (NATIVE_PATTERNS.some((pattern) => pattern.test(text)) && text.length < 180) {
    return "native";
  }

  if (ALGORITHM_PATTERNS.some((pattern) => pattern.test(text))) {
    return "algorithm";
  }

  return "algorithm";
}

export function classifyAlgorithmPrompt(prompt: string): AlgorithmPromptClassification {
  const text = prompt.trim();

  if (text.length === 0) {
    return {
      mode: "algorithm",
      effort: "E3",
      source: "fail-safe",
      reason: "Empty prompt cannot be classified safely; defaulting to Algorithm E3.",
    };
  }

  const override = explicitEffort(text);
  if (override) {
    return {
      mode: "algorithm",
      effort: override,
      source: "explicit",
      reason: `Explicit ${override} override in prompt.`,
    };
  }

  const mode = classifyMode(text);

  if (mode !== "algorithm") {
    return {
      mode,
      source: "auto",
      reason: mode === "minimal" ? "Prompt is a minimal acknowledgement." : "Prompt can be handled by the native substrate without Algorithm harness.",
    };
  }

  const effort = classifyAlgorithmTier(text);

  return {
    mode,
    effort,
    source: "auto",
    reason: `Prompt shape maps to Algorithm ${effort}.`,
  };
}
