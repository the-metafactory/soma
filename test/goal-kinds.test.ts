import { expect, test } from "bun:test";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { runSomaCli } from "../src/cli";
import { feedKind } from "../src/goal-kinds/feed";
import { queueKind } from "../src/goal-kinds/queue";
import { outlineKind } from "../src/goal-kinds/outline";
import { announceKind } from "../src/goal-kinds/announce";
import { goalKinds, listGoalKinds } from "../src/goal-kinds/registry";
import * as goalKindsExports from "../src/goal-kinds";

const params = { goal: "G5", url: "<resource:blog>", window_days: 7, min: 1 };
const outline = { goal: "G5", tana_tag: "capture", drafts_dir: "/private/open drafts", days: 7 };
const announce = { goal: "G5", url: "https://example.org/feed.xml", channels: ["linkedin", "mastodon"] };

test("directory exports preserve the registry and kind APIs", () => {
  expect(goalKindsExports.goalKinds).toBe(goalKinds);
  expect(goalKindsExports.listGoalKinds).toBe(listGoalKinds);
  expect(goalKindsExports.feedKind).toBe(feedKind);
  expect(goalKindsExports.feedParams).toBe(feedKind.params);
  expect(goalKindsExports.queueKind).toBe(queueKind);
  expect(goalKindsExports.queueParams).toBe(queueKind.params);
  expect(goalKindsExports.outlineKind).toBe(outlineKind);
  expect(goalKindsExports.outlineParams).toBe(outlineKind.params);
  expect(goalKindsExports.announceKind).toBe(announceKind);
  expect(goalKindsExports.announceParams).toBe(announceKind.params);
});

test("feed kind owns its schema, runner, schedule and state rule", () => {
  expect(goalKinds.feed).toBe(feedKind);
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

test("mechanism kinds own their schemas, schedules and settled runners without a slot kind", () => {
  expect(Object.keys(goalKinds)).toEqual(["feed", "outline", "announce", "queue"]);
  expect(outlineKind).toMatchObject({
    id: "outline", role: "mechanism", private: { tana_tag: "tana-tag", drafts_dir: "directory" },
    schedule: { schedule: "0 6 * * 1", timezone: "Europe/Zurich" },
    target: "@jc/g5-outline", command: ["soma", "goal", "outline"],
  });
  expect(announceKind).toMatchObject({
    id: "announce", role: "mechanism", private: { url: "feed", channels: "channels" },
    schedule: { schedule: "35 6 * * *", timezone: "Europe/Zurich" },
    target: "@jc/g5-announce", command: ["soma", "goal", "announce"],
  });
  expect(outlineKind.params.parse({ goal: outline.goal, tana_tag: outline.tana_tag, drafts_dir: outline.drafts_dir })).toEqual(outline);
});

test("queue kind owns public strict params, defaults, argv, schedule and state rule", async () => {
  const input = { goal: "G8", source: "ranger-escalations", max: 2 } as const;
  const params = queueKind.params.parse(input);
  expect(params).toEqual({ ...input, route: "escalate-hitl" });
  expect(goalKinds.queue).toBe(queueKind);
  expect(queueKind).toMatchObject({
    role: "sensor", private: {}, target: "@jc/goal-sense-queue",
    schedule: { schedule: "30 6 * * *", timezone: "Europe/Zurich" },
    command: ["soma", "goal", "sense", "queue"],
  });
  for (const route of ["escalate-hitl", "provisioning"] as const) {
    const p = { ...params, route };
    expect(parseGoalArgs([...queueKind.command.slice(1), ...queueKind.argv(p)]).options.queue).toEqual(p);
    expect(queueKind.stateRule(p)).toBe(`At most 2 open ${route} escalations: on-track; more: off-track; failed journal read: no state.`);
  }
  for (const invalid of [{ source: "github" }, { max: -1 }, { max: 0.5 }, { max: "2" }, { route: "other" }, { goal: "wording" }, { path: "/private/journal" }]) {
    expect(queueKind.params.safeParse({ ...input, ...invalid }).success).toBe(false);
  }
  for (const field of ["goal", "source", "max"]) {
    expect(queueKind.params.safeParse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== field))).success).toBe(false);
  }
  expect(queueKind.params.safeParse({ ...input, max: 0 }).success).toBe(true);
  const catalog = JSON.parse(await runSomaCli(["goal", "kinds", "--json"]));
  expect(catalog.find((kind: { id: string }) => kind.id === "queue")).toMatchObject({
    id: "queue", private: {}, params: {
      additionalProperties: false, required: ["goal", "source", "max"],
      properties: { source: { enum: ["ranger-escalations"] }, max: { type: "integer", minimum: 0 }, route: { default: "escalate-hitl" } },
    },
  });
  expect(await runSomaCli(["goal", "kinds"])).toContain("queue\tsensor\t");
  expect(await runSomaCli(["goal", "sense", "--help"])).toContain("--source ranger-escalations --max <n>");
});

