import { GRAPH_METADATA_MARKER } from "./work-graph-node-block";

const RULINGS_HEADING = "## Rulings";
const RULINGS_LINE = /^## Rulings[ \t]*\r?$/mu;
const SECTION_END = /^#{1,2}(?:[ \t]|\r?$)/mu;
const HEADING_LIKE = /^[ \t]*#{1,6}(?:[ \t]|$)/u;
const SOMA_MARKER = /<!--\s*soma:/iu;

export class RulingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulingRefusal";
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function rulingStamp(at: Date): string {
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

export function formatRulingEntry(text: string, at: Date, by: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && (lines.at(-1) ?? "").trim().length === 0) lines.pop();
  if (lines.length === 0) throw new RulingRefusal("The ruling is empty, so nothing was written.");
  if (by.trim().length === 0) throw new RulingRefusal("The acting identity is unknown, so the ruling cannot be attributed and nothing was written.");
  if (lines.some((line) => HEADING_LIKE.test(line))) {
    throw new RulingRefusal("The ruling has a line that looks like a Markdown heading, which would end the Rulings section, so nothing was written.");
  }
  if (lines.some((line) => SOMA_MARKER.test(line))) {
    throw new RulingRefusal("The ruling contains a <!-- soma: marker, which could forge graph metadata, so nothing was written.");
  }
  const [first, ...rest] = lines;
  return [`- ${rulingStamp(at)} (${by.trim()}): ${first.trimStart()}`, ...rest.map((line) => (line.length === 0 ? "" : `  ${line}`))].join("\n");
}

export function hasMetadataBlock(body: string): boolean {
  return GRAPH_METADATA_MARKER.test(body);
}

export function spliceRuling(body: string, entry: string): string {
  const block = GRAPH_METADATA_MARKER.exec(body);
  const blockAt = block === null ? body.length : block.index;
  if (block !== null && !body.slice(blockAt).includes("-->")) {
    throw new RulingRefusal("The node body has an unterminated graph metadata block, so nothing was written.");
  }
  const prose = body.slice(0, blockAt);
  const tail = body.slice(blockAt);
  const heading = RULINGS_LINE.exec(prose);

  if (heading === null) {
    const kept = prose.trimEnd();
    const section = `${RULINGS_HEADING}\n\n${entry}`;
    const lead = kept.length === 0 ? "" : `${kept}\n\n`;
    const trail = tail.length === 0 ? "\n" : `\n\n${tail}`;
    return `${lead}${section}${trail}`;
  }

  const afterHeading = heading.index + heading[0].length;
  const next = SECTION_END.exec(prose.slice(afterHeading));
  const end = next === null ? prose.length : afterHeading + next.index;
  const section = prose.slice(0, end);
  const kept = section.trimEnd();
  const gap = section.slice(kept.length);
  const separator = kept.length === afterHeading ? "\n\n" : "\n";
  const trailing = gap.length === 0 && end < body.length ? "\n" : gap;
  return `${kept}${separator}${entry}${trailing}${body.slice(end)}`;
}
