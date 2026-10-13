import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSomaCli } from "../src/cli";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { loadGoalRecords } from "../src/goal-records";

const roots: string[] = [];
const PRIVATE_WORDING = "Private wording only for the principal";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "soma-goal-cli-"));
  roots.push(root);
  const somaHome = join(root, "soma");
  const goalsDir = join(somaHome, "profile", "goals");
  const activationsDir = join(root, "activations");
  await mkdir(goalsDir, { recursive: true });
  await mkdir(activationsDir);
  const invoke = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "goal", ...args, "--soma-home", somaHome], {
      env: { ...process.env, REFLEX_ACTIVATIONS_DIR: activationsDir },
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  return { root, somaHome, goalsDir, activationsDir, invoke };
}

function record(fields = "sensor: feed-check\nreview_by: 2026-12-31\n") {
  return `---\nid: G8\nstatus: draft\nsupports: [M1]\n${fields}---\n${PRIVATE_WORDING}\n\nDrop condition stays here.\n`;
}

const blueprint = (id = "feed-check") => `schema: metafactory/activation/v1\nactivations:\n  - id: ${id}\n    extra: unchanged\n`;

async function directoryFixture() {
  const f = await fixture();
  const personalDir = join(f.root, ".config", "reflex", "personal-activations");
  const switchDir = join(f.root, ".config", "reflex", "activations");
  const configPath = join(f.somaHome, "config.yaml");
  const goalPath = join(f.goalsDir, "G8.md");
  await mkdir(personalDir, { recursive: true });
  await mkdir(switchDir, { recursive: true });
  await writeFile(goalPath, record());
  const activate = (env: Readonly<Record<string, string | undefined>> = {}) => runGoalCli(parseGoalArgs([
    "goal", "activate", "G8", "--home-dir", f.root, "--soma-home", f.somaHome,
  ]), { env });
  const configure = (dir: string) => writeFile(configPath, `goals:\n  activations_dir: ${JSON.stringify(dir)}\n`);
  return { ...f, personalDir, switchDir, configPath, goalPath, activate, configure };
}

test.each([undefined, "", "{}", "goals: {}", "unrelated: retained"])(
  "activation defaults to personal Reflex with config %j", async (config) => {
    const f = await directoryFixture();
    if (config !== undefined) await writeFile(f.configPath, config);
    await writeFile(join(f.personalDir, "sensor.yaml"), blueprint());
    await writeFile(join(f.switchDir, "bad.yaml"), "schema: [");
    expect(await f.activate()).toBe("G8: active");
    expect(await readFile(f.goalPath, "utf8")).toBe(record().replace("status: draft", "status: active"));
  },
);

test("a switch-stack sensor cannot satisfy the personal Reflex default", async () => {
  const f = await directoryFixture();
  await writeFile(join(f.switchDir, "sensor.yaml"), blueprint());
  await writeFile(join(f.personalDir, "other.yaml"), blueprint("other-sensor"));
  await expect(f.activate()).rejects.toThrow(`sensor is absent from Reflex blueprints: ${f.personalDir}`);
  expect(await readFile(f.goalPath, "utf8")).toBe(record());
});

test.each(["absolute", "home-relative", "soma-relative"])(
  "activation reads goals.activations_dir with a %s path", async (kind) => {
    const f = await directoryFixture();
    const configuredDir = kind === "soma-relative" ? join(f.somaHome, "custom") : join(f.root, "custom");
    await mkdir(configuredDir);
    await f.configure(kind === "absolute" ? configuredDir : kind === "home-relative" ? "~/custom" : "custom");
    await writeFile(join(configuredDir, "sensor.yaml"), blueprint());
    await writeFile(join(f.personalDir, "bad.yaml"), "schema: [");
    expect(await f.activate()).toBe("G8: active");
  },
);

test("the environment directory wins over configured and default directories", async () => {
  const f = await directoryFixture();
  await f.configure(f.switchDir);
  await writeFile(join(f.switchDir, "bad.yaml"), "schema: [");
  await writeFile(join(f.personalDir, "bad.yaml"), "schema: [");
  await writeFile(join(f.activationsDir, "sensor.yaml"), blueprint());
  expect(await f.activate({ REFLEX_ACTIVATIONS_DIR: f.activationsDir })).toBe("G8: active");
});

