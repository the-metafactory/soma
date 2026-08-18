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

import { splitMarkdownSections } from "./markdown-sections";

export interface CommunicationContract {
  /** The authored file, verbatim. This is what projects. */
  readonly content: string;
  /**
   * The uppercase letters declared under `## Reference codes`. Only the letters
   * are kept: their labels, and the whole `## Aliases` section, reach the model
   * through the verbatim projection, so parsing them would add a representation
   * with no reader. The letters are parsed because the reserved-letter check
   * has a real effect — it refuses a contract that claims `C` or `P`.
   */
  readonly referenceCodes: readonly string[];
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

/**
 * Parse, validate, and normalize a reference code in one step: the form both
 * `recordAlgorithmReference` and `resolveAlgorithmReference` need, kept here so
 * the error wording lives in exactly one place.
 */
export function requireReferenceCode(raw: string): { code: string; letter: string; ordinal: number } {
  const parsed = parseReferenceCode(raw);
  if (parsed === undefined) {
    throw new Error(`Algorithm reference code must be a letter followed by a positive ordinal (e.g. F1), got: ${raw}`);
  }
  return { code: `${parsed.letter}${parsed.ordinal}`, ...parsed };
}

function sectionBody(markdown: string, heading: string): readonly string[] {
  const wanted = heading.toLowerCase();
  return splitMarkdownSections(markdown).find((section) => section.heading.toLowerCase() === wanted)?.lines ?? [];
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
 * principal's to shape, and Soma reads only the one section it acts on.
 *
 * A reserved letter in `## Reference codes` throws rather than being skipped:
 * silently dropping it would leave the principal believing `C` was adopted.
 */
export function parseCommunicationContract(markdown: string): CommunicationContract {
  const referenceCodes: string[] = [];
  for (const { key } of keyedBullets(markdown, "Reference codes")) {
    const letter = key.trim().toUpperCase();
    if (!/^[A-Z]$/.test(letter)) continue;
    if (isReservedReferenceLetter(letter)) throw new ReservedReferenceLetterError(letter);
    referenceCodes.push(letter);
  }

  return { content: markdown, referenceCodes };
}
