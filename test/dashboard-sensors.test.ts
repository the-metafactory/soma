import { expect, test } from "bun:test";
import { DEFAULT_VIGIL_URL, readSensorSource, sensorReading, validateVigilUrl } from "../scripts/dashboard-sensors";

const now = new Date("2026-10-18T12:00:00Z");
const ended = now.getTime() - 60 * 60 * 1000;
const cadence = 26 * 60 * 60 * 1000;
const goal = { id: "G5", sensor: "configured-sensor" };
const run = {
  subjectKey: "run:job:goal-sense/G5", kind: "run", vocab: null,
  ref: "goal-sense/G5", goalId: "G5", value: "succeeded",
  lastRunId: "run-1", lastEndedAt: ended, expectedBy: ended + cadence,
};
const state = {
  ...run, subjectKey: "state:goal:G5", kind: "state", vocab: "goal", ref: "G5", value: "on-track",
};
async function source(subjects: unknown[], extra = {}) {
  return readSensorSource({ vigilUrl: DEFAULT_VIGIL_URL, now: () => now,
    fetch: () => Promise.resolve(Response.json({ subjects, ...extra })),
  });
}

test("a recorded measurement requires the exact goal and correlated sensor run", async () => {
  const data = await source([run, state]);
  expect(sensorReading(goal, data)).toMatchObject({ status: "measured", state: "on-track", runId: "run-1", freshnessKnown: true,
    observedAt: new Date(ended).toISOString(), expectedBy: new Date(ended + cadence).toISOString(), overdue: false });
  expect(sensorReading(goal, await source([{ ...run, goalId: "G6" }, state])).status).toBe("unknown");
  expect(sensorReading(goal, await source([run, { ...state, lastRunId: "different" }])).status).toBe("unknown");
  expect(sensorReading(goal, await source([run, { ...state, lastEndedAt: ended - 1 }])).status).toBe("unknown");
  expect(sensorReading(goal, await source([run, { ...state, subjectKey: "state:check:G5", vocab: "check", value: "ok" }])).status).toBe("unknown");
});

test("a newer failed, blocked or cancelled sensor run cannot revive a prior healthy reading", async () => {
  for (const outcome of ["failed", "cancelled", "blocked"]) {
    const reading = sensorReading(goal, await source([state, { ...run, value: outcome, lastRunId: "run-2", lastEndedAt: ended + 1000 }]));
    expect(reading).toMatchObject({ status: "failed", runOutcome: outcome, previous: { state: "on-track", runId: "run-1" } });
    expect(reading.state).toBeUndefined();
  }
});

test("source staleness and silence beyond twice the declared cadence are explicit", async () => {
  expect(sensorReading(goal, await source([run, { ...state, value: "stale" }]))).toMatchObject({ status: "stale" });
  const old = now.getTime() - 2 * cadence - 1;
  const stale = sensorReading(goal, await source([{ ...run, lastEndedAt: old, expectedBy: old + cadence }, { ...state, lastEndedAt: old, expectedBy: old + cadence }]));
  expect(stale).toMatchObject({ status: "stale", state: "on-track" });
  const boundary = now.getTime() - 2 * cadence;
  expect(sensorReading(goal, await source([{ ...run, lastEndedAt: boundary, expectedBy: boundary + cadence }, { ...state, lastEndedAt: boundary, expectedBy: boundary + cadence }]))).toMatchObject({ status: "measured", overdue: true });
});

test("unknown cadence is not presented as confirmed freshness", async () => {
  expect(sensorReading(goal, await source([{ ...run, expectedBy: null }, { ...state, expectedBy: null }]))).toMatchObject({ status: "measured", freshnessKnown: false });
});

test("absent, unconfigured, disabled and unavailable sources remain distinct", async () => {
  const empty = await source([]);
  expect(sensorReading(goal, empty).status).toBe("no-reading");
  expect(sensorReading({ id: "G5" }, empty).status).toBe("not-configured");
  const disabled = await source([], { enabled: false });
  expect(disabled.status).toBe("disabled");
  expect(sensorReading(goal, disabled).status).toBe("unavailable");
  const disconnected = await readSensorSource({ now: () => now });
  expect(disconnected.status).toBe("not-connected");
});

test("unknown state and a state without a sensor run cannot claim a measured outcome", async () => {
  expect(sensorReading(goal, await source([run, { ...state, value: "ok" }])).status).toBe("unknown");
  expect(sensorReading(goal, await source([state])).status).toBe("unknown");
  expect(sensorReading(goal, await source([run])).status).toBe("unknown");
});

test("future timestamps, invalid cadence, duplicate subjects and broken schemas fail closed", async () => {
  for (const rows of [
    [run, { ...state, lastEndedAt: now.getTime() + 60_001 }],
    [{ ...run, expectedBy: ended }, state],
    [run, state, state],
    [run, { ...state, lastEndedAt: "yesterday" }],
  ]) {
    const data = await source(rows);
    expect(data.status).toBe("unavailable");
    expect(sensorReading(goal, data).status).toBe("unavailable");
  }
});

test("transport reads are bounded GETs without redirect following; errors retain the dashboard", async () => {
  const good = await readSensorSource({ vigilUrl: DEFAULT_VIGIL_URL, now: () => now, fetch: (_url, init) => {
    expect(init.method).toBe("GET");expect(init.redirect).toBe("error");expect(init.signal).toBeInstanceOf(AbortSignal);
    return Promise.resolve(Response.json({ subjects: [run, state] }));
  } });
  expect(good.status).toBe("available");
  for (const response of [new Response("private error detail", { status: 500 }), new Response("not JSON"), new Response("x", { headers: { "content-length": String(3 * 1024 * 1024) } }), new Response("x".repeat(2 * 1024 * 1024 + 1))]) {
    const result = await readSensorSource({ vigilUrl: DEFAULT_VIGIL_URL, fetch: () => Promise.resolve(response) });
    expect(result.status).toBe("unavailable");expect(result.message).not.toContain("private error detail");
  }
  const timeout = await readSensorSource({ vigilUrl: DEFAULT_VIGIL_URL, fetch: () => Promise.reject(new DOMException("timed out", "TimeoutError")) });
  expect(timeout.message).toContain("timed out");
});

test("remote endpoints, credentials, alternative paths and redirects are never used", () => {
  expect(validateVigilUrl(DEFAULT_VIGIL_URL).hostname).toBe("127.0.0.1");
  for (const value of ["https://example.com/api/vigil/subjects", "http://127.0.0.1:8767/other", "http://user:secret@127.0.0.1:8767/api/vigil/subjects", DEFAULT_VIGIL_URL + "?secret=x", "http://localhost:8767/api/vigil/subjects"]) {
    expect(() => validateVigilUrl(value)).toThrow();
  }
});
