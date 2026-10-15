import { expect, test } from "bun:test";
import { grownSuppressions, inlineDirectiveCounts } from "../scripts/check-suppressions";

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

test("inline directives that disable a ratcheted rule, or every rule, are counted", () => {
  const text = [
    "// eslint-disable-next-line soma/no-discarded-error -- reason",
    "try { f(); } catch { /* eslint-disable-line soma/no-discarded-error */ }",
    "// eslint-disable-next-line",
    "/* eslint-disable */",
    "// eslint-disable-next-line @typescript-eslint/no-explicit-any -- unrelated rule",
    "// eslint-enable soma/no-discarded-error",
  ].join("\n");
  expect(inlineDirectiveCounts(text)).toEqual({
    [`inline:${rule}`]: { count: 2 },
    "inline:all-rules": { count: 2 },
  });
});

test("a new inline disable grows the file's count like a bulk suppression", () => {
  const base = { "src/a.ts": inlineDirectiveCounts("") };
  const current = { "src/a.ts": inlineDirectiveCounts(`// eslint-disable-next-line ${rule} -- swallow`) };
  expect(grownSuppressions(current, base)).toEqual([{ file: "src/a.ts", rule: `inline:${rule}`, base: 0, current: 1 }]);
});
