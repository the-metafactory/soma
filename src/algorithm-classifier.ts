import type { AlgorithmEffortTier, AlgorithmMode, AlgorithmPromptClassification } from "./types";

/**
 * Serialisable classification contract.
 *
 * Held as pattern *sources* rather than RegExp literals so substrate adapters can
 * project the classifier into generated extension code without duplicating the
 * pattern set. Same idiom as SOMA_FEEDBACK_AUTOMATIC_HOOK_TRIGGER_PATTERN_SOURCE
 * in src/feedback-contract.ts: share the data, generate only the logic.
 *
 * Consumed by src/adapters/shared/algorithm-classifier-source.ts (soma#475).
 * Behavioural equivalence between this module and the projected copy is enforced
 * by test/pi-dev-classifier-projection.test.ts.
 */
export const ALGORITHM_CLASSIFIER_CONTRACT = {
  /** Applied to the raw prompt, case-insensitive. Capture group 1 is the tier digit. */
  explicitEffortPattern: "(?:^|\\s)(?:\\/e|e)([1-5])(?:\\s|$)",

  /** Compared against the punctuation-stripped, whitespace-collapsed, lowercased prompt. */
  minimalPrompts: [
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
  ],

  /** Applied to the trimmed prompt, case-insensitive, and only below nativeMaxLength. */
  nativePatterns: [
    "\\b(what'?s next|next step|status|is that installed|does that work|what changed|what did you change)\\b",
    "^(what|who|when|where) (is|are|was|were)\\b",
    "^what (time|date|day)\\b",
    "^how (does|do|did|is|are)\\b",
    "\\b(run|execute)\\b.+\\b(tests?|command|script|lint|typecheck|date|pwd|ls)\\b",
    "\\b(read|show|summarize|inspect|check)\\b.+\\b(file|output|log|diff|status)\\b",
    "\\b(fix|change|rename|update)\\b.+\\b(typo|spelling|one line|single line)\\b",
  ],
  nativeMaxLength: 180,

  /** Applied to the trimmed prompt, case-insensitive. */
  algorithmPatterns: [
    "\\b(build|create|make|implement|design|refactor|migrate|integrate|port|bootstrap|architect|evolve)\\b",
    "\\b(identify|analyze|reason|implications?|surprising|(?:telos|purpose)[- ]aligned|strategy|outcome)\\b",
    "\\b(system|doctrine|policy|hook|lifecycle|adapter|projection|daemon|framework|architecture)\\b",
    "\\b(multiple|multi[- ]file|cross[- ]cutting|end[- ]to[- ]end|portable|substrate)\\b",
    "\\b(algorithm|isa|ideal state|criteria|verification|harness|pai|soma)\\b",
  ],

  /** Ordered: first match wins. Applied to the LOWERCASED prompt, so no `i` flag. */
  tierRules: [
    { tier: "E5", pattern: "\\b(comprehensive|no time pressure|exhaustive|full migration|whole system)\\b" },
    { tier: "E4", pattern: "\\b(deep|architecture|doctrine|cross-cutting|security model|policy enforcement)\\b" },
    { tier: "E3", pattern: "\\b(substantial|multi[- ]file|multiple files|migration|port|adapter|daemon|framework|bootstrap|refactor)\\b" },
    {
      tier: "E2",
      pattern: "\\b(thorough|quality|structured|workflow|harness|criteria|verify|tests?|clear reasoning|implications?|(?:telos|purpose)[- ]aligned|surprising|strategy)\\b",
    },
  ],
  defaultTier: "E1",
} as const;

const EXPLICIT_EFFORT = new RegExp(ALGORITHM_CLASSIFIER_CONTRACT.explicitEffortPattern, "i");

const MINIMAL_PROMPTS = new Set<string>(ALGORITHM_CLASSIFIER_CONTRACT.minimalPrompts);

const NATIVE_PATTERNS = ALGORITHM_CLASSIFIER_CONTRACT.nativePatterns.map((source) => new RegExp(source, "i"));

const ALGORITHM_PATTERNS = ALGORITHM_CLASSIFIER_CONTRACT.algorithmPatterns.map((source) => new RegExp(source, "i"));

const TIER_RULES: { tier: AlgorithmEffortTier; pattern: RegExp }[] = ALGORITHM_CLASSIFIER_CONTRACT.tierRules.map((rule) => ({
  tier: rule.tier,
  pattern: new RegExp(rule.pattern),
}));

function explicitEffort(prompt: string): AlgorithmEffortTier | undefined {
  const match = EXPLICIT_EFFORT.exec(prompt);
  if (!match) return undefined;

  return `E${match[1]}` as AlgorithmEffortTier;
}

function classifyAlgorithmTier(prompt: string): AlgorithmEffortTier {
  const text = prompt.toLowerCase();

  for (const rule of TIER_RULES) {
    if (rule.pattern.test(text)) return rule.tier;
  }

  return ALGORITHM_CLASSIFIER_CONTRACT.defaultTier;
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

  if (NATIVE_PATTERNS.some((pattern) => pattern.test(text)) && text.length < ALGORITHM_CLASSIFIER_CONTRACT.nativeMaxLength) {
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
