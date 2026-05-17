import { describe, expect, test } from "bun:test";
import { renderSomaAlgorithmExtension } from "../src/adapters/pi-dev/extensions/soma-algorithm";
import { parseAlgorithmPhaseMarkers } from "../src/adapters/pi-dev/extensions/phase-parser";

describe("renderSomaAlgorithmExtension", () => {
  test("AC-1: default-exports a function and registers the /algorithm slash command", () => {
    const source = renderSomaAlgorithmExtension();

    // Default export shape — `(pi: ExtensionAPI) => void`.
    expect(source).toContain("export default function (pi: ExtensionAPI)");
    // Slash-command registration.
    expect(source).toContain('pi.registerCommand("algorithm"');
    // ExtensionAPI imported as a type-only dep — Soma does not depend
    // on pi-coding-agent at build time.
    expect(source).toContain('import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"');
  });

  test("AC-4/5/6: wires message_update + tool_result handlers and the soma status slot", () => {
    const source = renderSomaAlgorithmExtension();

    // Phase widget transitions fire on streamed model text.
    expect(source).toContain('"message_update"');
    // ISA criteria widget updates on isa_update tool results.
    expect(source).toContain('"tool_result"');
    expect(source).toContain('"isa_update"');
    // Footer status — the canonical "soma" slot.
    expect(source).toContain("SOMA_STATUS_KEY");
  });

  test("imports the pure-logic helpers from the Soma repo via file:// URLs", () => {
    const source = renderSomaAlgorithmExtension();

    expect(source).toMatch(/from "file:\/\/.*phase-parser\.ts"/u);
    expect(source).toMatch(/from "file:\/\/.*widget-renderers\.ts"/u);
    expect(source).toMatch(/from "file:\/\/.*isa-checklist\.ts"/u);
  });

  test("respects an explicit runtimeModuleDir override (used in tests + uninstall)", () => {
    const source = renderSomaAlgorithmExtension({ runtimeModuleDir: "file:///tmp/override/" });

    expect(source).toContain('from "file:///tmp/override/phase-parser.ts"');
    expect(source).toContain('from "file:///tmp/override/widget-renderers.ts"');
    expect(source).toContain('from "file:///tmp/override/isa-checklist.ts"');
  });

  test("flags the deferred version-probe (AC-10) inline in the generated source", () => {
    const source = renderSomaAlgorithmExtension();

    // Documented TODO so a reader of the on-disk extension can see what
    // was deferred. Cross-referenced in the follow-up issue.
    expect(source).toContain("TODO(#43 follow-up)");
  });

  test("ingest path caps per-phase body to keep memory bounded (Sage R2 perf)", () => {
    const source = renderSomaAlgorithmExtension();

    // The cap constant + the splice path are both present in the
    // rendered source. We deliberately assert on shape rather than
    // running the rendered code — that's reserved for the deferred
    // live-e2e AC (#43 AC-12 follow-up).
    expect(source).toContain("PHASE_BODY_LINE_CAP");
    expect(source).toContain("active.body.splice(0, overflow)");
    expect(source).toContain("PHASE_BODY_TRUNCATION_LINE");
  });

  test("ingest path flushes the carry for whole-message payloads (Sage R2 codequality)", () => {
    const source = renderSomaAlgorithmExtension();

    // Whole-message text/content payloads must be flushed so the final
    // unterminated line is parsed. Delta-only loop dropped it before
    // this fix.
    expect(source).toContain("flush?: boolean");
    expect(source).toContain('isDelta = typeof e.delta === "string"');
    expect(source).toContain("flush: !isDelta");
  });

  test("/algorithm primer emits canonical heavy-line markers the parser recognizes", () => {
    // Sage CodeQuality important: the primer must use the EXACT marker
    // format that parseAlgorithmPhaseMarkers accepts; otherwise a model
    // following the primer literally produces output the parser ignores
    // and the slash command does not drive phase widgets. We assert
    // both axes: the primer source contains heavy-line markers, AND
    // those markers parse back to all 8 canonical phases.
    const source = renderSomaAlgorithmExtension();

    // The primer is built inside a template literal in the generated
    // source. Extract the marker template line and confirm it has the
    // heavy-line frame on both sides of the emoji+name+digits triple.
    expect(source).toMatch(
      /━━━ \$\{d\.emoji\} \$\{d\.name\} ━━━ \$\{d\.position\}\/\$\{d\.total\}/u,
    );

    // Round-trip: render the primer the way the extension would at
    // runtime, then feed the result back through the parser.
    const primerLines = [
      "━━━ 👁️ OBSERVE ━━━ 1/7",
      "━━━ 🧠 THINK ━━━ 2/7",
      "━━━ 📋 PLAN ━━━ 3/7",
      "━━━ 🛠️ BUILD ━━━ 4/7",
      "━━━ ⚡ EXECUTE ━━━ 5/7",
      "━━━ ✅ VERIFY ━━━ 6/7",
      "━━━ 📚 LEARN ━━━ 7/7",
      "━━━ 📃 SUMMARY ━━━ 7/7",
    ];
    const markers = parseAlgorithmPhaseMarkers(primerLines.join("\n"));
    expect(markers.map((m) => m.phase)).toEqual([
      "observe",
      "think",
      "plan",
      "build",
      "execute",
      "verify",
      "learn",
      "summary",
    ]);
  });
});
