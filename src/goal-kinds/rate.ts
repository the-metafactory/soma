import { z } from "zod";
import { queueParams } from "./queue";
import type { GoalKind } from "./types";

export const rateParams = z.strictObject({
  goal: queueParams.shape.goal,
  source: queueParams.shape.source,
  min: z.number().int().nonnegative(),
  window_workdays: z.number().int().positive(),
  timezone: z.string().refine((timezone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
      return true;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  }, "Unknown timezone").default("Europe/Zurich"),
  route: queueParams.shape.route,
});

export type RateParams = z.output<typeof rateParams>;

export const rateKind = {
  id: "rate",
  role: "sensor",
  description: "Count Ranger escalations closed in a workday window against a minimum.",
  params: rateParams,
  private: {},
  schedule: { schedule: "30 6 * * *", timezone: "Europe/Zurich" },
  target: "@jc/goal-sense-rate",
  command: ["soma", "goal", "sense", "rate"],
  argv: (params: RateParams): string[] => {
    const p = rateParams.parse(params);
    return ["--goal", p.goal, "--source", p.source, "--min", String(p.min),
      "--window-workdays", String(p.window_workdays), "--timezone", p.timezone, "--route", p.route];
  },
  stateRuleTemplate: "At least {min} closed {route} escalations in the last {window_workdays} workdays in {timezone}: on-track; fewer: off-track; failed journal read: no state.",
  stateRule: (params: RateParams): string => {
    const p = rateParams.parse(params);
    return `At least ${p.min} closed ${p.route} escalations in the last ${p.window_workdays} workdays in ${p.timezone}: on-track; fewer: off-track; failed journal read: no state.`;
  },
} as const satisfies GoalKind<typeof rateParams>;
