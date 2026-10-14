import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGoalResources, parseGoalResources, resolveGoalResource } from "../src/goal-resources";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";

const roots: string[] = [];
const SECRET = "https://private.example.test/secret-token";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-resources-"));
  roots.push(somaHome);
  await mkdir(join(somaHome, "profile"));
  return { somaHome, file: join(somaHome, "profile", "resources.yaml") };
}

test("resources load and resolve by both name and type", async () => {
  const f = await fixture();
  await writeFile(f.file, `- name: blog\n  type: feed\n  value: ${SECRET}\n- name: blog\n  type: tag\n  value: writing\n`);
  const resources = await loadGoalResources({ somaHome: f.somaHome });
  expect(resources).toHaveLength(2);
  expect(resolveGoalResource(resources, "blog", "feed")).toBe(SECRET);
  expect(resolveGoalResource(resources, "blog", "tag")).toBe("writing");
  expect(resolveGoalResource(resources, "blog", "calendar")).toBeUndefined();
  expect(resolveGoalResource(resources, "unknown", "feed")).toBeUndefined();
  expect(await runGoalCli(parseGoalArgs(["goal", "kinds", "--json", "--soma-home", f.somaHome]))).not.toContain(SECRET);
});

test("missing resource file is empty, with both explicit home and home-dir resolution", async () => {
  const f = await fixture();
  expect(await loadGoalResources({ somaHome: f.somaHome })).toEqual([]);
  expect(await loadGoalResources({ homeDir: f.somaHome })).toEqual([]);
  await mkdir(join(f.somaHome, ".soma", "profile"), { recursive: true });
  await writeFile(join(f.somaHome, ".soma", "profile", "resources.yaml"), "[]\n");
  expect(await loadGoalResources({ homeDir: f.somaHome })).toEqual([]);
});

test("structured resource values are retained for their kind's validation", () => {
  const resources = parseGoalResources("[{name: channels, type: channels, value: [one, two]}]", "resources.yaml");
  expect(resolveGoalResource(resources, "channels", "channels")).toEqual(["one", "two"]);
});

test.each([
  ["wrong root", `value: ${SECRET}`, 1],
  ["scalar entry", `- ${SECRET}`, 1],
  ["bad YAML", `- name: blog\n  type: feed\n  value: [${SECRET}\n`, 4],
  ["wrong name", `- name: [${SECRET}]\n  type: feed\n  value: ${SECRET}`, 1],
  ["wrong type", `- name: blog\n  type: [${SECRET}]\n  value: ${SECRET}`, 2],
  ["missing value", "- name: blog\n  type: feed\n", 1],
  ["unknown key", `- name: blog\n  type: feed\n  value: ${SECRET}\n  ${SECRET}: private`, 4],
  ["duplicate pair", `- name: blog\n  type: feed\n  value: ${SECRET}\n- name: blog\n  type: feed\n  value: ${SECRET}`, 4],
  ["duplicate key", `- name: blog\n  type: feed\n  value: ${SECRET}\n  value: ${SECRET}`, 4],
  ["alias", `- name: blog\n  type: feed\n  value: &secret ${SECRET}\n- name: other\n  type: feed\n  value: *secret`, 6],
  ["unknown tag", `- name: blog\n  type: feed\n  value: !secret ${SECRET}`, 3],
  ["multiple documents", `[]\n---\n- name: blog\n  type: feed\n  value: ${SECRET}`, 2],
])("%s errors name the file and source line without values", async (_label, content, line) => {
  const f = await fixture();
  await writeFile(f.file, content);
  try {
    await loadGoalResources({ somaHome: f.somaHome });
    throw new Error("expected failure");
  } catch (error) {
    expect(String(error)).toContain(f.file);
    expect(String(error)).toContain(`line ${line}:`);
    expect(String(error)).not.toContain(SECRET);
    expect((error as Error).cause).toBeUndefined();
  }
});

test("flow-style entry diagnostics use the field's real source line", () => {
  expect(() => parseGoalResources(`# comment\n[\n  { name: blog,\n    type: [${SECRET}],\n    value: ${SECRET} }\n]\n`, "resources.yaml"))
    .toThrow("resources.yaml: line 4: invalid or missing type");
});

test("an unreadable resources path refuses safely instead of returning empty", async () => {
  const f = await fixture();
  await mkdir(f.file);
  await expect(loadGoalResources({ somaHome: f.somaHome })).rejects.toThrow(`Cannot read goal resources: ${f.file}`);
});
