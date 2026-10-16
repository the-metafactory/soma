import { z } from "zod";
import { feedKind } from "./feed";
import { outlineKind } from "./outline";
import { announceKind } from "./announce";
import type { GoalKind } from "./types";

/** One module per kind. No inference, execution or private home reads here. */
export const goalKinds = { feed: feedKind, outline: outlineKind, announce: announceKind } as const;

/** JSON-safe inference catalog. Private parameters expose only resource type. */
export function listGoalKinds(registry: Readonly<Record<string, GoalKind>> = goalKinds) {
  return Object.values(registry).map((kind) => {
    const params = z.toJSONSchema(kind.params, { io: "input" });
    for (const [name, type] of Object.entries(kind.private)) {
      // Replace rather than augment: defaults/examples could contain secrets.
      if (params.properties) params.properties[name] = { resourceType: type };
    }
    return {
      id: kind.id,
      role: kind.role,
      description: kind.description,
      params,
      private: { ...kind.private },
      schedule: { ...kind.schedule },
      target: kind.target,
      command: [...kind.command],
      ...(kind.role === "sensor" ? { stateRule: kind.stateRuleTemplate } : {}),
    };
  });
}
