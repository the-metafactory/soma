import { z } from "zod";
import type { GoalKind } from "./types";

export const queueParams = z.strictObject({
  goal: z.string().regex(/^G\d+$/),
  source: z.enum(["ranger-escalations"]),
  max: z.number().int().nonnegative(),
  route: z.enum(["escalate-hitl", "provisioning"]).default("escalate-hitl"),
});

export type QueueParams = z.output<typeof queueParams>;

export const queueKind = {
  id: "queue",
  role: "sensor",
  description: "Count open Ranger escalations for a route against a maximum queue size.",
  params: queueParams,
  private: {},
  schedule: { schedule: "30 6 * * *", timezone: "Europe/Zurich" },
  target: "@jc/goal-sense-queue",
  command: ["soma", "goal", "sense", "queue"],
  argv: (params: QueueParams): string[] => {
    const p = queueParams.parse(params);
    return ["--goal", p.goal, "--source", p.source, "--max", String(p.max), "--route", p.route];
  },
  stateRuleTemplate: "At most {max} open {route} escalations: on-track; more: off-track; failed journal read: no state.",
  stateRule: (params: QueueParams): string => {
    const p = queueParams.parse(params);
    return `At most ${p.max} open ${p.route} escalations: on-track; more: off-track; failed journal read: no state.`;
  },
} as const satisfies GoalKind<typeof queueParams>;
