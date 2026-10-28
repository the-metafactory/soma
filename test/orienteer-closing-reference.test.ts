import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { isFullSuiteCommand } from "../src/graph/full-suite-probe";

const CLOSING = join(import.meta.dir, "..", "src", "skills", "orienteer", "references", "closing.md");

async function declaredCommandProbes(): Promise<Record<string, unknown>[]> {
  const text = await readFile(CLOSING, "utf8");
  return text
    .split("\n")
    .filter((line) => line.startsWith('{"type": "command"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("closing.md tells charting agents to declare the cheap type check against the canonical clone", async () => {
  const probes = await declaredCommandProbes();
  expect(probes).toHaveLength(1);
  expect(probes[0]).toEqual({
    type: "command",
    run: "bunx tsc --noEmit",
    cwd: expect.stringMatching(/^\//),
    timeoutSec: 300,
    expectExit: 0,
  });
  const text = await readFile(CLOSING, "utf8");
  expect(text).toContain("as configured on this installation");
  expect(text).toContain("merged base");
});

test("closing.md declares no full-suite command probe and does not prescribe the 1800 s timeout", async () => {
  const text = await readFile(CLOSING, "utf8");
  for (const probe of await declaredCommandProbes()) {
    expect(isFullSuiteCommand(String(probe.run))).toBe(false);
  }
  expect(text).not.toContain("1800");
  expect(text).not.toContain("`run` is `bun run test`");
  expect(text).toContain("Never declare the full suite");
});

test("closing.md says the full-suite evidence comes from the --ci citation, not from a probe", async () => {
  const text = (await readFile(CLOSING, "utf8")).replace(/\s+/gu, " ");
  expect(text).toContain("supervisor runs it on the branch");
  expect(text).toContain("CI runs it on");
  expect(text).toContain("--ci <checkRunId>@<headSha>");
  expect(text).toContain("it comes from the `--ci` citation of the suite job");
  expect(text).toContain("does not check which job the");
  expect(text).toContain("nothing enforces that choice");
  expect(text).not.toContain("what the cited check run already proves");
  expect(text).toContain("open with a full-suite command probe");
});

test("closing.md says a working checkout cwd is the charting agent's to avoid and who owns the install", async () => {
  const text = await readFile(CLOSING, "utf8");
  expect(text).toContain("Never name a working checkout");
  expect(text).toContain("charting agent's job");
  expect(text).toContain("ranger's job");
  expect(text).toContain("bun install --frozen-lockfile");
});

test("isFullSuiteCommand names whole-suite runs and spares targeted ones", () => {
  for (const run of ["bun run test", "bun test", "bun test --timeout=60000", "bun test --bail", "npm test", "pnpm run test", "yarn test --bail"]) {
    expect(isFullSuiteCommand(run)).toBe(true);
  }
  for (const run of ["bunx tsc --noEmit", "bun test test/graph/work-graph-probes.test.ts", "bun run test test/a.test.ts", "bun test --test-name-pattern=smoke", "bun test -t smoke", "bun run test --changed", "bun test --only", "bun run typecheck", "bun run build", ""]) {
    expect(isFullSuiteCommand(run)).toBe(false);
  }
});
