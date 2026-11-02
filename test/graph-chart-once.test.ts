import { expect, test } from "bun:test";
import { parseGraphArgs } from "../src/cli/graph";
import { CHART, LABEL, MARKER, onceFixture } from "./fixtures/graph-once-store";

const chart = (listed: Parameters<typeof onceFixture>[0] = [], options: Parameters<typeof onceFixture>[1] = {}) => onceFixture(listed, { ...options, command: CHART });
const once = ["--label", LABEL, "--label", "other", "--once", ` ${MARKER} `];
const dryRun = [...once, "--dry-run", "--json"];

test("no marked root: charts one root whose body ends with the marker, scoped to the first label", async () => {
  const fx = chart([{ id: "5", author: "someone-else", body: MARKER }]);
  expect(JSON.parse(await fx.run([...once, "--body", "words\n", "--json"]))).toEqual({ repo: "the-metafactory/soma", node: "900", existing: false });
  expect(fx.created).toHaveLength(1);
  expect(fx.created[0]?.body).toBe(`words\n\n${MARKER}`);
  expect(fx.created[0]?.parent).toBeUndefined();
  expect(fx.listedLabels).toEqual([LABEL]);
  expect(fx.listedAuthors).toEqual(["Ivy-Bot"]);
});

test("the marker is the whole body when none is given", async () => {
  const fx = chart();
  expect(await fx.run(once)).toBe("Created typed graph root 900 (the-metafactory/soma).");
  expect(fx.created[0]?.body).toBe(MARKER);
});

test("one marked root: charts nothing and prints it with existing true", async () => {
  const fx = chart([{ id: "77", author: "ivy-bot", body: `words\r\n\r\n${MARKER}\r\n` }]);
  expect(JSON.parse(await fx.run([...once, "--json"]))).toEqual({ repo: "the-metafactory/soma", node: "77", existing: true });
  expect(await fx.run(once)).toBe(`Root 77 already carries ${MARKER} (the-metafactory/soma); nothing new charted.`);
  expect(fx.created).toEqual([]);
  expect(fx.attached).toEqual([]);
});

test("a marker by another author or not on the last line is ignored", async () => {
  const fx = chart([
    { id: "1", author: "intruder", body: MARKER },
    { id: "2", author: "ivy-bot", body: `${MARKER}\nmore words` },
  ]);
  expect(JSON.parse(await fx.run([...once, "--json"]))).toMatchObject({ node: "900", existing: false });
  expect(fx.created).toHaveLength(1);
});

test("two marked roots refuse with the --once ambiguity message and chart nothing", async () => {
  const listed = [{ id: "9", author: "ivy-bot", body: MARKER }, { id: "10", author: "ivy-bot", body: `x\n${MARKER}` }];
  const plain = chart(listed);
  const error = await plain.failure(once);
  expect(error.exitCode).toBe(1);
  expect(error.message).toBe(`nodes #9, #10 all carry ${MARKER}; nothing more is filed`);
  const json = chart(listed);
  expect(JSON.parse((await json.failure([...once, "--json"])).message)).toEqual({ error: "once-ambiguous", marker: MARKER, nodes: ["9", "10"] });
  const dry = chart(listed);
  expect(JSON.parse((await dry.failure(dryRun)).message)).toEqual({ error: "once-ambiguous", marker: MARKER, nodes: ["9", "10"] });
  expect([...plain.created, ...json.created, ...dry.created]).toEqual([]);
});

test("--dry-run reports the marked root, or found false, and writes nothing", async () => {
  const found = chart([{ id: "77", author: "ivy-bot", body: MARKER }]);
  expect(JSON.parse(await found.run([...dryRun, "--body-file", "/nonexistent/body.md"]))).toEqual({ found: true, repo: "the-metafactory/soma", node: "77", parent: null });
  const missing = chart([{ id: "1", author: "intruder", body: MARKER }]);
  expect(JSON.parse(await missing.run(dryRun))).toEqual({ found: false });
  expect([...found.created, ...missing.created]).toEqual([]);
  expect([...found.attached, ...missing.attached]).toEqual([]);
});

test("a listing that fails, or a store that cannot list, refuses and charts nothing", async () => {
  for (const listed of ["fails", "unsupported"] as const) {
    for (const args of [once, dryRun]) {
      const fx = chart(listed);
      const error = await fx.failure(args);
      expect(error.exitCode).toBe(1);
      expect(error.message).toContain("soma graph chart --once refused");
      expect(fx.created).toEqual([]);
    }
  }
});

test("--once without --label and --dry-run without --once are usage errors, as on add", () => {
  const bare = [...CHART, "--title", "t", "--autonomy", "propose", "--checkpoint", "cp"];
  expect(() => parseGraphArgs([...bare, "--once", MARKER])).toThrow("soma graph chart --once needs a --label: the first label scopes the marker lookup.");
  expect(() => parseGraphArgs([...bare, "--label", LABEL, "--dry-run"])).toThrow(/soma graph chart --dry-run needs --once/u);
  expect(() => parseGraphArgs([...bare, "--label", LABEL, "--once", "a\nb"])).toThrow(/one line of 1-300/u);
});

test("without --once the chart output keeps its shape and nothing is listed", async () => {
  const fx = chart();
  expect(Object.keys(JSON.parse(await fx.run(["--label", LABEL, "--json"])) as object)).toEqual(["repo", "node"]);
  expect(fx.listedLabels).toEqual([]);
});
