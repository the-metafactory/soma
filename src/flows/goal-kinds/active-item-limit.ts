import { z } from "zod";
import type { GoalBaseline, GoalBaselineDeps, GoalKind } from "./types";

export const ITEM_STATES = ["active", "parked", "delegated", "done", "unclassified"] as const;
export type ItemState = (typeof ITEM_STATES)[number];
export const collectionSchema = z.strictObject({
  type: z.string().min(1),
  status_option_states: z.record(z.string(), z.enum(ITEM_STATES)),
  excluded_sphere_option_ids: z.array(z.string()),
  source: z.json(),
});
export type ItemCollection = z.output<typeof collectionSchema>;

export const activeItemLimitPublicParams = z.strictObject({
  goal: z.string().regex(/^G\d+$/),
  max: z.number().int().nonnegative(),
  snapshot_weekday: z.number().int().min(0).max(6).default(1),
});

export const activeItemLimitParams = activeItemLimitPublicParams.extend({
  // Resolved structured resources stay source-specific at the reader boundary.
  collection: collectionSchema,
});
export type ActiveItemLimitParams = z.output<typeof activeItemLimitParams>;
export type ActiveItemLimitOptions = z.input<typeof activeItemLimitPublicParams>;

export const activeItemLimitKind = {
  id: "active-item-limit",
  role: "sensor",
  description: "Count a private collection's active items against a maximum, requiring every included item to be classified.",
  params: activeItemLimitParams,
  private: { collection: "tana-collection" },
  localPrivateParams: true,
  schedule: { schedule: "0 7 * * 1", timezone: "Europe/Zurich" },
  target: "@jc/goal-sense-active-item-limit",
  scheduleFor: (params: ActiveItemLimitParams) => ({
    schedule: `0 7 * * ${activeItemLimitParams.parse(params).snapshot_weekday}`, timezone: "Europe/Zurich",
  }),
  command: ["soma", "goal", "sense", "active-item-limit"],
  argv: (params: ActiveItemLimitParams): string[] => {
    const { goal, max, snapshot_weekday } = activeItemLimitParams.parse(params);
    return ["--goal", goal, "--max", String(max), "--snapshot-weekday", String(snapshot_weekday)];
  },
  baseline: async (params: ActiveItemLimitParams, deps: GoalBaselineDeps): Promise<GoalBaseline> => {
    const p = activeItemLimitParams.parse(params);
    const { measureActiveItems, activeItemCountsSummary } = await import("../goal-sense-active-items");
    try {
      const measured = await measureActiveItems(p.collection, p.max, (deps.now ?? (() => new Date()))());
      return { state: measured.value, summary: activeItemCountsSummary(measured.counts) };
    } catch (error) {
      if (error instanceof Error) return { state: "unknown" };
      throw error;
    }
  },
  stateRuleTemplate: "At most {max} active items and zero unclassified: on-track; otherwise off-track; failed read or index older than 26 h: unknown, no published state.",
  stateRule: (params: ActiveItemLimitParams): string => {
    const { max } = activeItemLimitParams.parse(params);
    return `At most ${max} active items and zero unclassified: on-track; otherwise off-track; failed read or index older than 26 h: unknown, no published state.`;
  },
} as const satisfies GoalKind<typeof activeItemLimitParams>;