test.each([undefined, 60])("outline argv round trips through the landed parser with slot_minutes=%j", (slot_minutes) => {
  const input = { ...outline, days: 14, ...(slot_minutes === undefined ? {} : { slot_minutes }) };
  const flags = outlineKind.argv(input);
  expect(flags).toEqual([
    "--goal", "G5", "--tana-tag", "capture", "--drafts-dir", "/private/open drafts", "--days", "14",
    ...(slot_minutes === undefined ? [] : ["--slot-minutes", "60"]),
  ]);
  expect(parseGoalArgs([...outlineKind.command.slice(1), ...flags]).options.outline).toEqual({
    goal: "G5", tanaTag: "capture", draftsDir: "/private/open drafts", days: 14,
    ...(slot_minutes === undefined ? {} : { slotMinutes: slot_minutes }),
  });
});

test("announce argv round trips through the landed parser with comma-separated channels", () => {
  const flags = announceKind.argv(announce);
  expect(flags).toEqual(["--goal", "G5", "--url", announce.url, "--channels", "linkedin,mastodon"]);
  expect(parseGoalArgs([...announceKind.command.slice(1), ...flags]).options.announce).toEqual(announce);
});

test("private mechanism params accept resource references before local resolution", () => {
  expect(outlineKind.params.safeParse({ ...outline, tana_tag: "<resource:captures>", drafts_dir: "<resource:drafts>" }).success).toBe(true);
  const unresolved = { ...announce, url: "<resource:blog>", channels: "<resource:social>" };
  expect(announceKind.params.parse(unresolved)).toEqual(unresolved);
  expect(announceKind.argv(unresolved)).toEqual(["--goal", "G5", "--url", "<resource:blog>", "--channels", "<resource:social>"]);
});

