import { z } from "zod";
import type { FeedFetch } from "../goal-sense";

export const goalBaselineSchema = z.strictObject({
  state: z.enum(["on-track", "off-track", "unknown"]),
  summary: z.string().min(1).optional(),
}).refine((baseline) => baseline.state === "unknown" || baseline.summary !== undefined,
  "A measured baseline requires a summary");

export type GoalBaseline = z.output<typeof goalBaselineSchema>;

/** Read dependencies only: no goal state, run ledger, bus or output surface. */
export interface GoalBaselineDeps {
  homeDir?: string;
  journalPath?: string;
  now?: () => Date;
  fetch?: FeedFetch;
  fetchTimeoutMs?: number;
}

export type GoalBaselineReader<P = Record<string, unknown>> =
  (params: P, deps: GoalBaselineDeps) => Promise<GoalBaseline>;

/** Kind-owned execution metadata. Schedules are defaults, never inferred. */
interface GoalKindBase<S extends z.ZodObject> {
  id: string;
  description: string;
  params: S;
  /** Parameters absent from this map are public. Values never belong here. */
  private: Partial<Record<keyof z.output<S> & string, string>>;
  schedule: Readonly<{ schedule: string; timezone: string }>;
  /** Opaque Reflex target; outline's process route kickstarts a Calendar-granted launchd runner. */
  target: string;
  /** Derive a schedule from public params when a kind exposes cadence. */
  scheduleFor?(params: z.output<S>): Readonly<{ schedule: string; timezone: string }>;
  command: readonly string[];
  /** Flags only, appended to command; no shell quoting or interpolation. */
  argv(params: z.output<S>): string[];
  /** Keep resolved private params in a 0600 goal sidecar, out of activation payloads. */
  localPrivateParams?: boolean;
}

export type GoalKind<S extends z.ZodObject = z.ZodObject> = GoalKindBase<S> & (
  | {
    role: "sensor";
    stateRule(params: z.output<S>): string;
    stateRuleTemplate: string;
    baseline?(params: z.output<S>, deps: GoalBaselineDeps): Promise<GoalBaseline>;
  }
  | { role: "mechanism" }
);
