/** Forge-neutral typed-node codec shared by every GraphStore. */
import type { CreateNodeSpec, WorkGraphNode } from "./work-graph";

const NODE_BLOCK_OPEN = "<!-- soma:work-graph-node";
const NODE_BLOCK_CLOSE = "-->";

export function encodeNodeBlock(spec: CreateNodeSpec & { completion?: WorkGraphNode["completion"] }): string {
  const payload: Record<string, unknown> = { autonomy: spec.autonomy };
  if (spec.kind !== undefined) payload.kind = spec.kind;
  if (spec.checkpointId !== undefined) payload.checkpointId = spec.checkpointId;
  if (spec.home !== undefined) payload.home = spec.home;
  if (spec.budget !== undefined) payload.budget = spec.budget;
  if (spec.probes !== undefined && spec.probes.length > 0) payload.probes = spec.probes;
  if (spec.completion !== undefined) payload.completion = spec.completion;
  return `${NODE_BLOCK_OPEN}\n${JSON.stringify(payload, null, 2)}\n${NODE_BLOCK_CLOSE}`;
}

export interface DecodedBody { text: string; raw?: string; }

export function decodeNodeBlock(body: string): DecodedBody {
  const open = body.lastIndexOf(NODE_BLOCK_OPEN);
  if (open === -1) return { text: body.trim() };
  const close = body.indexOf(NODE_BLOCK_CLOSE, open + NODE_BLOCK_OPEN.length);
  if (close === -1) return { text: body.trim() };
  return { text: `${body.slice(0, open)}${body.slice(close + NODE_BLOCK_CLOSE.length)}`.trim(), raw: body.slice(open + NODE_BLOCK_OPEN.length, close).trim() };
}
