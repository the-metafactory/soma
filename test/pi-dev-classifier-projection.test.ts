import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { classifyAlgorithmPrompt } from "../src/algorithm-classifier";
import { renderAlgorithmClassifierSource } from "../src/adapters/shared/algorithm-classifier-source";

/**
 * soma#475: the pi-dev extension classifies prompts locally instead of shelling
 * out to `soma algorithm classify`. That removes a 1-3s bun cold-start from
 * every message, but creates a second copy of the classifier. These tests are
 * the drift guard: the projected copy must agree with the runtime function.
 */

/** Prompts chosen to hit every branch: fail-safe, explicit, minimal, native, and each tier. */
const CORPUS = [
  "",
  "   ",
  "ok",
  "Okay!",
  "thanks.",
  "great that works nicely",
  "do it",
  "go for it",
  "sounds good",
  "what's next",
  "what is this thing",
  "who was responsible",
  "what time is it",
  "how does this work",
  "run the tests",
  "execute the lint script",
  "read the file output",
  "summarize the log",
  "fix the typo in one line",
  "rename the single line",
  "check the diff status",
  "is that installed",
  "does that work",
  "what did you change",
  "build a new adapter",
  "create the projection",
  "refactor the projection layer",
  "design the doctrine",
  "implement a comprehensive migration of the whole system",
  "an exhaustive review with no time pressure",
  "deep architecture review",
  "the security model and policy enforcement",
  "substantial multi-file port",
  "bootstrap the daemon framework",
  "thorough workflow with verification criteria",
  "clear reasoning about purpose-aligned strategy",
  "e3 do the thing",
  "/e5 exhaustive",
  "E1 quick",
  "please do e2 work",
  "e9 not a tier",
  "migrate the daemon framework end-to-end across substrates",
  "identify the implications for purpose-aligned strategy",
  "Soma memory harness pai isa ideal state criteria",
  "review the PR that this branch made",
  "abort the whole thing and start over",
  // Length boundary: native patterns only apply below nativeMaxLength (180).
  `what is this ${"b".repeat(200)}`,
  `${"a".repeat(200)} what is this`,
  // Case and punctuation normalisation.
  "OK, THANKS!",
  "That works.",
];

async function loadProjectedClassifier(): Promise<(prompt: string) => unknown> {
  const dir = await mkdtemp(join(tmpdir(), "soma-classifier-projection-"));
  const file = join(dir, "projected-classifier.ts");
  await writeFile(file, `${renderAlgorithmClassifierSource()}\nexport { classifyAlgorithmPrompt };\n`, "utf8");

  try {
    const loaded = (await import(file)) as { classifyAlgorithmPrompt: (prompt: string) => unknown };
    return loaded.classifyAlgorithmPrompt;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("projected classifier source is valid TypeScript", () => {
  const source = renderAlgorithmClassifierSource();

  expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
});

test("projected classifier matches the runtime classifier across the corpus", async () => {
  const projected = await loadProjectedClassifier();

  for (const prompt of CORPUS) {
    expect(projected(prompt)).toEqual(classifyAlgorithmPrompt(prompt) as unknown as Record<string, unknown>);
  }
});

test("projected classifier serialises the pattern set rather than retyping it", () => {
  const source = renderAlgorithmClassifierSource();

  // If a pattern is ever hand-copied into the renderer, this is the tripwire:
  // the sources must arrive via ALGORITHM_CLASSIFIER_CONTRACT, so a contract
  // edit alone changes the projected output.
  expect(source).toContain("ideal state|criteria|verification|harness|pai|soma");
  expect(source).toContain("no time pressure");
  expect(source).toContain("great that works nicely");
});

test("classification needs no subprocess — the whole point of soma#475", () => {
  const source = renderAlgorithmClassifierSource();

  expect(source).not.toContain("spawn");
  expect(source).not.toContain("execFile");
  expect(source).not.toContain("algorithm\", \"classify");
});
