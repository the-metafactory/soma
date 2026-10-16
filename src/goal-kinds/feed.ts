import { z } from "zod";
import { FEED_SENSOR_DEFAULTS } from "../goal-sense";
import type { GoalKind } from "./types";

export const feedParams = z.strictObject({
  goal: z.string().regex(/^G\d+$/),
  url: z.union([
    z.url({ protocol: /^https$/ }),
    z.string().regex(/^<resource:[a-z][a-z0-9_-]*>$/),
  ]),
  window_days: z.number().int().positive().default(FEED_SENSOR_DEFAULTS.windowDays),
  min: z.number().int().positive().default(FEED_SENSOR_DEFAULTS.min),
  link_match: z.string().optional(),
});

export type FeedParams = z.output<typeof feedParams>;

export const feedKind = {
  id: "feed",
  role: "sensor",
  description: "Count RSS or Atom feed items in a rolling window to measure a goal's publishing activity.",
  params: feedParams,
  private: { url: "feed" },
  schedule: { schedule: "30 6 * * *", timezone: "Europe/Zurich" },
  target: "@jc/goal-sense-feed",
  command: ["soma", "goal", "sense", "feed"],
  argv: (params: FeedParams): string[] => {
    const p = feedParams.parse(params);
    return ["--goal", p.goal, "--url", p.url, "--window-days", String(p.window_days), "--min", String(p.min),
      ...(p.link_match === undefined ? [] : ["--link-match", p.link_match])];
  },
  stateRuleTemplate: "At least {min} items in the last {window_days} days: on-track; fewer: off-track; failed fetch: no state. When link_match is set, only items whose link contains it count.",
  stateRule: (params: FeedParams): string => {
    const p = feedParams.parse(params);
    return `At least ${p.min} items in the last ${p.window_days} days: on-track; fewer: off-track; failed fetch: no state.${
      p.link_match === undefined ? "" : ` Only items whose link contains ${JSON.stringify(p.link_match)} count.`}`;
  },
} as const satisfies GoalKind<typeof feedParams>;
