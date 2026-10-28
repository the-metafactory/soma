import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { validateExecutionRunFinished, type ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { runSomaCli } from "../src/cli";
import { runJobsCli } from "../src/cli/jobs";
import { buildRunFinishedEnvelope } from "../src/flows/run-ledger";
import { machineJobsReader, readJobsInventory, type JobRow, type JobsReader } from "../src/jobs/index";

const NOW = new Date("2026-10-28T12:00:00Z");
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "soma-jobs-"));
  homes.push(home);
  const put = async (path: string, data: string) => {
    const destination = join(home, path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, data);
  };
  await put("Library/LaunchAgents/com.kai.daily-briefing.plist", "daily");
  await put("Library/LaunchAgents/ch.invisible.ranger-tick.plist", "tick");
  await put("Library/LaunchAgents/ch.example.invalid.plist", "broken");
  await put("Library/LaunchAgents/ch.example.old.plist.bak", "backup");
  await put("Library/LaunchAgents/unrelated.plist", "unrelated");
  await put("Library/LaunchAgents/odd-filename.plist", "prefixed label");
  await put(".config/reflex/activations/test.yaml", "activations:\n  - id: daily\n    when: {schedule: '0 7 * * *'}\n  - id: manual\n    when: {manual: {}}\n");
  await put(".config/reflex/personal-activations/test.yaml", "activations:\n  - id: daily\n    when: {schedule: '0 7 * * *', timezone: Europe/Zurich}\n");
  await put(".config/reflex/personal-activations/test.yaml.bak", "invalid backup");
  await put(".config/ranger/ranger.yaml", "jobs:\n  - name: weekly\n    skill: weekly-skill\n");
  const commands: string[][] = [];
  const reader: JobsReader = {
    ...machineJobsReader,
    exec: (argv) => {
      commands.push(argv);
      if (argv[0] === "launchctl") return Promise.resolve("PID Status Label\n- 1 com.kai.daily-briefing\n- 2 ch.invisible.ranger-tick\n- 0 ch.example.mislabeled\n");
      const name = basename(argv[argv.length - 1]);
      if (name === "ch.example.invalid.plist") return Promise.reject(new Error("invalid XML"));
      const Label = name === "odd-filename.plist" ? "ch.example.mislabeled" : name.replace(/\.plist$/, "");
      return Promise.resolve(JSON.stringify({ Label, StartInterval: 600, StandardOutPath: "/logs/job.log" }));
    },
    fileInfo: () => Promise.resolve({ size: 100, modifiedAt: NOW }),
  };
  return { home, reader, commands, put };
}

