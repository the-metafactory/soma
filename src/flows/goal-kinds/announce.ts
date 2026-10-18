import { z } from "zod";
import type { GoalKind } from "./types";

export const announceParams = z.strictObject({
  goal: z.string().regex(/^G\d+$/),
  url: z.union([
    z.url({ protocol: /^https$/ }),
    z.string().regex(/^<resource:[a-z][a-z0-9_-]*>$/),
  ]),
  channels: z.union([
    z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/i)).min(1),
    z.string().regex(/^<resource:[a-z][a-z0-9_-]*>$/),
  ]),
});

export type AnnounceParams = z.output<typeof announceParams>;

export const announceKind = {
  id: "announce",
  role: "mechanism",
  description: "Draft announcements for new feed items into the weekly outline; never publish them.",
  params: announceParams,
  private: { url: "feed", channels: "channels" },
  schedule: { schedule: "35 6 * * *", timezone: "Europe/Zurich" },
  target: "@jc/g5-announce",
  command: ["soma", "goal", "announce"],
  argv: (params: AnnounceParams): string[] => {
    const p = announceParams.parse(params);
    return ["--goal", p.goal, "--url", p.url, "--channels",
      Array.isArray(p.channels) ? p.channels.join(",") : p.channels];
  },
} as const satisfies GoalKind<typeof announceParams>;
