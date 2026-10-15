import { describe, expect, test } from "bun:test";
import { baselineOf, collectLiteralLists, compareWithBaseline, findDuplicateSets } from "../scripts/check-literal-sets";

function duplicates(files: Record<string, string>) {
  return findDuplicateSets(Object.entries(files).flatMap(([file, text]) => collectLiteralLists(file, text)));
}

describe("check-literal-sets", () => {
  test("a union and an as-const array with the same members are one duplicate", () => {
    // The #856 shape: GoalStatus in types.ts, GOAL_STATUSES in goal-records.ts.
    const found = duplicates({
      "src/types.ts": `export type GoalStatus = "draft" | "active" | "paused" | "achieved" | "dropped";`,
      "src/goal-records.ts": `export const GOAL_STATUSES = ["draft", "active", "paused", "achieved", "dropped"] as const;`,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.map((list) => list.file)).toEqual(["src/types.ts", "src/goal-records.ts"]);
  });

  test("a union inside Extract<…> and a set literal count; a derived type does not", () => {
    const found = duplicates({
      "a.ts": `type A = Extract<SubstrateId, "codex" | "grok" | "dsh">;`,
      "b.ts": `const B = new Set(["dsh", "codex", "grok"]);`,
      "c.ts": `const C = ["codex", "grok", "dsh"] as const; type D = (typeof C)[number];`,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.map((list) => list.file).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("two-member pairs, Pick keys and plain arrays are not counted", () => {
    const found = duplicates({
      "a.ts": `type A = "pass" | "fail"; type P = Pick<X, "homeDir" | "somaHome" | "cwd">; const argv = ["run", "soma", "x"];`,
      "b.ts": `type B = "fail" | "pass"; type Q = Pick<Y, "homeDir" | "somaHome" | "cwd">; const more = ["run", "soma", "x"];`,
    });
    expect(found).toEqual([]);
  });

  test("the allow marker exempts a deliberate coincidence", () => {
    const found = duplicates({
      "a.ts": `type A = "red" | "green" | "blue";`,
      "b.ts": `// literal-set-allow: traffic colours, unrelated to A\ntype B = "red" | "green" | "blue";`,
    });
    expect(found).toEqual([]);
  });

  test("the baseline admits known copies, fails a new one, and may only shrink", () => {
    const known = duplicates({
      "a.ts": `type A = "x" | "y" | "z";`,
      "b.ts": `type B = "x" | "y" | "z";`,
    });
    const baseline = baselineOf(known);
    expect(baseline).toEqual({ "x|y|z": 2 });
    expect(compareWithBaseline(known, baseline, baseline)).toEqual({ added: [], stale: [], raised: [] });

    const third = duplicates({
      "a.ts": `type A = "x" | "y" | "z";`,
      "b.ts": `type B = "x" | "y" | "z";`,
      "c.ts": `const C = ["z", "y", "x"] as const;`,
    });
    expect(compareWithBaseline(third, baseline, baseline).added).toHaveLength(1);

    expect(compareWithBaseline([], baseline, baseline).stale).toEqual(["x|y|z"]);
    expect(compareWithBaseline(third, baselineOf(third), baseline).raised).toEqual(["x|y|z"]);
  });
});