test("an environment override also bypasses invalid lower-priority config", async () => {
  const f = await directoryFixture();
  await writeFile(f.configPath, "goals: [");
  await writeFile(join(f.activationsDir, "sensor.yaml"), blueprint());
  expect(await f.activate({ REFLEX_ACTIVATIONS_DIR: f.activationsDir })).toBe("G8: active");
});

test("the injected directory keeps precedence over environment and config", async () => {
  const f = await directoryFixture();
  await writeFile(f.configPath, "goals: [");
  await writeFile(join(f.activationsDir, "sensor.yaml"), blueprint());
  expect(await runGoalCli(parseGoalArgs(["goal", "activate", "G8", "--soma-home", f.somaHome]), {
    activationsDir: f.activationsDir, env: { REFLEX_ACTIVATIONS_DIR: join(f.root, "missing") },
  })).toBe("G8: active");
});

test("home-dir alone resolves Soma config and goals under .soma", async () => {
  const f = await fixture();
  const somaHome = join(f.root, ".soma");
  const goalsDir = join(somaHome, "profile", "goals");
  await mkdir(goalsDir, { recursive: true });
  await writeFile(join(goalsDir, "G8.md"), record());
  await writeFile(join(somaHome, "config.yaml"), `goals:\n  activations_dir: ${JSON.stringify(f.activationsDir)}\n`);
  await writeFile(join(f.activationsDir, "sensor.yaml"), blueprint());
  expect(await runGoalCli(parseGoalArgs(["goal", "activate", "G8", "--home-dir", f.root]), { env: {} }))
    .toBe("G8: active");
});

test.each(["default", "config", "environment"])(
  "a missing %s directory is named and leaves the goal draft", async (source) => {
    const f = await directoryFixture();
    const missingDir = source === "default" ? f.personalDir : join(f.root, "missing");
    await rm(f.personalDir, { recursive: true });
    await writeFile(join(f.switchDir, "sensor.yaml"), blueprint());
    if (source === "config") await f.configure(missingDir);
    if (source === "environment") await f.configure(f.switchDir);
    await expect(f.activate(source === "environment" ? { REFLEX_ACTIVATIONS_DIR: missingDir } : {}))
      .rejects.toThrow(`Cannot read Reflex activations directory: ${missingDir}`);
    expect(await readFile(f.goalPath, "utf8")).toBe(record());
  },
);

test.each([
  "goals: [", "goals: []", "goals:\n  activations_dir: 7", "goals:\n  activations_dir: ''",
  `goals:\n  activations_dir: [${PRIVATE_WORDING}]`,
])("invalid config fails closed without exposing values: %j", async (config) => {
  const f = await directoryFixture();
  await writeFile(f.configPath, config);
  await writeFile(join(f.personalDir, "sensor.yaml"), blueprint());
  try {
    await f.activate();
    throw new Error("Expected activation failure");
  } catch (error) {
    expect(String(error)).toContain("Invalid Soma config");
    expect(String(error)).toContain(f.configPath);
    expect(String(error)).not.toContain(PRIVATE_WORDING);
  }
  expect(await readFile(f.goalPath, "utf8")).toBe(record());
});

test("unreadable config fails closed and names the config path", async () => {
  const f = await directoryFixture();
  await mkdir(f.configPath);
  await writeFile(join(f.personalDir, "sensor.yaml"), blueprint());
  await expect(f.activate()).rejects.toThrow(`Cannot read Soma config: ${f.configPath}`);
  expect(await readFile(f.goalPath, "utf8")).toBe(record());
});

test.each([[["goal", "--help"]], [["goal", "activate", "--help"]]])(
  "goal help names the personal default and config key: %j", async (args) => {
    const help = await runSomaCli(args);
    expect(help).toContain("~/.config/reflex/personal-activations");
    expect(help).toContain("goals.activations_dir");
    expect(help).toContain("REFLEX_ACTIVATIONS_DIR");
  },
);

