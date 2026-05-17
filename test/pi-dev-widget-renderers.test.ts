import { describe, expect, test } from "bun:test";
import {
  isaCriteriaWidgetKey,
  phaseWidgetKey,
  renderPhaseOverviewLines,
  renderPhaseStatusText,
  renderPhaseWidgetLines,
  SOMA_STATUS_KEY,
} from "../src/adapters/pi-dev/extensions/widget-renderers";
import type { AlgorithmPhaseKey, PhaseMarker } from "../src/adapters/pi-dev/extensions/phase-parser";

function marker(phase: AlgorithmPhaseKey, position: number): PhaseMarker {
  return { phase, position, total: 7, lineIndex: 0, rawLine: `━━━ ${phase} ━━━ ${position}/7` };
}

describe("widget keys", () => {
  test("phase widget key includes runId, position, and phase slug (open Q2 resolution)", () => {
    expect(phaseWidgetKey({ runId: "run-abc", phase: "execute", position: 5 })).toBe("soma-run-abc-phase-5-execute");
  });

  test("auxiliary keys are runId-scoped", () => {
    expect(isaCriteriaWidgetKey("run-abc")).toBe("soma-run-abc-isa-criteria");
  });

  test("SOMA_STATUS_KEY is the fixed footer slot", () => {
    expect(SOMA_STATUS_KEY).toBe("soma");
  });
});

describe("renderPhaseWidgetLines", () => {
  test("renders header + body for an inactive widget", () => {
    const lines = renderPhaseWidgetLines({
      marker: marker("observe", 1),
      body: ["Current state restated.", "Goal: ship the slice."],
      active: false,
    });

    expect(lines).toEqual(["👁️ OBSERVE 1/7", "Current state restated.", "Goal: ship the slice."]);
  });

  test("appends ▸ active marker when active === true (AC-4 visual hint)", () => {
    const lines = renderPhaseWidgetLines({
      marker: marker("execute", 5),
      body: ["bun test"],
      active: true,
    });

    expect(lines).toEqual(["⚡ EXECUTE 5/7", "bun test", "▸ active"]);
  });

  test("returns just the header line for empty body", () => {
    const lines = renderPhaseWidgetLines({ marker: marker("plan", 3), body: [], active: false });

    expect(lines).toEqual(["📋 PLAN 3/7"]);
  });
});

describe("renderPhaseStatusText", () => {
  test("renders 'Phase N/7 — NAME' (AC-6)", () => {
    expect(renderPhaseStatusText({ marker: marker("execute", 5) })).toBe("Phase 5/7 — EXECUTE");
  });

  test("appends suffix with pipe separator when present", () => {
    expect(renderPhaseStatusText({ marker: marker("verify", 6), suffix: "ISA 3/7" })).toBe(
      "Phase 6/7 — VERIFY | ISA 3/7",
    );
  });
});

describe("renderPhaseOverviewLines", () => {
  test("renders the eight canonical descriptors with status glyphs", () => {
    const lines = renderPhaseOverviewLines({
      seenPhases: new Set<AlgorithmPhaseKey>(["observe", "think", "plan", "build", "execute"]),
      currentPhase: "execute",
    });

    expect(lines).toEqual([
      "## Algorithm Phases",
      "✓ 👁️ OBSERVE 1/7",
      "✓ 🧠 THINK 2/7",
      "✓ 📋 PLAN 3/7",
      "✓ 🛠️ BUILD 4/7",
      "▸ ⚡ EXECUTE 5/7",
      "· ✅ VERIFY 6/7",
      "· 📚 LEARN 7/7",
      "· 📃 SUMMARY 7/7",
    ]);
  });
});
