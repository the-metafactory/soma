/**
 * The communication contract (`~/.soma/profile/communication.md`) — how the
 * assistant talks, as opposed to what it is allowed to do.
 *
 * Compartment placement (CONTEXT.md "compartment"): Identity owns "principal
 * profile, assistant profile, voice, personality", so the contract lives under
 * `profile/`. Operational boundaries — scope, permissions, evidence — are the
 * Policy compartment and live in `policy/behavior.md` instead. The split is
 * load-order-independent: a substrate reads both, but only one of them is a
 * rule about conduct.
 *
 * The file projects VERBATIM. Soma parses out only the two things code needs —
 * reference codes and aliases — and never re-renders the principal's prose,
 * because a lossy round-trip through a renderer is how authored nuance dies.
 * (Same contract as the memory INDEX, which also projects byte-for-byte.)
 */

/** A conversational reference-code family: the letter and what it labels. */
export interface ReferenceCodeDefinition {
  /** Single uppercase letter, e.g. `F`. */
  readonly letter: string;
  /** What codes in this family label, e.g. `findings`. */
  readonly label: string;
}

/** A short token that expands into a full instruction when it appears alone. */
export interface CommunicationAlias {
  /** The alias token as typed, e.g. `scr`. */
  readonly token: string;
  /** The instruction the token expands to. */
  readonly expansion: string;
}

export interface CommunicationContract {
  /** The authored file, verbatim. This is what projects. */
  readonly content: string;
  readonly referenceCodes: readonly ReferenceCodeDefinition[];
  readonly aliases: readonly CommunicationAlias[];
}

/**
 * Letters the Algorithm already owns, and what owns them. A conversational
 * reference code may not use these: `C1` is a VSA criterion and `P1` is a plan
 * step, both validated against each other in `algorithm.ts` (a plan step
 * naming an unknown criterion throws). Overloading either letter would make
 * "keep C1" ambiguous between a criterion and a chat finding — so the parser
 * rejects them at the source rather than letting the ambiguity reach a run.
 */
export const RESERVED_REFERENCE_LETTERS: Readonly<Record<string, string>> = {
  C: "VSA criteria",
  P: "Algorithm plan steps",
};

/**
 * The reference letter whose codes mirror into `AlgorithmRun.decisions`.
 * Decisions are the one conversational code family the Algorithm already has a
 * durable home for, so `D1` is not a parallel record — it is a handle on the
 * existing one.
 */
export const DECISION_REFERENCE_LETTER = "D";

export class ReservedReferenceLetterError extends Error {
  readonly letter: string;

  constructor(letter: string) {
    super(
      `Reference letter ${letter} is reserved for ${RESERVED_REFERENCE_LETTERS[letter]} — ` +
        `pick another letter for the conversational code family.`,
    );
    this.name = "ReservedReferenceLetterError";
    this.letter = letter;
  }
}

/** True when `letter` is reserved by the Algorithm's own code space. */
export function isReservedReferenceLetter(letter: string): boolean {
  return letter.toUpperCase() in RESERVED_REFERENCE_LETTERS;
}

/**
 * Split a reference code (`F1`, `D12`) into its letter and ordinal.
 * Returns undefined for anything that is not `<letter><digits>`.
 */
export function parseReferenceCode(code: string): { letter: string; ordinal: number } | undefined {
  const match = /^([A-Za-z])(\d+)$/.exec(code.trim());
  if (match === null) return undefined;
  const ordinal = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return undefined;
  return { letter: match[1].toUpperCase(), ordinal };
}

function sectionBody(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start === -1) return [];

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  return body;
}

/** `- key: value` bullets in a section, in source order. */
function keyedBullets(markdown: string, heading: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  for (const line of sectionBody(markdown, heading)) {
    const match = /^\s*[-*]\s+`?([^`:]+)`?\s*[:=]\s*(.+)$/.exec(line);
    if (match === null) continue;
    entries.push({ key: match[1].trim(), value: match[2].trim() });
  }
  return entries;
}

/**
 * Parse the contract. Unknown sections are ignored — the file is the
 * principal's to shape, and Soma reads only the two sections it acts on.
 *
 * A reserved letter in `## Reference codes` throws rather than being skipped:
 * silently dropping it would leave the principal believing `C` was adopted.
 */
export function parseCommunicationContract(markdown: string): CommunicationContract {
  const referenceCodes: ReferenceCodeDefinition[] = [];
  for (const { key, value } of keyedBullets(markdown, "Reference codes")) {
    const letter = key.trim().toUpperCase();
    if (!/^[A-Z]$/.test(letter)) continue;
    if (isReservedReferenceLetter(letter)) throw new ReservedReferenceLetterError(letter);
    referenceCodes.push({ letter, label: value });
  }

  const aliases = keyedBullets(markdown, "Aliases").map(({ key, value }) => ({
    token: key.trim(),
    expansion: value,
  }));

  return { content: markdown, referenceCodes, aliases };
}
