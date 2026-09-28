import { createHash } from "node:crypto";

/**
 * The router's combiner: a multinomial logistic regression over a fixed feature
 * vector (question probabilities, embeddings, plain features — whatever the arm
 * feeds it). It is the §6 "Combiner" of the front-door router plan, shared by
 * every arm, so its weights are plain JSON data that can ship in the contract
 * the way today's regex patterns do (R2).
 *
 * Training is deterministic by construction: zero initialisation, full-batch
 * gradient descent, a fixed iteration count and a fixed summation order. The
 * same examples always give the same model, byte for byte, so a score can be
 * pinned by a test (L6).
 *
 * Design: Plans/2026-09-28-front-door-router-design.md (§5, §6, step 4).
 */

export interface CombinerOptions {
  iterations?: number;
  learningRate?: number;
  /** L2 penalty on the weights (never on the bias). */
  l2?: number;
}

export const COMBINER_DEFAULTS: Required<CombinerOptions> = { iterations: 300, learningRate: 0.5, l2: 0.01 };

export interface CombinerModel {
  kind: "multinomial-logistic";
  v: 1;
  classes: string[];
  dimensions: number;
  /** Per-feature standardisation fitted on the training examples. */
  featureMean: number[];
  featureScale: number[];
  /** One row of `dimensions` weights per class, in `classes` order. */
  weights: number[][];
  bias: number[];
  options: Required<CombinerOptions>;
}

export interface CombinerExample {
  /** Folds split on this, so no session is ever both trained and scored on (L6). */
  session: string;
  features: number[];
  label: string;
}

function standardisation(rows: number[][], dimensions: number): { mean: number[]; scale: number[] } {
  const mean = new Array<number>(dimensions).fill(0);
  const scale = new Array<number>(dimensions).fill(0);
  for (const row of rows) for (let d = 0; d < dimensions; d += 1) mean[d] += row[d];
  for (let d = 0; d < dimensions; d += 1) mean[d] /= rows.length;
  for (const row of rows) for (let d = 0; d < dimensions; d += 1) scale[d] += (row[d] - mean[d]) ** 2;
  // A constant feature gets scale 1, so it standardises to 0 instead of dividing by 0.
  for (let d = 0; d < dimensions; d += 1) scale[d] = Math.sqrt(scale[d] / rows.length) || 1;
  return { mean, scale };
}

function softmaxInPlace(logits: Float64Array): void {
  let max = -Infinity;
  for (const value of logits) if (value > max) max = value;
  let sum = 0;
  for (let k = 0; k < logits.length; k += 1) {
    logits[k] = Math.exp(logits[k] - max);
    sum += logits[k];
  }
  for (let k = 0; k < logits.length; k += 1) logits[k] /= sum;
}

/**
 * `classes` fixes the output order and may name classes absent from `examples`
 * (a fold can miss a rare class); training only ever pushes such a class's
 * probability down, so it is effectively never predicted.
 */
export function trainCombiner(examples: readonly CombinerExample[], classes: readonly string[], options: CombinerOptions = {}): CombinerModel {
  if (examples.length === 0) throw new Error("trainCombiner needs at least one example.");
  const resolved = { ...COMBINER_DEFAULTS, ...options };
  const dimensions = examples[0].features.length;
  const classIndex = new Map(classes.map((name, index) => [name, index]));
  for (const example of examples) {
    if (example.features.length !== dimensions) throw new Error(`Feature length ${example.features.length} does not match ${dimensions}.`);
    if (!classIndex.has(example.label)) throw new Error(`Label ${JSON.stringify(example.label)} is not one of the classes.`);
  }

  const { mean, scale } = standardisation(examples.map((example) => example.features), dimensions);
  const n = examples.length;
  const k = classes.length;
  const x = examples.map((example) => Float64Array.from(example.features, (value, d) => (value - mean[d]) / scale[d]));
  const y = examples.map((example) => classes.indexOf(example.label));

  const weights = new Float64Array(k * dimensions);
  const bias = new Float64Array(k);
  const gradW = new Float64Array(k * dimensions);
  const gradB = new Float64Array(k);
  const p = new Float64Array(k);

  for (let iteration = 0; iteration < resolved.iterations; iteration += 1) {
    gradW.fill(0);
    gradB.fill(0);
    for (let i = 0; i < n; i += 1) {
      const xi = x[i];
      for (let c = 0; c < k; c += 1) {
        let logit = bias[c];
        const offset = c * dimensions;
        for (let d = 0; d < dimensions; d += 1) logit += weights[offset + d] * xi[d];
        p[c] = logit;
      }
      softmaxInPlace(p);
      p[y[i]] -= 1;
      for (let c = 0; c < k; c += 1) {
        const error = p[c];
        gradB[c] += error;
        const offset = c * dimensions;
        for (let d = 0; d < dimensions; d += 1) gradW[offset + d] += error * xi[d];
      }
    }
    for (let j = 0; j < weights.length; j += 1) weights[j] -= resolved.learningRate * (gradW[j] / n + resolved.l2 * weights[j]);
    for (let c = 0; c < k; c += 1) bias[c] -= resolved.learningRate * (gradB[c] / n);
  }

  return {
    kind: "multinomial-logistic",
    v: 1,
    classes: [...classes],
    dimensions,
    featureMean: mean,
    featureScale: scale,
    weights: classes.map((_, c) => Array.from(weights.subarray(c * dimensions, (c + 1) * dimensions))),
    bias: Array.from(bias),
    options: resolved,
  };
}

