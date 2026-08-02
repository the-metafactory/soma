import { ALGORITHM_CLASSIFIER_CONTRACT } from "../../algorithm-classifier";

/**
 * Renders the Soma prompt classifier as standalone source for projection into a
 * generated substrate extension (soma#475).
 *
 * Why this exists: classifyAlgorithmPrompt is pure and synchronous — no I/O, no
 * async. Shelling out to `soma algorithm classify` to run a regex match cost
 * 1-3s of bun cold-start on every message and was the larger half of the pi-dev
 * freeze. Projecting the logic makes classification ~0ms and, critically, lets
 * it stay correct for the CURRENT prompt rather than being deferred a turn.
 *
 * Drift control follows renderFeedbackHookHelper (./feedback-helper.ts:23):
 * the pattern set is NOT retyped here — it is serialised from the single source
 * of truth, ALGORITHM_CLASSIFIER_CONTRACT. Only the branching logic is emitted
 * as text, and test/pi-dev-classifier-projection.test.ts asserts the projected
 * copy and the runtime function agree across a prompt corpus.
 */
export function renderAlgorithmClassifierSource(): string {
  const contract = ALGORITHM_CLASSIFIER_CONTRACT;

  return [
    "// ── Soma prompt classifier (projected from src/algorithm-classifier.ts) ──",
    "// Pure and synchronous: no subprocess, no I/O. Patterns are serialised from",
    "// ALGORITHM_CLASSIFIER_CONTRACT so they cannot drift from the Soma runtime.",
    `const SOMA_EXPLICIT_EFFORT = new RegExp(${JSON.stringify(contract.explicitEffortPattern)}, "i");`,
    `const SOMA_MINIMAL_PROMPTS = new Set(${JSON.stringify(contract.minimalPrompts)});`,
    `const SOMA_NATIVE_PATTERNS = ${JSON.stringify(contract.nativePatterns)}.map((source) => new RegExp(source, "i"));`,
    `const SOMA_NATIVE_MAX_LENGTH = ${contract.nativeMaxLength};`,
    `const SOMA_ALGORITHM_PATTERNS = ${JSON.stringify(contract.algorithmPatterns)}.map((source) => new RegExp(source, "i"));`,
    `const SOMA_TIER_RULES = ${JSON.stringify(contract.tierRules.map((rule) => [rule.tier, rule.pattern]))}.map(([tier, pattern]) => ({ tier, pattern: new RegExp(pattern) }));`,
    `const SOMA_DEFAULT_TIER = ${JSON.stringify(contract.defaultTier)};`,
    "",
    "function somaExplicitEffort(prompt: string): string | undefined {",
    "\tconst match = SOMA_EXPLICIT_EFFORT.exec(prompt);",
    "\tif (!match) return undefined;",
    "\treturn `E${match[1]}`;",
    "}",
    "",
    "function somaClassifyTier(prompt: string): string {",
    "\tconst text = prompt.toLowerCase();",
    "\tfor (const rule of SOMA_TIER_RULES) {",
    "\t\tif (rule.pattern.test(text)) return rule.tier;",
    "\t}",
    "\treturn SOMA_DEFAULT_TIER;",
    "}",
    "",
    "function somaClassifyMode(prompt: string): string {",
    "\tconst text = prompt.trim();",
    "\tconst normalized = text",
    "\t\t.toLowerCase()",
    '\t\t.replace(/[.!?,\'"]/g, "")',
    '\t\t.replace(/\\s+/g, " ")',
    "\t\t.trim();",
    '\tif (SOMA_MINIMAL_PROMPTS.has(normalized)) return "minimal";',
    '\tif (SOMA_NATIVE_PATTERNS.some((pattern) => pattern.test(text)) && text.length < SOMA_NATIVE_MAX_LENGTH) return "native";',
    '\tif (SOMA_ALGORITHM_PATTERNS.some((pattern) => pattern.test(text))) return "algorithm";',
    '\treturn "algorithm";',
    "}",
    "",
    "function classifyAlgorithmPrompt(prompt: string): { mode: string; effort?: string; source: string; reason: string } {",
    "\tconst text = prompt.trim();",
    "",
    "\tif (text.length === 0) {",
    "\t\treturn {",
    '\t\t\tmode: "algorithm",',
    '\t\t\teffort: "E3",',
    '\t\t\tsource: "fail-safe",',
    '\t\t\treason: "Empty prompt cannot be classified safely; defaulting to Algorithm E3.",',
    "\t\t};",
    "\t}",
    "",
    "\tconst override = somaExplicitEffort(text);",
    "\tif (override) {",
    "\t\treturn {",
    '\t\t\tmode: "algorithm",',
    "\t\t\teffort: override,",
    '\t\t\tsource: "explicit",',
    "\t\t\treason: `Explicit ${override} override in prompt.`,",
    "\t\t};",
    "\t}",
    "",
    "\tconst mode = somaClassifyMode(text);",
    "",
    '\tif (mode !== "algorithm") {',
    "\t\treturn {",
    "\t\t\tmode,",
    '\t\t\tsource: "auto",',
    '\t\t\treason: mode === "minimal" ? "Prompt is a minimal acknowledgement." : "Prompt can be handled by the native substrate without Algorithm harness.",',
    "\t\t};",
    "\t}",
    "",
    "\tconst effort = somaClassifyTier(text);",
    "",
    "\treturn {",
    "\t\tmode,",
    "\t\teffort,",
    '\t\tsource: "auto",',
    "\t\treason: `Prompt shape maps to Algorithm ${effort}.`,",
    "\t};",
    "}",
  ].join("\n");
}
