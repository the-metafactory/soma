/** Forge-neutral typed-node codec shared by every GraphStore. */
import type { CreateNodeSpec, SpawnBudget, WorkGraphNode } from "./work-graph";

const NODE_BLOCK_OPEN = "<!-- soma:work-graph-node";
const NODE_BLOCK_CLOSE = "-->";
export const GRAPH_METADATA_MARKER = /<!-- soma:(?:work-graph-node|gitlab-work-graph-route)\b/u;

export function encodeNodeBlock(spec: CreateNodeSpec & { completion?: WorkGraphNode["completion"] }, storeFields: Readonly<Record<string, unknown>> = {}): string {
  const payload: Record<string, unknown> = { autonomy: spec.autonomy };
  if (spec.kind !== undefined) payload.kind = spec.kind;
  if (spec.serves !== undefined) payload.serves = spec.serves;
  if (spec.checkpointId !== undefined) payload.checkpointId = spec.checkpointId;
  if (spec.budget !== undefined) payload.budget = spec.budget;
  if (spec.spawnBudget !== undefined) payload.spawnBudget = spec.spawnBudget;
  if (spec.probes !== undefined && spec.probes.length > 0) payload.probes = spec.probes;
  if (spec.completion !== undefined) payload.completion = spec.completion;
  for (const [key, value] of Object.entries(storeFields)) {
    if (["autonomy", "kind", "serves", "checkpointId", "budget", "spawnBudget", "probes", "completion"].includes(key)) throw new Error(`store field ${key} conflicts with the typed node contract`);
    payload[key] = value;
  }
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

/** Replace prose while keeping graph metadata byte-for-byte, including store routing. */
export function replaceNodeProse(original: string, replacement: string): string {
  const marker = new RegExp(GRAPH_METADATA_MARKER.source, "gu");
  const blocks = (body: string): string[] => [...body.matchAll(marker)].map((match) => {
    const end = body.indexOf("-->", match.index + match[0].length);
    if (end < 0) throw new Error("Cannot edit a body with an unterminated graph metadata block.");
    return body.slice(match.index, end + 3);
  });
  const saved = blocks(original);
  const supplied = blocks(replacement);
  if (new Set(saved).size !== saved.length || saved.filter((block) => block.startsWith(NODE_BLOCK_OPEN)).length > 1) {
    throw new Error("Cannot edit a body with duplicate graph metadata blocks.");
  }
  if (supplied.some((block) => !saved.includes(block)) || new Set(supplied).size !== supplied.length) {
    throw new Error("graph edit cannot change graph metadata; supply prose only or unchanged metadata blocks.");
  }
  let prose = replacement;
  for (const block of supplied) prose = prose.replace(block, "");
  return [prose.trim(), ...saved].filter(Boolean).join("\n\n");
}

/**
 * Set or clear `spawnBudget` in a raw body's typed block, leaving every other
 * byte of the body as it was. Refuses a block it would have to reformat: one
 * not in the JSON form `encodeNodeBlock` writes, or more than one block.
 */
export function rewriteSpawnBudget(body: string, spawnBudget: SpawnBudget | undefined): string {
  const open = body.indexOf(NODE_BLOCK_OPEN);
  if (open === -1) throw new Error("the node has no typed block to hold a spawn budget.");
  if (body.includes(NODE_BLOCK_OPEN, open + NODE_BLOCK_OPEN.length)) throw new Error("the node has more than one typed block; refusing to pick one.");
  const close = body.indexOf(NODE_BLOCK_CLOSE, open + NODE_BLOCK_OPEN.length);
  if (close === -1) throw new Error("the node's typed block is unterminated.");
  const inner = body.slice(open + NODE_BLOCK_OPEN.length, close);
  const json = inner.trim();
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch (error) {
    throw new Error(`the node's typed block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("the node's typed block is not a JSON object.");
  if (inner !== `\n${JSON.stringify(payload, null, 2)}\n`) {
    throw new Error("the node's typed block is not in the form soma writes, so rewriting it would change other fields' bytes; fix the block by hand.");
  }
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if (spawnBudget === undefined) delete next.spawnBudget;
  else next.spawnBudget = spawnBudget;
  return `${body.slice(0, open + NODE_BLOCK_OPEN.length)}\n${JSON.stringify(next, null, 2)}\n${body.slice(close)}`;
}
