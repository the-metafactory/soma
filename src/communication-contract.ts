/**
 * The communication contract (`~/.soma/profile/communication.md`) — how the
 * assistant talks, as opposed to what it is allowed to do.
 *
 * Compartment placement (CONTEXT.md "compartment"): Identity owns "principal
 * profile, assistant profile, voice, personality", so the contract lives under
 * `profile/`. Operational boundaries — scope, permissions, evidence — are the
 * Policy compartment and live in `policy/behavior.md` instead.
 *
 * The file projects VERBATIM and Soma parses NOTHING out of it. Everything it
 * contains — patterns, banned phrases, reference-code families, aliases,
 * examples — does its work by being in the model's context, which the verbatim
 * projection already delivers. An earlier revision parsed the reference-code
 * and alias sections; both were representations with no reader, and the
 * reference-code parse additionally let a typo in a principal-authored prose
 * file throw out of `loadSomaHome` and fail every command that loads the home.
 *
 * What DOES need code is the reference-code space below. The reserved letters
 * are enforced where a collision can actually happen — the write path in
 * `algorithm.ts` — not at read time on a file whose text reaches the model
 * either way.
 */

/** The contract as projected: the authored file, verbatim. */
export interface CommunicationContract {
  readonly content: string;
}

/**
 * Letters the Algorithm already owns, and what owns them. A conversational
 * reference code may not use these: `C1` is a VSA criterion and `P1` is a plan
 * step, both validated against each other in `algorithm.ts` (a plan step
 * naming an unknown criterion throws). Overloading either letter would make
 * "keep C1" ambiguous between a criterion and a chat finding.
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
    // Normalized here, matching `isReservedReferenceLetter`: the two exports
    // must agree on their input contract, or a lowercase `c` produces
    // "reserved for undefined" (sage #636 r7).
    const normalized = letter.toUpperCase();
    super(
      `Reference letter ${normalized} is reserved for ${RESERVED_REFERENCE_LETTERS[normalized] ?? "the Algorithm"} — ` +
        `pick another letter for the conversational code family.`,
    );
    this.name = "ReservedReferenceLetterError";
    this.letter = normalized;
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
