import { expect, test } from "bun:test";
import { grownSuppressions } from "../scripts/check-suppressions";

const rule = "soma/no-discarded-error";

test("a suppression added on top of the base fails; a pruned one passes", () => {
  const base = { "src/a.ts": { [rule]: { count: 2 } } };
  expect(grownSuppressions({ "src/a.ts": { [rule]: { count: 3 } } }, base)).toEqual([{ file: "src/a.ts", rule, base: 2, current: 3 }]);
  expect(grownSuppressions({ "src/a.ts": { [rule]: { count: 1 } } }, base)).toEqual([]);
});

test("fixing one file does not pay for a new suppression in another", () => {
  const base = { "src/a.ts": { [rule]: { count: 2 } } };
  const traded = { "src/a.ts": { [rule]: { count: 1 } }, "src/b.ts": { [rule]: { count: 1 } } };
  expect(grownSuppressions(traded, base)).toEqual([{ file: "src/b.ts", rule, base: 0, current: 1 }]);
});

test("a file Git renamed keeps its base count", () => {
  const base = { "src/a.ts": { [rule]: { count: 2 } } };
  const moved = { "src/core/a.ts": { [rule]: { count: 2 } } };
  expect(grownSuppressions(moved, base, new Map([["src/a.ts", "src/core/a.ts"]]))).toEqual([]);
  expect(grownSuppressions(moved, base)).toHaveLength(1);
});
