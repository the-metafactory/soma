import { describe, expect, test } from "bun:test";
import { renderSomaAlgorithmExtension } from "../src/adapters/pi-dev/extensions/soma-algorithm";

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
});
