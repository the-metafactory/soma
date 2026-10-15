import { expect, test } from "bun:test";
import { grownRules, ruleTotals } from "../scripts/check-suppressions";

const rule = "soma/no-discarded-error";

test("suppressed totals are per rule, so a moved file keeps passing", () => {
  const base = { "src/a.ts": { [rule]: { count: 2 } } };
  const moved = { "src/core/a.ts": { [rule]: { count: 2 } } };
  expect(ruleTotals(moved)).toEqual({ [rule]: 2 });
  expect(grownRules(moved, base)).toEqual([]);
});

test("a suppression added on top of the base fails; a pruned one passes", () => {
  const base = { "src/a.ts": { [rule]: { count: 2 } } };
  expect(grownRules({ "src/a.ts": { [rule]: { count: 2 } }, "src/b.ts": { [rule]: { count: 1 } } }, base)).toEqual([{ rule, base: 2, current: 3 }]);
  expect(grownRules({ "src/a.ts": { [rule]: { count: 1 } } }, base)).toEqual([]);
});