/** Class probabilities, in `model.classes` order. */
export function predictCombiner(model: CombinerModel, features: readonly number[]): number[] {
  if (features.length !== model.dimensions) throw new Error(`Feature length ${features.length} does not match ${model.dimensions}.`);
  const logits = new Float64Array(model.classes.length);
  for (let c = 0; c < model.classes.length; c += 1) {
    let logit = model.bias[c];
    const row = model.weights[c];
    for (let d = 0; d < model.dimensions; d += 1) logit += row[d] * ((features[d] - model.featureMean[d]) / model.featureScale[d]);
    logits[c] = logit;
  }
  softmaxInPlace(logits);
  return Array.from(logits);
}

export function argmaxClass(model: CombinerModel, probabilities: readonly number[]): string {
  let best = 0;
  for (let c = 1; c < probabilities.length; c += 1) if (probabilities[c] > probabilities[best]) best = c;
  return model.classes[best];
}

/**
 * Assign every session to one of `k` folds. Sessions are ordered by a seeded
 * hash and dealt round-robin, so fold sizes differ by at most one session and
 * the split does not depend on input order.
 */
export function sessionFolds(sessions: readonly string[], k: number, seed = "router-folds-v1"): Map<string, number> {
  if (!Number.isInteger(k) || k < 2) throw new Error("Fold count must be an integer of at least 2.");
  const unique = [...new Set(sessions)];
  if (unique.length < k) throw new Error(`Need at least ${k} sessions for ${k} folds, found ${unique.length}.`);
  const hashed = unique
    .map((session) => ({ session, hash: createHash("sha256").update(`${seed}\0${session}`).digest("hex") }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return new Map(hashed.map((entry, index) => [entry.session, index % k]));
}

export interface CrossValidationResult {
  classes: string[];
  folds: { fold: number; examples: number; correct: number }[];
  examples: number;
  correct: number;
  accuracy: number;
  /** confusion[truth][predicted] */
  confusion: Record<string, Record<string, number>>;
  /** Accuracy of always answering the training fold's most frequent label. */
  majorityAccuracy: number;
}

export function crossValidateCombiner(
  examples: readonly CombinerExample[],
  options: CombinerOptions & { folds?: number; seed?: string; classes?: readonly string[] } = {},
): CrossValidationResult {
  const classes = options.classes ? [...options.classes] : [...new Set(examples.map((example) => example.label))].sort();
  const foldOf = sessionFolds(examples.map((example) => example.session), options.folds ?? 5, options.seed);
  const k = options.folds ?? 5;
  const confusion = Object.fromEntries(classes.map((truth) => [truth, Object.fromEntries(classes.map((predicted) => [predicted, 0]))]));
  const folds: CrossValidationResult["folds"] = [];
  let majorityCorrect = 0;

  for (let fold = 0; fold < k; fold += 1) {
    const train = examples.filter((example) => foldOf.get(example.session) !== fold);
    const test = examples.filter((example) => foldOf.get(example.session) === fold);
    const model = trainCombiner(train, classes, options);
    const counts = new Map<string, number>();
    for (const example of train) counts.set(example.label, (counts.get(example.label) ?? 0) + 1);
    const majority = classes.reduce((best, name) => ((counts.get(name) ?? 0) > (counts.get(best) ?? 0) ? name : best), classes[0]);
    let correct = 0;
    for (const example of test) {
      const predicted = argmaxClass(model, predictCombiner(model, example.features));
      confusion[example.label][predicted] += 1;
      if (predicted === example.label) correct += 1;
      if (majority === example.label) majorityCorrect += 1;
    }
    folds.push({ fold, examples: test.length, correct });
  }

  const correct = folds.reduce((sum, fold) => sum + fold.correct, 0);
  return {
    classes,
    folds,
    examples: examples.length,
    correct,
    accuracy: correct / examples.length,
    confusion,
    majorityAccuracy: majorityCorrect / examples.length,
  };
}
