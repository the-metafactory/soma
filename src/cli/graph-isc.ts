/**
 * ISC citations on new nodes (principal decision D1, 2026-11-17).
 *
 * A product repo with a root `VSA.md` names its criteria as checkbox lines
 * `- [ ] ISC-<n>: …`. Ranger refuses to claim a task or build node that cites
 * none of them, so `soma graph add`, the one verb every node is filed through,
 * refuses to file such a node in the first place. The criterion grammar is
 * ranger's, character for character: the two must agree on what counts.
 */

const ISC_ID_SOURCE = String.raw`ISC-\d+(?:\.\d+)?`;

/** Ranger's criterion line, verbatim. */
const VSA_CRITERION = new RegExp(String.raw`^\s*[-*]\s+\[[ xX]\]\s+(${ISC_ID_SOURCE})\b`, "gmu");
export const ISC_ID = new RegExp(`^${ISC_ID_SOURCE}$`, "u");
export const VSA_FILE = "VSA.md";
const CITING_KINDS: ReadonlySet<string> = new Set(["task", "build"]);

export type IscCitation = { ids: string[] } | { none: string };

/** Every criterion id the VSA declares, in file order, without repeats. */
export function vsaCriterionIds(vsa: string): string[] {
  return [...new Set([...vsa.matchAll(VSA_CRITERION)].map((match) => match[1]))];
}

export function kindNeedsIscCitation(kind: unknown): boolean {
  return typeof kind === "string" && CITING_KINDS.has(kind.trim().toLowerCase());
}

/** The paragraph the node body carries. */
export function iscCitationLine(citation: IscCitation): string {
  return "ids" in citation ? `Serves: ${citation.ids.join(", ")}.` : `ISC: none (${citation.none})`;
}

/**
 * Why `citation` cannot be filed against `vsa`, or undefined when it can.
 * `vsa` undefined means the repo has no VSA.md: nothing is enforced.
 */
export function iscCitationRefusal(options: {
  kind: unknown;
  citation: IscCitation | undefined;
  vsa: string | undefined;
  where: string;
}): string | undefined {
  const { citation, vsa, where } = options;
  if (vsa === undefined) return undefined;
  if (citation === undefined) {
    if (!kindNeedsIscCitation(options.kind)) return undefined;
    return `${where} has a ${VSA_FILE}, so a ${String(options.kind)} node must cite the criterion it moves. Pass --isc ISC-n (repeatable), or --isc-none "<reason>" when no criterion fits.`;
  }
  if (!("ids" in citation)) return undefined;
  const known = vsaCriterionIds(vsa);
  const unknown = citation.ids.filter((id) => !known.includes(id));
  if (unknown.length === 0) return undefined;
  const valid = known.length === 0 ? "it declares no criteria" : `valid ids: ${known.join(", ")}`;
  return `${unknown.join(", ")} ${unknown.length === 1 ? "is not a criterion" : "are not criteria"} in ${VSA_FILE} on ${where}'s default branch (${valid}). Criteria are its "- [ ] ISC-n:" lines.`;
}

/** The citation lines ranger writes into a body itself, in place of the flags. */
const BODY_SERVES = new RegExp(String.raw`^Serves: (${ISC_ID_SOURCE}(?:, ${ISC_ID_SOURCE})*)\.?\s*$`, "mu");
const BODY_NONE = /^ISC: none \((.+)\)\s*$/mu;

/** The citation a body already carries as a `Serves:` or `ISC: none (…)` line, if any. */
export function bodyIscCitation(body: string | undefined): IscCitation | undefined {
  if (body === undefined) return undefined;
  const serves = BODY_SERVES.exec(body);
  if (serves !== null) return { ids: serves[1].split(", ") };
  const none = BODY_NONE.exec(body)?.[1].trim();
  return none === undefined || none.length === 0 ? undefined : { none };
}

/**
 * The body to file: a flag's citation line opens it, unless the body already
 * has that exact line; with no flag the body is filed as given.
 */
export function citedBody(citation: IscCitation | undefined, body: string | undefined): string | undefined {
  if (citation === undefined) return body;
  const line = iscCitationLine(citation);
  if (body === undefined || body.trim().length === 0) return line;
  return body.split("\n").some((row) => row.trim() === line) ? body : `${line}\n\n${body}`;
}