test("add on an empty Soma home creates G5 draft, prints only its id, and round-trips the wording", async () => {
  const f = await fixture();
  await rm(f.somaHome, { recursive: true });
  const result = f.invoke("add", "--supports", "M1", "--wording", PRIVATE_WORDING);
  expect(result).toEqual({ code: 0, out: "G5\n", err: "" });
  const content = await readFile(join(f.goalsDir, "G5.md"), "utf8");
  const [frontmatter, body] = content.slice(4).split("\n---\n");
  expect(Bun.YAML.parse(frontmatter)).toEqual({ id: "G5", status: "draft", supports: ["M1"] });
  expect(body.split("\n")[0]).toBe(PRIVATE_WORDING);
  expect((await loadGoalRecords(f.goalsDir, ["M1 — test"])).goals[0].wording).toBe(PRIVATE_WORDING);
});

test("add uses max filename plus one, ignores unrelated files and never fills G6", async () => {
  const f = await fixture();
  await writeFile(join(f.goalsDir, "G5.md"), "invalid but allocated");
  await writeFile(join(f.goalsDir, "G7.md"), "allocated");
  await writeFile(join(f.goalsDir, "G99.md.bak"), "ignored");
  await writeFile(join(f.goalsDir, "sweep.yaml"), "ignored");
  expect(f.invoke("add", "--supports", "M1", "--wording", PRIVATE_WORDING).out).toBe("G8\n");
  expect(await readdir(f.goalsDir)).not.toContain("G6.md");
  expect(await readFile(join(f.goalsDir, "G7.md"), "utf8")).toBe("allocated");
});

test("add writes sensor and review_by but stays draft and supports repeated mission codes", async () => {
  const f = await fixture();
  const sensor = "feed: #check";
  expect(f.invoke("add", "--supports", "M0", "--supports", "M1", "--wording", PRIVATE_WORDING,
    "--sensor", sensor, "--review-by", "2026-12-31").code).toBe(0);
  expect((await loadGoalRecords(f.goalsDir, ["M0 — test", "M1 — test"])).goals[0]).toMatchObject({
    id: "G5", status: "draft", supports: ["M0", "M1"], sensor, reviewBy: "2026-12-31",
  });
});

test.each([
  ["missing wording", [], "--wording"],
  ["blank wording", ["--wording", " "], "wording"],
  ["multiline wording", ["--wording", "private\nwording"], "single line"],
  ["invalid supports", ["--wording", PRIVATE_WORDING, "--supports", "bad"], "supports"],
  ["invalid date", ["--wording", PRIVATE_WORDING, "--review-by", "2026-02-30"], "review_by"],
  ["unknown argument", ["--wording", PRIVATE_WORDING, "--unknown", PRIVATE_WORDING], "Unsupported argument"],
])("add refuses %s without writing or exposing wording", async (_label, args, condition) => {
  const f = await fixture();
  const result = f.invoke("add", ...args);
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
  expect(result.err).toContain(condition);
  expect(result.err).not.toContain(PRIVATE_WORDING);
  expect(await readdir(f.goalsDir)).toEqual([]);
});

test("concurrent additions allocate distinct files without overwriting", async () => {
  const f = await fixture();
  const args = ["goal", "add", "--wording", PRIVATE_WORDING, "--soma-home", f.somaHome];
  const ids = await Promise.all(Array.from({ length: 4 }, () => runSomaCli(args)));
  expect(ids.sort()).toEqual(["G5", "G6", "G7", "G8"]);
  expect(await readdir(f.goalsDir)).toHaveLength(4);
});

test.each(["\n", "\r\n"])("activate preserves all bytes except the status scalar with %j line endings", async (eol) => {
  const f = await fixture();
  const content = record().replace("status: draft", '"status" : "draft"  # keep comment')
    .replace("supports: [M1]", "supports: [M1]\ncustom_field: retained")
    .replaceAll("\n", eol);
  const path = join(f.goalsDir, "G8.md");
  await writeFile(path, content);
  await writeFile(join(f.activationsDir, "a-unrelated.yaml"), blueprint("another-sensor"));
  const sensorPath = join(f.activationsDir, "b-sensor.yaml");
  await writeFile(sensorPath, blueprint());
  const result = f.invoke("activate", "G8");
  expect(result).toEqual({ code: 0, out: "G8: active\n", err: "" });
  expect(await readFile(path, "utf8")).toBe(content.replace('"draft"', '"active"'));
  expect(await readFile(sensorPath, "utf8")).toBe(blueprint());
});

