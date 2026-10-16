import { z } from "zod";
import type { GoalKind } from "./types";

const argument = z.string().trim().min(1).refine((value) => !value.startsWith("--"));

export const outlineParams = z.strictObject({
  goal: z.string().regex(/^G\d+$/),
  tana_tag: argument,
  drafts_dir: argument,
  days: z.number().int().positive().default(7),
  slot_minutes: z.number().int().positive().optional(),
});

export type OutlineParams = z.output<typeof outlineParams>;

export const outlineKind = {
  id: "outline",
  role: "mechanism",
  description: "Recommend a weekly outline from captures and open drafts, optionally proposing a free writing slot.",
  params: outlineParams,
  private: { tana_tag: "tana-tag", drafts_dir: "directory" },
  schedule: { schedule: "0 6 * * 1", timezone: "Europe/Zurich" },
  // The existing target kickstarts the Calendar-granted launchd runner (node #845).
  target: "@jc/g5-outline",
  command: ["soma", "goal", "outline"],
  argv: (params: OutlineParams): string[] => {
    const p = outlineParams.parse(params);
    return [
      "--goal", p.goal, "--tana-tag", p.tana_tag, "--drafts-dir", p.drafts_dir,
      "--days", String(p.days),
      ...(p.slot_minutes === undefined ? [] : ["--slot-minutes", String(p.slot_minutes)]),
    ];
  },
} as const satisfies GoalKind<typeof outlineParams>;
