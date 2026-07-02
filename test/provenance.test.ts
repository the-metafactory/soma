import { expect, test } from "bun:test";
import {
  OVERLAY_BEGIN,
  OVERLAY_END,
  PROVENANCE_MARKER,
  extractOverlay,
  hasProvenanceHeader,
  hasUnmanagedEdit,
  provenanceHeader,
  renderOverlay,
  stripProvenance,
  withProvenance,
} from "../src/adapters/shared/provenance";

test("provenanceHeader is byte-stable (no timestamp) and names the substrate + refresh command", () => {
  const first = provenanceHeader("claude-code");
  const second = provenanceHeader("claude-code");
  expect(first).toBe(second);
  expect(first).toContain(PROVENANCE_MARKER);
  expect(first).toContain("soma install claude-code --apply");
  expect(first).toContain("not authoritative");
  // HTML comment so it stays invisible when the markdown renders.
  expect(first.startsWith("<!--")).toBe(true);
  expect(first.trimEnd().endsWith("-->")).toBe(true);
});

test("hasProvenanceHeader detects presence/absence", () => {
  expect(hasProvenanceHeader(withProvenance("codex", "# Body"))).toBe(true);
  expect(hasProvenanceHeader("# Body")).toBe(false);
});

test("withProvenance is idempotent — never stacks headers", () => {
  const once = withProvenance("grok", "# Body");
  const twice = withProvenance("grok", once);
  expect(twice).toBe(once);
  const markerCount = once.split(PROVENANCE_MARKER).length - 1;
  expect(markerCount).toBe(1);
});

test("extractOverlay returns null without a block, body when present", () => {
  expect(extractOverlay("# no overlay here")).toBeNull();
  const doc = [provenanceHeader("claude-code"), "", "# Generated", "", OVERLAY_BEGIN, "", "my local note", "", OVERLAY_END].join("\n");
  expect(extractOverlay(doc)).toBe("my local note");
});

test("renderOverlay round-trips a body through extractOverlay", () => {
  const block = renderOverlay("line one\nline two");
  expect(block).toContain(OVERLAY_BEGIN);
  expect(block).toContain(OVERLAY_END);
  expect(extractOverlay(block)).toBe("line one\nline two");
});

test("renderOverlay emits a preserved placeholder for an empty body", () => {
  const block = renderOverlay(null);
  expect(block).toContain(OVERLAY_BEGIN);
  expect(block).toContain(OVERLAY_END);
  // The markers survive so the next reprojection still finds an overlay.
  expect(extractOverlay(block)).not.toBeNull();
});

test("stripProvenance round-trips withProvenance and is a no-op on bare content", () => {
  const body = "# Skills\n\n- one\n- two";
  expect(stripProvenance(withProvenance("claude-code", body))).toBe(body);
  expect(stripProvenance(body)).toBe(body);
  // A leading HTML comment that is not a Soma header is left intact.
  const other = "<!-- unrelated -->\n\n# Body";
  expect(stripProvenance(other)).toBe(other);
});

test("hasUnmanagedEdit compares managed content modulo trailing whitespace", () => {
  const expected = "# Generated\n\nbody";
  expect(hasUnmanagedEdit("# Generated\n\nbody\n", expected)).toBe(false);
  expect(hasUnmanagedEdit("# Generated\n\nbody EDITED", expected)).toBe(true);
});
