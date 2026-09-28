import { expect, test } from "bun:test";
import {
  type CombinerExample,
  argmaxClass,
  crossValidateCombiner,
  predictCombiner,
  sessionFolds,
  trainCombiner,
} from "../src/router-combiner";

// Deterministic synthetic data: three classes around three centres in 6 dimensions,
// 12 sessions of 10 examples each, plus a constant feature and a pure-noise one.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function synthetic(noise = 2.4): CombinerExample[] {
  const random = lcg(42);
  const centres: Record<string, number[]> = {
    minimal: [1, 0, 0, 0.5],
    native: [0, 1, 0, 0],
    algorithm: [0, 0, 1, -0.5],
  };
  const labels = Object.keys(centres);
  const examples: CombinerExample[] = [];
  for (let session = 0; session < 12; session += 1) {
    for (let i = 0; i < 10; i += 1) {
      const label = labels[(session + i) % 3];
      const features = [...centres[label].map((value) => value + (random() - 0.5) * noise), 3, random()];
      examples.push({ session: `s${session}`, features, label });
    }
  }
  return examples;
}

test("training is deterministic: the same examples give the same model, byte for byte", () => {
  const classes = ["algorithm", "minimal", "native"];
  const first = JSON.stringify(trainCombiner(synthetic(), classes));
  const second = JSON.stringify(trainCombiner(synthetic(), classes));
  expect(second).toBe(first);
});

test("cross-validation score is pinned and beats the majority baseline", () => {
  const result = crossValidateCombiner(synthetic(), { folds: 4 });
  expect(result.classes).toEqual(["algorithm", "minimal", "native"]);
  expect(result.examples).toBe(120);
  // Pinned (L6): a change to training, folds or features must move this on purpose.
  expect(result.correct).toBe(98);
  expect(result.accuracy).toBeGreaterThan(result.majorityAccuracy + 0.4);
  expect(result.folds.reduce((sum, fold) => sum + fold.examples, 0)).toBe(120);
  const confusionTotal = Object.values(result.confusion).flatMap((row) => Object.values(row)).reduce((a, b) => a + b, 0);
  expect(confusionTotal).toBe(120);
});

test("the model is plain JSON: a serialised copy predicts identically", () => {
  const model = trainCombiner(synthetic(), ["algorithm", "minimal", "native"]);
  const copy = JSON.parse(JSON.stringify(model));
  const features = [0.9, 0.1, 0, 0.4, 3, 0.5];
  expect(predictCombiner(copy, features)).toEqual(predictCombiner(model, features));
  expect(argmaxClass(model, predictCombiner(model, features))).toBe("minimal");
  const probabilities = predictCombiner(model, features);
  expect(probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
});

test("a constant feature standardises to zero instead of NaN", () => {
  const model = trainCombiner(synthetic(), ["algorithm", "minimal", "native"]);
  expect(model.featureScale[4]).toBe(1);
  expect(model.weights.flat().every(Number.isFinite)).toBe(true);
});

test("a class absent from training still gets a slot and is never predicted", () => {
  const examples = synthetic().filter((example) => example.label !== "algorithm");
  const model = trainCombiner(examples, ["algorithm", "minimal", "native"]);
  for (const example of examples) expect(argmaxClass(model, predictCombiner(model, example.features))).not.toBe("algorithm");
});

test("training rejects unknown labels and ragged features", () => {
  expect(() => trainCombiner([{ session: "s", features: [1], label: "x" }], ["y"])).toThrow("not one of the classes");
  expect(() =>
    trainCombiner(
      [
        { session: "s", features: [1, 2], label: "y" },
        { session: "s", features: [1], label: "y" },
      ],
      ["y"],
    ),
  ).toThrow("does not match");
});

test("session folds: every session in exactly one fold, balanced, independent of input order", () => {
  const sessions = Array.from({ length: 11 }, (_, index) => `session-${index}`);
  const folds = sessionFolds(sessions, 5);
  expect(folds.size).toBe(11);
  const sizes = [0, 0, 0, 0, 0];
  for (const fold of folds.values()) sizes[fold] += 1;
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  const reversed = sessionFolds([...sessions].reverse(), 5);
  for (const session of sessions) expect(reversed.get(session)).toBe(folds.get(session));
  expect(sessionFolds([...sessions, ...sessions], 5)).toEqual(folds);
});

test("session folds refuse too few sessions or folds", () => {
  expect(() => sessionFolds(["a", "b"], 3)).toThrow("at least 3 sessions");
  expect(() => sessionFolds(["a", "b"], 1)).toThrow("at least 2");
});

test("no session is ever both trained and scored on", () => {
  const examples = synthetic();
  const folds = sessionFolds(examples.map((example) => example.session), 4);
  for (let fold = 0; fold < 4; fold += 1) {
    const train = new Set(examples.filter((example) => folds.get(example.session) !== fold).map((example) => example.session));
    const scored = new Set(examples.filter((example) => folds.get(example.session) === fold).map((example) => example.session));
    for (const session of scored) expect(train.has(session)).toBe(false);
  }
});

test("the default step stays stable on strongly correlated features", () => {
  // Two opposite 32-dimensional points, ten examples each, labels split 80/20 in
  // opposite directions: the best possible training accuracy is 16/20, and the
  // best mean log-loss is the entropy of an 80/20 split, 0.5004. A fixed step of
  // 0.5 overshoots here (Sage, #727): its loss oscillates far above that.
  const a = new Array<number>(32).fill(1);
  const b = new Array<number>(32).fill(-1);
  const examples: CombinerExample[] = [];
  for (let i = 0; i < 10; i += 1) {
    examples.push({ session: `a${i}`, features: a, label: i < 8 ? "x" : "y" });
    examples.push({ session: `b${i}`, features: b, label: i < 8 ? "y" : "x" });
  }
  const trainingCorrect = (model: ReturnType<typeof trainCombiner>): number =>
    examples.filter((example) => argmaxClass(model, predictCombiner(model, example.features)) === example.label).length;
  const meanLogLoss = (model: ReturnType<typeof trainCombiner>): number =>
    examples.reduce((sum, example) => sum - Math.log(predictCombiner(model, example.features)[model.classes.indexOf(example.label)]), 0) / examples.length;
  const entropy = -(0.8 * Math.log(0.8) + 0.2 * Math.log(0.2));
  const model = trainCombiner(examples, ["x", "y"]);
  expect(trainingCorrect(model)).toBe(16);
  expect(model.options.learningRate).toBeGreaterThan(0);
  expect(model.options.learningRate).toBeLessThan(0.5);
  expect(meanLogLoss(model)).toBeCloseTo(entropy, 3);
  expect(meanLogLoss(trainCombiner(examples, ["x", "y"], { learningRate: 0.5 }))).toBeGreaterThan(entropy + 1);
});
