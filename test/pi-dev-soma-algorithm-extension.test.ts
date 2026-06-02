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

    // Phase widget transitions fire on streamed model text. The
    // generated extension uses a local `on(event, handler)` helper
    // (Sage R9 maintainability) to deduplicate the ExtensionAPI cast.
    expect(source).toContain('on("message_update"');
    // ISA criteria widget updates on isa_update tool results.
    expect(source).toContain('on("tool_result"');
    expect(source).toContain('"isa_update"');
    // Footer status — the canonical "soma" slot.
    expect(source).toContain("SOMA_STATUS_KEY");
  });

  test("imports the pure-logic helpers from the Soma repo via file:// URLs", () => {
    const source = renderSomaAlgorithmExtension();

    expect(source).toMatch(/from "file:\/\/.*phase-parser\.ts"/u);
    expect(source).toMatch(/from "file:\/\/.*widget-renderers\.ts"/u);
    expect(source).toMatch(/from "file:\/\/.*isa-checklist\.ts"/u);
    expect(source).toMatch(/from "file:\/\/.*\/src\/policy-audit\.ts"/u);
    expect(source).toMatch(/from "file:\/\/.*\/src\/adapters\/pi-dev\/extensions\/policy-targets\.ts"/u);
    expect(source).toMatch(/from "file:\/\/.*\/src\/adapters\/pi-dev\/algorithm-run-snapshot\.ts"/u);
  });

  test("respects an explicit runtimeModuleDir override (used in tests + uninstall)", () => {
    const source = renderSomaAlgorithmExtension({ runtimeModuleDir: "file:///tmp/override/" });

    expect(source).toContain('from "file:///tmp/override/phase-parser.ts"');
    expect(source).toContain('from "file:///tmp/override/widget-renderers.ts"');
    expect(source).toContain('from "file:///tmp/override/isa-checklist.ts"');
    expect(source).toContain('from "file:///tmp/override/policy-audit.ts"');
    expect(source).toContain('from "file:///tmp/override/policy-targets.ts"');
    expect(source).toContain('from "file:///tmp/override/algorithm-run-snapshot.ts"');
  });

  test("renders the installed Soma home into policy checks", () => {
    const source = renderSomaAlgorithmExtension({ somaHome: "/workspace/.soma" });

    expect(source).toContain('const INSTALLED_SOMA_HOME = "/workspace/.soma"');
    expect(source).toContain("return INSTALLED_SOMA_HOME");
  });

  test("#85 AC-7: tool_call during EXECUTE runs Soma policy and can block", () => {
    const source = renderSomaAlgorithmExtension();

    expect(source).toContain('on("tool_call"');
    expect(source).toContain("runSomaPolicyCheck");
    expect(source).toContain('run.currentPhase !== "execute"');
    expect(source).toContain('return { block: true, reason: policy.reason }');
    expect(source).toContain("checkSomaPolicy");
    expect(source).toContain("policy-audit.ts");
    expect(source).toContain("policy-targets.ts");
    expect(source).toContain("extractToolCallPolicyTargets");
    expect(source).toContain("somaPolicyActionForToolAction");
    expect(source).toContain('const cwd = typeof (ctx as { cwd?: unknown }).cwd === "string"');
    expect(source).toContain("cwd,");
    expect(source).toContain("sourcePath,");
    expect(source).toContain("content,");
    expect(source).toContain('action: "modify"');
    expect(source).toContain("Promise.all");
    expect(source).toContain("if (extraction.targets.length === 0) return { block: false, reason: \"\" }");
    expect(source).toContain("MAX_POLICY_TARGETS");
    expect(source).not.toContain("execFileAsync");
    expect(source).not.toContain("spawnSync");
    expect(source).toContain("extraction.blockReason");
    expect(source).toContain('substrate: "pi-dev"');
    expect(source).toContain('record: "deny"');
  });

  test("#85 AC-8/9: session_start restores and compaction checkpoints run state", () => {
    const source = renderSomaAlgorithmExtension();

    expect(source).toContain('const SOMA_ALGORITHM_ENTRY_KIND = "soma-algorithm-run"');
    expect(source).toContain("function checkpointRun");
    expect(source).toContain("function restoreLatestRun");
    expect(source).toContain("function isRunComplete");
    expect(source).toContain("isAlgorithmRunSnapshotComplete(run)");
    expect(source).toContain("hydrateAlgorithmRunSnapshot");
    expect(source).toContain("snapshotAlgorithmRunState");
    expect(source).toContain("isRunComplete(run)) return");
    expect(source).toContain("MAX_CHECKPOINTS_PER_RUN");
    expect(source).toContain("RESTORE_ENTRY_SCAN_LIMIT");
    expect(source).toContain("readEntries?.(SOMA_ALGORITHM_ENTRY_KIND, { limit: RESTORE_ENTRY_SCAN_LIMIT })");
    expect(source).toContain("entries.slice(-RESTORE_ENTRY_SCAN_LIMIT).reverse()");
    expect(source).toContain(".appendEntry");
    expect(source).toContain(".readEntries");
    expect(source).toContain('on("session_start"');
    expect(source).toContain('checkpointRun(pi, run, "session_before_compact")');
  });

  test("#290: terminal events refresh shared Algorithm provenance through lifecycle", () => {
    const source = renderSomaAlgorithmExtension();

    expect(source).toContain('function runSomaLifecycle(event: "algorithm-observed"): void');
    expect(source).toContain('execFile("bun"');
    expect(source).toContain("SOMA_CLI_ENTRYPOINT");
    expect(source).toContain('"algorithm-observed"');
    expect(source).toContain('"--substrate", "pi-dev"');
    expect(source).toContain('runSomaLifecycle("algorithm-observed");');
    expect(source).not.toContain("SOMA_REPO");
    expect(source).not.toContain("soma-repo.txt");
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

  test("ingest path supports a flush option (used by terminal-event hooks)", () => {
    const source = renderSomaAlgorithmExtension();

    // The ingestStream contract supports a `flush` option; it is wired
    // ONLY to terminal-event hooks (agent_end/message_end/etc) — not
    // to message_update (Sage R5 fix: snapshot mode partial-line bug).
    expect(source).toContain("flush?: boolean");
    expect(source).toContain('isDelta = typeof e.delta === "string"');
  });

  test("terminal events flush the carry so final unterminated lines parse (Sage R5)", () => {
    const source = renderSomaAlgorithmExtension();

    // R2 said: flush in message_update.
    // R5 said: snapshot mode partial lines must NOT flush in message_update.
    // Resolution: flush only on terminal events (agent_end, message_end,
    // session_before_compact, session_shutdown).
    expect(source).toContain('"agent_end"');
    expect(source).toContain('"message_end"');
    expect(source).toContain('"session_before_compact"');
    expect(source).toContain('"session_shutdown"');
    expect(source).toContain('ingestStream("", defaultRunId(), { flush: true })');
  });

  test("snapshot reset clears stale carry from previous message (Sage R6 codequality)", () => {
    const source = renderSomaAlgorithmExtension();

    // When raw.length < lastSnapshotLength, a new message started.
    // We MUST clear run.carry too — otherwise the prior unterminated
    // tail would be joined onto the new message and corrupt the
    // first parsed line.
    expect(source).toContain("run.lastSnapshotLength = 0;");
    expect(source).toContain('run.carry = "";');
  });

  test("repeated phase markers coalesce instead of accumulating (Sage R6 perf)", () => {
    const source = renderSomaAlgorithmExtension();

    // The parser permits duplicate markers (a long run may re-emit a
    // phase header after a tool-call interlude). The runtime must
    // collapse those onto the existing SeenPhase record so memory +
    // render work don't grow with the marker count.
    expect(source).toContain("run.seenPhases.find((s) => s.marker.phase === m.phase)");
  });

  test("body lines attribute to activePhase, not seenPhases[last] (Sage R7 codequality)", () => {
    const source = renderSomaAlgorithmExtension();

    // After coalesce reactivates an earlier phase, body lines must
    // route to THAT phase's widget — not to the most-recently-pushed
    // phase. RunState carries an activePhase ref; processLine /
    // renderActivePhase / renderStatus all read from it.
    expect(source).toContain("activePhase?: SeenPhase");
    expect(source).toContain("run.activePhase = existing");
    expect(source).toContain("run.activePhase = fresh");
    expect(source).toContain("const active = run.activePhase");
    expect(source).toContain("if (run.activePhase) renderPhaseWidget");
  });

  test("streamed text + carry are byte-capped against DoS (Sage R7 security)", () => {
    const source = renderSomaAlgorithmExtension();

    expect(source).toContain("STREAM_INPUT_MAX_BYTES");
    expect(source).toContain("CARRY_MAX_BYTES");
    expect(source).toContain("chunk.length > STREAM_INPUT_MAX_BYTES");
    expect(source).toContain("run.carry.length > CARRY_MAX_BYTES");
  });

  test("snapshot cap applies AFTER cursor advance, not before (Sage R8 codequality)", () => {
    const source = renderSomaAlgorithmExtension();

    // R7 byte-cap, applied to the raw snapshot, would drift the
    // cursor when snapshots exceed the cap. R8 fix: cursor first,
    // cap after. Verified by ordering of the cursor-advance vs the
    // cap clause in the rendered extension.
    const cursorIdx = source.indexOf("run.lastSnapshotLength = raw.length");
    const capIdx = source.indexOf("chunk.length > STREAM_INPUT_MAX_BYTES");
    expect(cursorIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(-1);
    expect(cursorIdx).toBeLessThan(capIdx);
  });

  test("tool_result handler validates the untyped boundary (Sage R3 security)", () => {
    const source = renderSomaAlgorithmExtension();

    // sanitizeIsaCriteria coerces unknown payloads to a typed array,
    // dropping malformed entries silently. Crash-proofs the checklist
    // renderer against adversarial or malformed isa_update results.
    expect(source).toContain("function sanitizeIsaCriteria(result: unknown)");
    expect(source).toContain("Array.isArray(raw)");
    expect(source).toContain('typeof e.id !== "string"');
    expect(source).toContain('typeof e.title !== "string"');
    expect(source).toContain('typeof e.status !== "string"');
  });

  test("message_update uses targeted render when only body grew (Sage R3 perf)", () => {
    const source = renderSomaAlgorithmExtension();

    // Phase transitions need full re-render (overview + new phase
    // widget); body-only deltas need only the active phase widget +
    // status. Both render paths are present + dispatched on
    // phaseAdded.
    expect(source).toContain("function renderActivePhase");
    expect(source).toContain("if (phaseAdded) renderAllPhases(pi, ctx, run);");
    expect(source).toContain("else renderActivePhase(pi, ctx, run);");
  });

  test("snapshot-mode message_update ingests only the new suffix (Sage R4 perf)", () => {
    const source = renderSomaAlgorithmExtension();

    // Pi.dev may deliver text/content as growing snapshots. Each event
    // includes everything prior; we slice to the unconsumed suffix so
    // we don't reparse the whole transcript on every event.
    expect(source).toContain("lastSnapshotLength");
    expect(source).toContain("raw.slice(run.lastSnapshotLength)");
    // Snapshot shrank → reset (new message started).
    expect(source).toContain("raw.length < run.lastSnapshotLength");
  });

  test("sanitizeIsaCriteria bounds payload size + per-field length (Sage R4 security)", () => {
    const source = renderSomaAlgorithmExtension();

    expect(source).toContain("ISA_CRITERIA_MAX_COUNT");
    expect(source).toContain("ISA_CRITERIA_FIELD_MAX_LENGTH");
    expect(source).toContain("if (out.length >= ISA_CRITERIA_MAX_COUNT) break");
    expect(source).toContain("clip(e.id)");
    expect(source).toContain("clip(e.title)");
    expect(source).toContain("clip(e.status)");
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
