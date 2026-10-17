import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { GoalBaselineDeps, GoalBaseline, GoalKind } from "./types";

export const queueParams = z.strictObject({
  goal: z.string().regex(/^G\d+$/),
  source: z.enum(["ranger-escalations"]),
  max: z.number().int().nonnegative(),
  route: z.enum(["escalate-hitl", "provisioning"]).default("escalate-hitl"),
});

export type QueueParams = z.output<typeof queueParams>;

export function rangerJournalPath(deps: GoalBaselineDeps): string {
  return deps.journalPath ?? join(deps.homeDir ?? homedir(), ".config", "ranger", "state.sqlite");
}

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
  baseline: async (params: QueueParams, deps: GoalBaselineDeps): Promise<GoalBaseline> => {
    const p = queueParams.parse(params);
    // The runner imports this schema; defer its load until a read is requested.
    const { countOpenEscalations } = await import("../goal-sense-queue");
    const count = countOpenEscalations(rangerJournalPath(deps), p.route);
    return { state: count <= p.max ? "on-track" : "off-track",
      summary: `${count} open ${p.route} escalations, max ${p.max}` };
  },
  stateRuleTemplate: "At most {max} open {route} escalations: on-track; more: off-track; failed journal read: no state.",
  stateRule: (params: QueueParams): string => {
    const p = queueParams.parse(params);
    return `At most ${p.max} open ${p.route} escalations: on-track; more: off-track; failed journal read: no state.`;
  },
} as const satisfies GoalKind<typeof queueParams>;
