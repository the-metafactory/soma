import type { SubstrateId } from "../types";

// Single source of truth for SubstrateId membership. The
// `satisfies Record<SubstrateId, true>` guard makes omitting a newly added
// SubstrateId member a compile-time error here, where an `||` chain would
// compile silently and reject the new substrate at runtime.
const SUBSTRATE_IDS = {
  codex: true,
  "pi-dev": true,
  "claude-code": true,
  cursor: true,
  grok: true,
  cortex: true,
  custom: true,
} as const satisfies Record<SubstrateId, true>;

const SUBSTRATE_ID_LIST = Object.keys(SUBSTRATE_IDS) as readonly SubstrateId[];

export function parseSubstrate(value: string): SubstrateId {
  if (isSubstrateId(value)) {
    return value;
  }

  const names = `${SUBSTRATE_ID_LIST.slice(0, -1).join(", ")}, or ${SUBSTRATE_ID_LIST[SUBSTRATE_ID_LIST.length - 1]}`;
  throw new Error(`--substrate must be one of ${names}.`);
}

export function isSubstrateId(value: string): value is SubstrateId {
  return Object.hasOwn(SUBSTRATE_IDS, value);
}
