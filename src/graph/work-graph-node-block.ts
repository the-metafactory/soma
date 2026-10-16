/** Forge-neutral typed-node codec shared by every GraphStore. */
import type { CreateNodeSpec, WorkGraphNode } from "./work-graph";

const NODE_BLOCK_OPEN = "<!-- soma:work-graph-node";
const NODE_BLOCK_CLOSE = "-->";

export function encodeNodeBlock(spec: CreateNodeSpec & { completion?: WorkGraphNode["completion"] }, storeFields: Readonly<Record<string, unknown>> = {}): string {
  const payload: Record<string, unknown> = { autonomy: spec.autonomy };
  if (spec.kind !== undefined) payload.kind = spec.kind;
  if (spec.serves !== undefined) payload.serves = spec.serves;
  if (spec.checkpointId !== undefined) payload.checkpointId = spec.checkpointId;
  if (spec.budget !== undefined) payload.budget = spec.budget;
  if (spec.probes !== undefined && spec.probes.length > 0) payload.probes = spec.probes;
  if (spec.completion !== undefined) payload.completion = spec.completion;
  for (const [key, value] of Object.entries(storeFields)) {
    if (["autonomy", "kind", "serves", "checkpointId", "budget", "probes", "completion"].includes(key)) throw new Error(`store field ${key} conflicts with the typed node contract`);
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
  const marker = /<!-- soma:(?:work-graph-node|gitlab-work-graph-route)\b/g;
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
