import type { SubstrateId } from "../types";

export function parseSubstrate(value: string): SubstrateId {
  if (isSubstrateId(value)) {
    return value;
  }

  throw new Error("--substrate must be one of codex, pi-dev, claude-code, cursor, cortex, or custom.");
}

export function isSubstrateId(value: string): value is SubstrateId {
  return value === "codex" || value === "pi-dev" || value === "claude-code" || value === "cursor" || value === "cortex" || value === "custom";
}
