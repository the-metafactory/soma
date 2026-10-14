import type { z } from "zod";

/** Kind-owned execution metadata. Schedules are defaults, never inferred. */
interface GoalKindBase<S extends z.ZodObject> {
  id: string;
  description: string;
  params: S;
  /** Parameters absent from this map are public. Values never belong here. */
  private: Partial<Record<keyof z.output<S> & string, string>>;
  schedule: Readonly<{ schedule: string; timezone: string }>;
  /** Opaque Reflex target, resolved by Cortex's configured process route. */
  target: string;
  command: readonly string[];
  /** Flags only, appended to command; no shell quoting or interpolation. */
  argv: (params: z.output<S>) => string[];
}

export type GoalKind<S extends z.ZodObject = z.ZodObject> = GoalKindBase<S> & (
  | { role: "sensor"; stateRule: (params: z.output<S>) => string; stateRuleTemplate: string }
  | { role: "mechanism" }
);