test.each([
  ["absent sensor", "sensor: absent\nreview_by: 2026-12-31\n", "sensor is absent"],
  ["missing sensor", "review_by: 2026-12-31\n", "missing sensor"],
  ["missing review_by", "sensor: feed-check\n", "missing review_by"],
  ["missing both", "", "missing sensor"],
  ["invalid review_by", "sensor: feed-check\nreview_by: tomorrow\n", "review_by"],
])("activate refuses %s with exit 1 and no mutation", async (_label, fields, condition) => {
  const f = await fixture();
  const content = record(fields);
  const path = join(f.goalsDir, "G8.md");
  await writeFile(path, content);
  await writeFile(join(f.activationsDir, "sensor.yaml"), blueprint());
  const result = f.invoke("activate", "G8");
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
  expect(result.err).toContain(condition);
  expect(result.err).not.toContain(PRIVATE_WORDING);
  expect(await readFile(path, "utf8")).toBe(content);
});

test("activate refuses a nonexistent goal without creating it", async () => {
  const f = await fixture();
  const result = f.invoke("activate", "G8");
  expect(result.code).toBe(1);
  expect(result.err).toContain("G8 does not exist");
  expect(await readdir(f.goalsDir)).toEqual([]);
});

test.each([
  ["broken YAML", "schema: [\nactivations:"],
  ["different schema", "schema: other/v2\nactivations: []"],
  ["missing activations", "schema: metafactory/activation/v1"],
  ["invalid activation id", "schema: metafactory/activation/v1\nactivations:\n  - id: 7"],
])("activation fails closed on %s even after finding its sensor", async (_label, broken) => {
  const f = await fixture();
  const path = join(f.goalsDir, "G8.md");
  await writeFile(path, record());
  await writeFile(join(f.activationsDir, "a-valid.yaml"), blueprint());
  const badPath = join(f.activationsDir, "z-bad.yaml");
  await writeFile(badPath, broken);
  const result = f.invoke("activate", "G8");
  expect(result.code).toBe(1);
  expect(result.err).toContain(badPath);
  expect(await readFile(path, "utf8")).toBe(record());
});

test("activation fails closed on a missing directory, naming its path", async () => {
  const f = await fixture();
  const path = join(f.goalsDir, "G8.md");
  await writeFile(path, record());
  await rm(f.activationsDir, { recursive: true });
  const result = f.invoke("activate", "G8");
  expect(result.code).toBe(1);
  expect(result.err).toContain(f.activationsDir);
  expect(await readFile(path, "utf8")).toBe(record());
});

test("activation fails closed on an unreadable blueprint path", async () => {
  const f = await fixture();
  const path = join(f.goalsDir, "G8.md");
  await writeFile(path, record());
  await writeFile(join(f.activationsDir, "a-valid.yaml"), blueprint());
  const badPath = join(f.activationsDir, "z-directory.yaml");
  await mkdir(badPath);
  const result = f.invoke("activate", "G8");
  expect(result.code).toBe(1);
  expect(result.err).toContain(badPath);
  expect(await readFile(path, "utf8")).toBe(record());
});

test("activation checks an already-active goal and refuses mismatched or malformed records", async () => {
  const f = await fixture();
  const path = join(f.goalsDir, "G8.md");
  for (const [content, condition] of [
    [record().replace("status: draft", "status: active"), "sensor is absent"],
    [record().replace("id: G8", "id: G9"), "id does not match"],
    [`---\nid: [${PRIVATE_WORDING}\n---\n${PRIVATE_WORDING}`, "frontmatter"],
  ]) {
    await writeFile(path, content);
    const result = f.invoke("activate", "G8");
    expect(result.code).toBe(1);
    expect(result.err).toContain(condition);
    expect(result.err).not.toContain(PRIVATE_WORDING);
    expect(await readFile(path, "utf8")).toBe(content);
  }
});

test("empty activation directory refuses absent sensor and non-yaml files cannot satisfy it", async () => {
  const f = await fixture();
  await writeFile(join(f.goalsDir, "G8.md"), record());
  await writeFile(join(f.activationsDir, "sensor.txt"), blueprint());
  const result = f.invoke("activate", "G8");
  expect(result.code).toBe(1);
  expect(result.err).toContain("sensor is absent");
  expect(await readFile(join(f.goalsDir, "G8.md"), "utf8")).toBe(record());
});

