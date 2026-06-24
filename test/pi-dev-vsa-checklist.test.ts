import { describe, expect, test } from "bun:test";
import {
  renderVsaChecklistLines,
  type VsaChecklistCriterion,
} from "../src/adapters/pi-dev/extensions/vsa-checklist";

const sample: VsaChecklistCriterion[] = [
  { id: "ISC-1", title: "Phase parser identifies all markers", status: "passed" },
  { id: "ISC-2", title: "Widget renderer produces stable output", status: "passed" },
  { id: "ISC-3", title: "Install hook writes the extension", status: "pending" },
  { id: "ISC-4", title: "Live e2e against pi.dev", status: "dropped" },
  { id: "ISC-5", title: "Untriaged future criterion", status: "in-progress" },
];

describe("renderVsaChecklistLines", () => {
  test("returns default header + empty marker for zero criteria", () => {
    expect(renderVsaChecklistLines([])).toEqual(["## VSA Criteria", "(no criteria yet)"]);
  });

  test("maps statuses to canonical glyphs", () => {
    const lines = renderVsaChecklistLines(sample);

    expect(lines).toEqual([
      "## VSA Criteria",
      "[x] ISC-1: Phase parser identifies all markers",
      "[x] ISC-2: Widget renderer produces stable output",
      "[ ] ISC-3: Install hook writes the extension",
      "[-] ISC-4: Live e2e against pi.dev",
      "[ ] ISC-5: Untriaged future criterion", // unknown status → pending glyph
    ]);
  });

  test("honors custom header and empty line", () => {
    const lines = renderVsaChecklistLines([], { header: ["~~ active VSA ~~"], emptyLine: "—" });
    expect(lines).toEqual(["~~ active VSA ~~", "—"]);
  });

  test("respects an empty header array (no header lines)", () => {
    const lines = renderVsaChecklistLines(
      [{ id: "ISC-1", title: "Only criterion", status: "pending" }],
      { header: [] },
    );

    expect(lines).toEqual(["[ ] ISC-1: Only criterion"]);
  });
});