describe("jobs reader and CLI", () => {
  test("reader inventories all three sources, filters labels and backups, and isolates plist errors", async () => {
    const { home, reader, commands } = await fixture();
    const { rows, gaps } = await readJobsInventory({ homeDir: home, reader, now: NOW });
    expect(gaps).toEqual([]);
    expect(rows).toHaveLength(7);
    expect(rows.find((job) => job.label === "com.kai.daily-briefing")).toMatchObject({ status: "failing", lastExit: 1 });
    expect(rows.find((job) => job.label === "ch.invisible.ranger-tick")).toMatchObject({ status: "failing", lastExit: 2 });
    expect(rows.find((job) => job.label === "ch.example.mislabeled")).toMatchObject({ status: "ok" });
    expect(rows.find((job) => job.label === "ch.example.invalid")).toMatchObject({ status: "unknown", reason: expect.stringContaining("invalid XML") });
    expect(rows.filter((job) => job.source === "reflex").map((job) => job.label)).toEqual([
      "reflex:activations/test.yaml:daily", "reflex:personal-activations/test.yaml:daily",
    ]);
    expect(rows.find((job) => job.source === "ranger")).toMatchObject({ label: "ranger:weekly", status: "unknown" });
    expect(commands.every((argv) => argv.join(" ") === "launchctl list" || argv.slice(0, 5).join(" ") === "plutil -convert json -o -")).toBe(true);
    expect(await readFile(join(home, "Library/LaunchAgents/ch.example.invalid.plist"), "utf8")).toBe("broken");
  });

  test("empty or missing logs provide no last-run evidence; unreadable logs cannot make a job ok", async () => {
    const { home, reader } = await fixture();
    for (const fileInfo of [
      () => Promise.resolve({ size: 0, modifiedAt: NOW }),
      () => Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
      () => Promise.reject(new Error("access denied")),
    ]) {
      const inventory = await readJobsInventory({ homeDir: home, reader: { ...reader, fileInfo }, now: NOW });
      const job = inventory.rows.find((row) => row.label === "ch.example.mislabeled");
      expect(job).toMatchObject({ status: "unknown", lastRun: null });
    }
  });

  test("a valid prefixed label survives a bad schedule even when the filename differs", async () => {
    const { home, reader } = await fixture();
    const exec: JobsReader["exec"] = (argv) => basename(argv[argv.length - 1]) === "odd-filename.plist"
      ? Promise.resolve(JSON.stringify({ Label: "ch.example.mislabeled", StartInterval: -1 }))
      : reader.exec(argv);
    const inventory = await readJobsInventory({ homeDir: home, reader: { ...reader, exec }, now: NOW });
    expect(inventory.rows.find((row) => row.label === "ch.example.mislabeled")).toMatchObject({ status: "unknown", reason: expect.stringContaining("parse/read error") });
  });

  test("launchctl and directory failures are explicit gaps; other sources remain visible", async () => {
    const { home, reader } = await fixture();
    const failing: JobsReader = { ...reader, exec: (argv) => argv[0] === "launchctl" ? Promise.reject(new Error("launchctl denied")) : reader.exec(argv) };
    const inventory = await readJobsInventory({ homeDir: home, reader: failing, now: NOW });
    expect(inventory.gaps).toContain("launchctl status unavailable: launchctl denied");
    expect(inventory.rows.some((row) => row.status === "ok")).toBe(false);
    expect(inventory.rows.some((row) => row.source === "ranger")).toBe(true);
    const absent = await readJobsInventory({ homeDir: join(home, "absent"), reader: failing, now: NOW });
    expect(absent.gaps.some((gap) => gap.includes("LaunchAgents"))).toBe(true);
    expect(absent.rows[0]).toMatchObject({ status: "unknown", source: "ranger" });
  });

  test("invalid YAML and invalid entries are visible without dropping healthy declarations", async () => {
    const { home, reader, put } = await fixture();
    await put(".config/reflex/activations/broken.yaml", "activations: [");
    await put(".config/ranger/ranger.yaml", "jobs: [{name: broken}, {name: valid, skill: valid}]");
    const inventory = await readJobsInventory({ homeDir: home, reader, now: NOW });
    expect(inventory.rows.filter((row) => row.reason.includes("parse")).length).toBe(3);
    expect(inventory.rows.some((row) => row.label === "ranger:valid")).toBe(true);
  });

  test("JSON and text report the same rows; observing and unset-principal emit publish nothing", async () => {
    const { home, reader } = await fixture();
    const inventory = await readJobsInventory({ homeDir: home, reader, now: NOW });
    const errors: string[] = [];
    let published = 0;
    const deps = { inventory: () => Promise.resolve(inventory), env: {}, stderr: (line: string) => errors.push(line), publishRunFinished: () => { published++; return Promise.resolve(); } };
    expect(JSON.parse(await runJobsCli(["--json"], deps))).toEqual(inventory.rows);
    const text = await runJobsCli([], deps);
    for (const row of inventory.rows) expect(text).toContain(`${row.status}\t${row.label}`);
    await runJobsCli([], { ...deps, env: { SOMA_PRINCIPAL: "test-principal" } });
    await runJobsCli(["--emit", "--json"], deps);
    expect(published).toBe(0);
    expect(errors).toContain("soma jobs: SOMA_PRINCIPAL unset; nothing published");
    await expect(runJobsCli(["--restart"], deps)).rejects.toThrow("Usage: soma jobs");
  });

  test("emit publishes one valid job envelope per assessed label with the required outcomes", async () => {
    const { home, reader } = await fixture();
    const inventory = await readJobsInventory({ homeDir: home, reader, now: NOW });
    const ok = inventory.rows.find((row) => row.status === "ok");
    if (ok === undefined) throw new Error("fixture needs an ok row");
    inventory.rows.push({ ...ok, label: "ch.example.late", status: "late" });
    const events: ExecutionRunFinishedEvent[] = [];
    const errors: string[] = [];
    const output = await runJobsCli(["--json", "--emit"], {
      inventory: () => Promise.resolve(inventory), now: () => NOW,
      env: { SOMA_PRINCIPAL: "test-principal", MF_SERVES_NODE: "unrelated#123" }, somaHome: join(home, ".soma"),
      stderr: (line) => errors.push(line), publishRunFinished: (event) => { events.push(event); return Promise.resolve(); },
    });
    expect(JSON.parse(output)).toEqual(inventory.rows);
    const assessed = inventory.rows.filter((row) => row.status !== "unknown");
    expect(events).toHaveLength(assessed.length);
    expect(errors).toHaveLength(assessed.length);
    for (const row of assessed) {
      const event = events.find((event) => event.input.payload.ran.ref === `job:${row.label}`);
      if (event === undefined) throw new Error(`missing envelope for ${row.label}`);
      expect(event.input.payload).toMatchObject({ ran: { kind: "job", ref: `job:${row.label}` }, outcome: row.status === "ok" ? "succeeded" : "failed", started_at: NOW.toISOString(), ended_at: NOW.toISOString(), serves: {} });
      expect(validateExecutionRunFinished(await buildRunFinishedEnvelope(event))).toEqual({ valid: true, errors: [] });
    }
    expect(new Set(events.map((event) => event.input.payload.run_id)).size).toBe(events.length);
    expect(await readdir(home)).not.toContain(".soma");
  });

  test("the top-level command exposes help and tolerates an invalid native plist with exit zero", async () => {
    expect(await runSomaCli(["jobs", "--help"])).toContain("soma jobs [--json] [--emit]");
    expect(await runSomaCli(["--help"])).toContain("soma jobs [--json] [--emit]");
    const { home } = await fixture();
    const child = Bun.spawn([process.execPath, "src/cli.ts", "jobs", "--json"], {
      env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("Usage:");
    const rows: JobRow[] = JSON.parse(stdout);
    expect(rows.find((row) => row.label === "ch.example.invalid")).toMatchObject({ status: "unknown", reason: expect.stringContaining("parse/read error") });
  });
});
