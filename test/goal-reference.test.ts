import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { warnServes } from "../src/goal-reference";
import { parseVsa } from "../src/vsa/vsa-parse";
import { readVsa } from "../src/vsa/vsa";
import { parseNodeSpec } from "../src/work-graph";

test("serves probes records in the supplied soma-home without leaking wording", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-serves-"));
  const warnings: string[] = [];
  const options = { somaHome, warn: (message: string) => warnings.push(message) };
  try {
    const goals = join(somaHome, "profile", "goals");
    await mkdir(goals, { recursive: true });
    for (const status of ["active", "draft", "paused", "dropped", "achieved"]) {
      await writeFile(join(goals, "G5.md"), `---\nid: G5\nstatus: ${status}\n---\nPrivate wording stays home.\n`);
      warnings.length = 0;
      expect(parseVsa("---\nserves: G5\n---\n", undefined, options).frontmatter.serves).toBe("G5");
      expect(warnings).toHaveLength(status === "active" ? 0 : 1);
      if (status !== "active") expect(warnings[0]).toContain(status);
      expect(warnings.join("\n")).not.toContain("Private wording");
    }
    warnings.length = 0;
    warnServes("G9", options);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unknown goal id");
    expect(warnings[0]).toContain("G9");

    await writeFile(join(goals, "G5.md"), "---\nid: G5\nstatus: active\n---\nPrivate wording\n");
    await mkdir(join(somaHome, "vsa"));
    await writeFile(join(somaHome, "vsa", "linked.md"), "---\nserves: G5\n---\n");
    // An active record in the explicit home must be used even if the default
    // home has no such record or has a different status.
    const previous = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      warnings.length = 0;
      expect((await readVsa("linked", { somaHome })).frontmatter.serves).toBe("G5");
      expect(warnings).toEqual([]);
    } finally { console.warn = previous; }
  } finally { await rm(somaHome, { recursive: true, force: true }); }
});

test("failed advisory lookups still parse, warn once and hide error text", () => {
  const warnings: string[] = [];
  const isa = parseVsa("---\nserves: G9\n---\n", undefined, {
    goalStatus: () => { throw new Error("Private file bytes"); }, warn: (message) => warnings.push(message),
  });
  expect(isa.frontmatter.serves).toBe("G9");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("G9");
  expect(warnings[0]).not.toContain("Private file bytes");
});

test("node contract rejects child-owned serves and invalid IDs before persistence", () => {
  const spec = { title: "work", autonomy: "approve", serves: "G5" };
  expect(parseNodeSpec(spec).serves).toBe("G5");
  expect(() => parseNodeSpec({ ...spec, parent: { id: "1" } })).toThrow(/root only.*D10/u);
  expect(() => parseNodeSpec({ ...spec, serves: "g5" })).toThrow(/G<n>/u);
});
