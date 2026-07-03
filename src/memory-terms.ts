/**
 * The one memory tokenizer. Recall (`memory-recall.ts`), the legacy line-grep
 * search (`memory.ts`), and the write-path dedup floor (`memory-write.ts`) all
 * split text into terms the same way — a non-alphanumeric split (Latin +
 * Latin-1/Extended letters) keeping tokens of at least {@link MEMORY_TERM_MIN_LEN}
 * characters. Kept in one place so the three paths can't drift: a query that
 * matches on recall must tokenize identically to what dedup compared on write.
 */

/** Minimum term length; sub-3-char tokens are noise (matches the write-path floor). */
export const MEMORY_TERM_MIN_LEN = 3;

// Split on any run of non-alphanumeric characters. `À-ɏ` (U+00C0–U+024F) keeps
// Latin-1 Supplement + Latin Extended-A/B letters (accented forms) as term chars.
// The `i` flag is redundant once input is lowercased but is kept for parity with
// the pre-extraction call sites.
const MEMORY_TERM_SPLIT = /[^a-z0-9À-ɏ]+/i;

/** Split ALREADY-LOWERCASED text into terms (order-preserving, may repeat). */
function splitLowerTerms(lower: string): string[] {
  return lower
    .split(MEMORY_TERM_SPLIT)
    .map((term) => term.trim())
    .filter((term) => term.length >= MEMORY_TERM_MIN_LEN);
}

/**
 * Term SET for already-lowercased text — the write-path dedup shape (one
 * lowercase pass upstream feeds both hash and tokens, so this takes `lower`).
 */
export function memoryTermSet(lower: string): Set<string> {
  return new Set(splitLowerTerms(lower));
}

/**
 * Distinct terms of arbitrary text, in first-occurrence order — the query shape
 * used by recall and search. Lowercases internally.
 */
export function memoryTerms(text: string): string[] {
  return Array.from(memoryTermSet(text.toLowerCase()));
}
