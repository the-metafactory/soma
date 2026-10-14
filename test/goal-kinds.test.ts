import { expect, test } from "bun:test";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { runSomaCli } from "../src/cli";
import { feedKind, goalKinds, listGoalKinds } from "../src/goal-kinds";

const params = { goal: "G5", url: "<resource:blog>", window_days: 7, min: 1 };

test("feed kind owns its schema, runner, schedule and state rule", () => {
  expect(Object.keys(goalKinds)).toEqual(["feed"]);
  expect(feedKind).toMatchObject({
    id: "feed", role: "sensor", private: { url: "feed" },
    schedule: { schedule: "30 6 * * *", timezone: "Europe/Zurich" },
    target: "@jc/goal-sense-feed", command: ["soma", "goal", "sense", "feed"],
  });
  expect(feedKind.description.length).toBeGreaterThan(0);
  expect(feedKind.stateRule(params)).toBe("At least 1 items in the last 7 days: on-track; fewer: off-track; failed fetch: no state.");
  expect(feedKind.stateRule({ ...params, window_days: 14, min: 3 })).toContain("3 items in the last 14 days");
  expect(feedKind.stateRule(params)).not.toContain(params.url);
  expect(feedKind.params.parse({ goal: "G5", url: params.url })).toEqual(params);
});

test("feed argv yields exactly the landed subcommand flags and round trips", () => {
  const flags = feedKind.argv(params);
  expect(flags).toEqual(["--goal", "G5", "--url", "<resource:blog>", "--window-days", "7", "--min", "1"]);
  expect(parseGoalArgs([...feedKind.command.slice(1), ...flags]).options.feed).toEqual({
    goal: "G5", url: "<resource:blog>", windowDays: 7, min: 1,
  });
});

test.each(["goal", "url"])("required field %s fails safeParse naming the field", (field) => {
  const input = Object.fromEntries(Object.entries(params).filter(([name]) => name !== field));
  const result = feedKind.params.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
});

test("unknown fields fail strict validation naming the field", () => {
  const result = feedKind.params.safeParse({ ...params, unexpected: true });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.message).toContain("unexpected");
});

test.each([
  { goal: "G5x" }, { goal: "../G5" }, { url: "http://example.org/feed" },
  { url: "not a URL" }, { url: "<resource:>" }, { min: 0 }, { min: 1.5 },
  { window_days: 0 }, { window_days: -1 }, { window_days: "7" },
])("feed params refuse invalid input %j", (invalid) => {
  expect(feedKind.params.safeParse({ ...params, ...invalid }).success).toBe(false);
});

test("resolved feed argv runs through the existing sensor CLI", async () => {
  const resolved = { ...params, url: "https://example.org/feed.xml", min: 2 };
  let fetched = "";
  const output = await runGoalCli(parseGoalArgs([...feedKind.command.slice(1), ...feedKind.argv(resolved)]), {
    feedSensor: {
      env: {}, now: () => new Date("2026-10-14T06:30:00Z"),
      fetch: (url) => {
        fetched = url;
        return Promise.resolve(new Response("<rss><channel><item><pubDate>Tue, 13 Oct 2026 06:30:00 GMT</pubDate></item></channel></rss>"));
      },
    },
  });
  expect(fetched).toBe(resolved.url);
  expect(output).toContain("G5: off-track");
});

test("kinds JSON lists every kind with JSON Schema and only the private resource type", async () => {
  // A nonexistent home proves catalog listing does not depend on home files.
  const output = await runGoalCli(parseGoalArgs(["goal", "kinds", "--json", "--soma-home", "/nonexistent/kinds-test"]));
  const catalog = JSON.parse(output);
  expect(catalog).toEqual(listGoalKinds());
  expect(catalog.map((kind: { id: string }) => kind.id)).toEqual(Object.keys(goalKinds));
  expect(catalog[0].params).toMatchObject({
    type: "object", additionalProperties: false, required: ["goal", "url"],
    properties: {
      goal: { type: "string", pattern: "^G\\d+$" },
      url: { resourceType: "feed" },
      window_days: { type: "integer", default: 7 }, min: { type: "integer", default: 1 },
    },
  });
  expect(catalog[0].params.properties.url).toEqual({ resourceType: "feed" });
  expect(catalog[0].private).toEqual({ url: "feed" });
  expect(catalog[0].stateRule).toContain("{min}");
  expect(catalog[0].stateRule).toContain("{window_days}");
  expect(output).not.toContain("https://example.org");
  expect(output).not.toContain("<resource:blog>");
  expect(await runSomaCli(["goal", "kinds", "--json"])).toBe(output);
  expect(await runSomaCli(["goal", "kinds", "--help"])).toContain("--json");
  expect(await runGoalCli(parseGoalArgs(["goal", "kinds"]))).toContain("feed\tsensor\t");
});

test.each([
  { args: ["goal", "kinds", "--wording"] },
  { args: ["goal", "list", "--json"] },
  { args: ["goal", "kinds", "--secret", "private-value"] },
])(
  "kinds rejects unsupported arguments without echoing values", ({ args }) => {
    expect(() => parseGoalArgs([...args])).toThrow("Unsupported argument");
    try { parseGoalArgs([...args]); } catch (error) { expect(String(error)).not.toContain("private-value"); }
  },
);
