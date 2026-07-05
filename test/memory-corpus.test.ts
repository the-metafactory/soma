import { expect, test } from "bun:test";
import { jaccard, NEAR_DUPLICATE_JACCARD_THRESHOLD, noteDateMs, ageDays, sanitizeNoteText } from "../src/memory-corpus";

// --- jaccard -------------------------------------------------------------------

test("jaccard is 0 for two empty sets", () => {
  expect(jaccard(new Set(), new Set())).toBe(0);
});

test("jaccard is 1 for identical non-empty sets", () => {
  const a = new Set(["gateway", "retries"]);
  expect(jaccard(a, new Set(a))).toBe(1);
});

test("jaccard is |intersection|/|union| for partially overlapping sets", () => {
  const a = new Set(["gateway", "retries", "thrice"]);
  const b = new Set(["gateway", "retries", "dead-letter"]);
  // intersection = {gateway, retries} = 2; union = {gateway, retries, thrice, dead-letter} = 4
  expect(jaccard(a, b)).toBe(0.5);
});

test("jaccard is 0 for disjoint non-empty sets", () => {
  expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
});

test("NEAR_DUPLICATE_JACCARD_THRESHOLD is the shared 0.6 floor", () => {
  expect(NEAR_DUPLICATE_JACCARD_THRESHOLD).toBe(0.6);
});

// --- dates -----------------------------------------------------------------

test("noteDateMs resolves a YYYY-MM-DD date to UTC midnight", () => {
  expect(noteDateMs("2026-07-04")).toBe(Date.UTC(2026, 6, 4));
});

test("ageDays computes whole days since a past date", () => {
  const now = new Date("2026-07-14T10:00:00.000Z");
  expect(ageDays("2026-07-04", now)).toBe(10);
});

test("ageDays clamps a future/clock-skewed date to 0, never negative", () => {
  const now = new Date("2026-07-04T10:00:00.000Z");
  expect(ageDays("2026-08-01", now)).toBe(0);
});

// --- sanitizeNoteText (SECURITY-CRITICAL) ---------------------------------------

test("sanitizeNoteText strips a CSI color escape and a stray BEL, keeping visible text", () => {
  const payload = "Alert \x1b[31mRED\x1b[0m gateway \x07 done";
  const out = sanitizeNoteText(payload);
  expect(out).not.toContain("\x1b");
  expect(out).not.toContain("\x07");
  expect(out).toBe("Alert RED gateway  done");
});

test("sanitizeNoteText strips an OSC 8 hyperlink-spoofing payload", () => {
  // OSC 8 ; params ; URI ST "label" OSC 8 ;; ST — a terminal that honors this
  // renders "label" as a clickable hyperlink to an attacker-controlled URI.
  const payload = "click \x1b]8;;http://evil.example\x07here\x1b]8;;\x07 now";
  const out = sanitizeNoteText(payload);
  expect(out).not.toContain("\x1b");
  expect(out).not.toContain("evil.example");
  expect(out).toBe("click here now");
});

test("sanitizeNoteText strips an 8-bit C1 CSI sequence as a whole (params too, not just the introducer)", () => {
  // 0x9b is the single-byte C1 CSI introducer — no leading ESC. A naive
  // control-byte strip removes 0x9b but leaves "31m" as literal text.
  const payload = "Alert \x9b31mRED\x9b0m gateway done";
  const out = sanitizeNoteText(payload);
  expect(out).not.toContain("\x9b");
  expect(out).not.toContain("31m");
  expect(out).not.toContain("0m");
  expect(out).toBe("Alert RED gateway done");
});

test("sanitizeNoteText strips an 8-bit C1 OSC hyperlink-spoofing payload", () => {
  // 0x9d is the single-byte C1 OSC introducer; 0x9c (C1 ST) terminates it.
  const payload = "click \x9d8;;http://evil.example\x9chere\x9d8;;\x9c now";
  const out = sanitizeNoteText(payload);
  expect(out).not.toContain("\x9d");
  expect(out).not.toContain("evil.example");
  expect(out).toBe("click here now");
});

test("sanitizeNoteText (default) preserves tabs and newlines for multi-line rendering", () => {
  expect(sanitizeNoteText("line one\nline\ttwo")).toBe("line one\nline\ttwo");
});

test("sanitizeNoteText({ oneLine: true }) collapses all whitespace (incl. newlines) to single spaces and trims", () => {
  expect(sanitizeNoteText("  first line  \n\n  second line  ", { oneLine: true })).toBe("first line second line");
});

test("sanitizeNoteText({ oneLine: true }) also strips escapes before collapsing", () => {
  const payload = "\x1b[31malert\x1b[0m\nline two";
  expect(sanitizeNoteText(payload, { oneLine: true })).toBe("alert line two");
});
