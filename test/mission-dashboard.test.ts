import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapSomaHome } from "../src/flows/index";
import { startDashboard } from "../scripts/mission-dashboard";

test("dashboard serves live records read-only, retains explicit links, and protects local private responses", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-dashboard-"));
  const { somaHome } = await bootstrapSomaHome({ homeDir });
  const goalPath = join(somaHome, "profile/goals/G5.md");
  const original = '---\nid: G5\nstatus: paused\nsupports: [M0]\nsensor: essay-sensor\n---\nWrite an essay\n\nPrivate record notes.\n';
  await writeFile(join(somaHome, "profile/purpose.md"), '# Purpose\n\n## Missions\n\n- M0 — Create: make things\n- M1 — Connect\n');
  await mkdir(join(somaHome, "profile/goals"), { recursive: true });
  await writeFile(goalPath, original);
  const observed = Date.now() - 1000;
  const server = startDashboard(somaHome, 0, { vigilUrl: "http://127.0.0.1:8767/api/vigil/subjects", fetch: () => Promise.resolve(Response.json({ subjects: [
    { subjectKey: "run:job:goal-sense/G5", kind: "run", vocab: null, ref: "goal-sense/G5", goalId: "G5", value: "succeeded", lastRunId: "sensor-run", lastEndedAt: observed, expectedBy: observed + 10000 },
    { subjectKey: "state:goal:G5", kind: "state", vocab: "goal", ref: "G5", goalId: "G5", value: "off-track", lastRunId: "sensor-run", lastEndedAt: observed, expectedBy: observed + 10000 },
  ] })) });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const snapshot = await fetch(`${origin}/api/dashboard`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("cache-control")).toBe("no-store");
    const data = await snapshot.json() as { missions: { id: string; wording: string }[]; goals: { id: string; status: string; supports: string[]; body?: string; sensorReading: unknown }[] };
    expect(data.missions).toEqual([{ id: "M0", wording: "Create: make things" }, { id: "M1", wording: "Connect" }]);
    expect(data.goals[0]).toMatchObject({ id: "G5", status: "paused", supports: ["M0"] });
    expect(data.goals[0].body).toBeUndefined();
    expect(data.goals[0].sensorReading).toMatchObject({ status: "measured", state: "off-track", runId: "sensor-run" });
    const detail = await fetch(`${origin}/api/goals/G5`);
    const detailBody = await detail.text();
    expect(detailBody).toContain("Private record notes.");
    expect(detailBody).toContain('"state":"off-track"');
    expect((await fetch(`${origin}/api/goals/G999`)).status).toBe(404);
    expect((await fetch(`${origin}/api/dashboard`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${origin}/api/dashboard`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(`${origin}/api/dashboard`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${origin}/api/dashboard`, { headers: { host: "attacker.example" } })).status).toBe(403);
    expect((await fetch(`${origin}/profile/purpose.md`)).status).toBe(404);
    expect(await readFile(goalPath, "utf8")).toBe(original);
    await writeFile(goalPath, original.replace("paused", "achieved"));
    expect(await (await fetch(`${origin}/api/dashboard`)).text()).toContain('"status":"achieved"');
    await writeFile(goalPath, original.replace("paused", "invalid"));
    const invalid = await (await fetch(`${origin}/api/dashboard`)).json() as { warnings: unknown[]; goals: unknown[] };
    expect(invalid.warnings.length).toBeGreaterThan(0);
    expect(invalid.goals).toHaveLength(0);
    await rm(join(somaHome, "profile/assistant.md"));
    const broken = await fetch(`${origin}/api/dashboard`);
    expect(broken.status).toBe(500);
    expect(await broken.text()).toContain("Could not read Soma records");
  } finally {
    await server.stop(true);
    await rm(homeDir, { recursive: true, force: true });
  }
});