test.each(["paused", "achieved", "dropped", "draft"])("set-status %s preserves every other byte", async (status) => {
  const f = await fixture();
  const content = record().replace("status: draft", "status: 'active' # retain\n").replaceAll("\n", "\r\n");
  const path = join(f.goalsDir, "G8.md");
  await writeFile(path, content);
  expect(f.invoke("set-status", "G8", status).code).toBe(0);
  expect(await readFile(path, "utf8")).toBe(content.replace("'active'", `'${status}'`));
});

test.each(["active", "unknown"])("set-status rejects %s without mutation", async (status) => {
  const f = await fixture();
  const path = join(f.goalsDir, "G8.md");
  await writeFile(path, record());
  const result = f.invoke("set-status", "G8", status);
  expect(result.code).toBe(1);
  expect(result.err).toContain("use activate");
  expect(await readFile(path, "utf8")).toBe(record());
});

test("list includes every status in id order, hides wording and body unless requested", async () => {
  const f = await fixture();
  for (const [index, status] of ["draft", "active", "paused", "achieved", "dropped"].entries()) {
    const id = `G${index + 8}`;
    await writeFile(join(f.goalsDir, `${id}.md`), record().replace("G8", id).replace("status: draft", `status: ${status}`));
  }
  const result = f.invoke("list");
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out.trim().split("\n")).toEqual(["draft", "active", "paused", "achieved", "dropped"].map((status, index) =>
    `G${index + 8}\t${status}\tsupports: [M1]\tsensor: feed-check`));
  expect(result.out).not.toContain(PRIVATE_WORDING);
  expect(result.out).not.toContain("Drop condition");
  const withWording = f.invoke("list", "--wording");
  expect(withWording.code).toBe(0);
  expect(withWording.out.match(new RegExp(PRIVATE_WORDING, "g"))).toHaveLength(5);
  expect(withWording.out).not.toContain("Drop condition");
});

test("CLI lists drafts without a sensor and safely rejects invalid frontmatter", async () => {
  const f = await fixture();
  await writeFile(join(f.goalsDir, "G8.md"), record(""));
  expect(f.invoke("list").out).toContain("sensor: -");
  await writeFile(join(f.goalsDir, "G8.md"), `---\nstatus: [${PRIVATE_WORDING}\n---\n${PRIVATE_WORDING}`);
  const result = f.invoke("list");
  expect(result.code).toBe(1);
  expect(result.err).toContain("frontmatter");
  expect(result.err).not.toContain(PRIVATE_WORDING);
});

test("goal CLI has help, an injected activation directory, and default home-dir resolution", async () => {
  const f = await fixture();
  expect(await runSomaCli(["--help"])).toContain("goal");
  expect(await runSomaCli(["goal", "activate", "--help"])).toContain("REFLEX_ACTIVATIONS_DIR");
  await writeFile(join(f.goalsDir, "G8.md"), record());
  await writeFile(join(f.activationsDir, "sensor.yaml"), blueprint());
  expect(await runGoalCli(parseGoalArgs(["goal", "activate", "G8", "--soma-home", f.somaHome]), {
    activationsDir: f.activationsDir,
  })).toBe("G8: active");
  const homeDir = join(f.root, "default-home");
  expect(await runSomaCli(["goal", "add", "--wording", PRIVATE_WORDING, "--home-dir", homeDir])).toBe("G5");
  const defaultActivations = join(homeDir, ".config/reflex/personal-activations");
  await mkdir(defaultActivations, { recursive: true });
  await writeFile(join(defaultActivations, "sensor.yaml"), blueprint());
  await writeFile(join(homeDir, ".soma/profile/goals/G8.md"), record());
  const env = { ...process.env };
  delete env.REFLEX_ACTIVATIONS_DIR;
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "goal", "activate", "G8", "--home-dir", homeDir], { env });
  expect(result.exitCode).toBe(0);
});

test.each(["../G8", "G8/../../other", "invalid"])("CLI refuses invalid goal id %s", async (id) => {
  const f = await fixture();
  const result = f.invoke("activate", id);
  expect(result.code).toBe(1);
  expect(result.err).toContain("G<n>");
  expect(await readdir(f.goalsDir)).toEqual([]);
});
