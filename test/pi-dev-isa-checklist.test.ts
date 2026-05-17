import { describe, expect, test } from "bun:test";
import {
  renderIsaChecklistLines,
  type IsaChecklistCriterion,
} from "../src/adapters/pi-dev/extensions/isa-checklist";

const sample: IsaChecklistCriterion[] = [
  { id: "ISC-1", title: "Phase parser identifies all markers", status: "passed" },
  { id: "ISC-2", title: "Widget renderer produces stable output", status: "passed" },
  { id: "ISC-3", title: "Install hook writes the extension", status: "pending" },
  { id: "ISC-4", title: "Live e2e against pi.dev", status: "dropped" },
  { id: "ISC-5", title: "Untriaged future criterion", status: "in-progress" },
];

describe("renderIsaChecklistLines", () => {
  test("returns default header + empty marker for zero criteria", () => {
    expect(renderIsaChecklistLines([])).toEqual(["## ISA Criteria", "(no criteria yet)"]);
  });

  test("maps statuses to canonical glyphs", () => {
    const lines = renderIsaChecklistLines(sample);

    expect(lines).toEqual([
      "## ISA Criteria",
      "[x] ISC-1: Phase parser identifies all markers",
      "[x] ISC-2: Widget renderer produces stable output",
      "[ ] ISC-3: Install hook writes the extension",
      "[-] ISC-4: Live e2e against pi.dev",
      "[ ] ISC-5: Untriaged future criterion", // unknown status → pending glyph
    ]);
  });

  test("honors custom header and empty line", () => {
    const lines = renderIsaChecklistLines([], { header: ["~~ active ISA ~~"], emptyLine: "—" });
    expect(lines).toEqual(["~~ active ISA ~~", "—"]);
  });

  test("respects an empty header array (no header lines)", () => {
    const lines = renderIsaChecklistLines(
      [{ id: "ISC-1", title: "Only criterion", status: "pending" }],
      { header: [] },
    );

    expect(lines).toEqual(["[ ] ISC-1: Only criterion"]);
  });
});

