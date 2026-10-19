import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";

const CLOSING = join(import.meta.dir, "..", "src", "skills", "orienteer", "references", "closing.md");
const CANONICAL_CLONE = "/Users/fischer/work/ranger-repos/the-metafactory/soma";

test("closing.md tells charting agents to probe the merged base with bun run test in the canonical clone", async () => {
  const text = await readFile(CLOSING, "utf8");
  const probeLine = text.split("\n").find((line) => line.startsWith('{"type": "command"'));
  expect(probeLine).toBeDefined();
  expect(JSON.parse(probeLine as string)).toEqual({
    type: "command",
    run: "bun run test",
    cwd: CANONICAL_CLONE,
    timeoutSec: 1800,
    expectExit: 0,
  });
  expect(text).toContain("never a bare `bun test`");
  expect(text).toContain("per-test timeout");
  expect(text).toContain("merged base");
});

test("closing.md says a working checkout cwd is the charting agent's to avoid and who owns the install", async () => {
  const text = await readFile(CLOSING, "utf8");
  expect(text).toContain("Never name a working checkout");
  expect(text).toContain("charting agent's job");
  expect(text).toContain("ranger's job");
  expect(text).toContain("bun install --frozen-lockfile");
});