for (const { kind, sample, required } of [
  { kind: outlineKind, sample: outline, required: ["goal", "tana_tag", "drafts_dir"] },
  { kind: announceKind, sample: announce, required: ["goal", "url", "channels"] },
]) {
  test.each(required)(`${kind.id} required field %s fails naming the field`, (field) => {
    const input = Object.fromEntries(Object.entries(sample).filter(([name]) => name !== field));
    const result = kind.params.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
  });
  test(`${kind.id} rejects unknown fields`, () => {
    const result = kind.params.safeParse({ ...sample, unexpected: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("unexpected");
  });
}

test.each([
  { goal: "G5x" }, { tana_tag: " " }, { tana_tag: "--tag" }, { drafts_dir: "" }, { drafts_dir: "--dir" },
  { days: 0 }, { days: 1.5 }, { days: "7" }, { days: Number.MAX_SAFE_INTEGER + 1 },
  { slot_minutes: 0 }, { slot_minutes: -1 }, { slot_minutes: 1.5 }, { slot_minutes: "60" },
])("outline params refuse invalid input %j", (invalid) => {
  expect(outlineKind.params.safeParse({ ...outline, ...invalid }).success).toBe(false);
  expect(() => outlineKind.argv({ ...outline, ...invalid } as never)).toThrow();
});

test.each([
  { goal: "../G5" }, { url: "http://example.org/feed" }, { url: "not a URL" }, { url: "<resource:>" },
  { channels: [] }, { channels: [""] }, { channels: ["two words"] }, { channels: ["a,b"] },
  { channels: "linkedin,mastodon" }, { channels: "<resource:>" }, { channels: [1] },
])("announce params refuse invalid input %j", (invalid) => {
  expect(announceKind.params.safeParse({ ...announce, ...invalid }).success).toBe(false);
  expect(() => announceKind.argv({ ...announce, ...invalid } as never)).toThrow();
});

test("feed argv yields exactly the landed subcommand flags and round trips", () => {
  const flags = feedKind.argv(params);
  expect(flags).toEqual(["--goal", "G5", "--url", "<resource:blog>", "--window-days", "7", "--min", "1"]);
  expect(parseGoalArgs([...feedKind.command.slice(1), ...flags]).options.feed).toEqual({
    goal: "G5", url: "<resource:blog>", windowDays: 7, min: 1,
  });
});

test("feed link_match is optional and round trips to the sensor's linkMatch option", () => {
  const filtered = { ...params, link_match: "/shorts/" };
  expect(feedKind.params.parse(filtered)).toEqual(filtered);
  expect(feedKind.params.safeParse({ ...params, link_match: 1 }).success).toBe(false);
  const flags = feedKind.argv(filtered);
  expect(flags.slice(-2)).toEqual(["--link-match", "/shorts/"]);
  expect(parseGoalArgs([...feedKind.command.slice(1), ...flags]).options.feed).toEqual({
    goal: "G5", url: params.url, windowDays: 7, min: 1, linkMatch: "/shorts/",
  });
  expect(feedKind.stateRule(filtered)).toContain('Only items whose link contains "/shorts/" count.');
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
      link_match: { type: "string" },
    },
  });
  expect(catalog[0].params.properties.url).toEqual({ resourceType: "feed" });
  expect(catalog[0].private).toEqual({ url: "feed" });
  expect(catalog[0].stateRule).toContain("{min}");
  expect(catalog[0].stateRule).toContain("{window_days}");
  expect(catalog[1]).toMatchObject({
    id: "outline", role: "mechanism", target: "@jc/g5-outline",
    schedule: { schedule: "0 6 * * 1", timezone: "Europe/Zurich" },
    params: { required: ["goal", "tana_tag", "drafts_dir"], properties: {
      days: { type: "integer", default: 7 }, slot_minutes: { type: "integer" },
    } },
  });
  expect(catalog[2]).toMatchObject({
    id: "announce", role: "mechanism", target: "@jc/g5-announce",
    schedule: { schedule: "35 6 * * *", timezone: "Europe/Zurich" },
    params: { required: ["goal", "url", "channels"] },
  });
  for (const kind of catalog) {
    for (const [name, type] of Object.entries(kind.private)) {
      expect(kind.params.properties[name]).toEqual({ resourceType: type });
    }
    if (kind.role === "mechanism") expect(kind).not.toHaveProperty("stateRule");
  }
  expect(output).not.toContain("https://example.org");
  expect(output).not.toContain("<resource:blog>");
  expect(output).not.toContain(outline.drafts_dir);
  expect(output).not.toContain(JSON.stringify(outline.tana_tag));
  expect(output).not.toContain(announce.channels[0]);
  expect(await runSomaCli(["goal", "kinds", "--json"])).toBe(output);
  expect(await runSomaCli(["goal", "kinds", "--help"])).toContain("--json");
  expect(await runGoalCli(parseGoalArgs(["goal", "kinds"]))).toContain("feed\tsensor\t");
  expect(await runGoalCli(parseGoalArgs(["goal", "kinds"]))).toContain("outline\tmechanism\t");
  expect(await runGoalCli(parseGoalArgs(["goal", "kinds"]))).toContain("announce\tmechanism\t");
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
