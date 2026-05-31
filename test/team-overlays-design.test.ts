import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const designDoc = readFileSync("docs/team-overlays.md", "utf8");
const context = readFileSync("CONTEXT.md", "utf8");
const architecture = readFileSync("docs/architecture.md", "utf8");
const boundaries = readFileSync("docs/boundaries.md", "utf8");
const decisions = readFileSync("design/design-decisions.md", "utf8");
const readme = readFileSync("README.md", "utf8");

test("team overlay design keeps the personal Soma home single-principal", () => {
  expect(designDoc).toContain("Team overlays do not make a Soma home multi-principal");
  expect(designDoc).toMatch(/A Soma home remains\s+owned by exactly one principal/);
  expect(context).toContain("## team overlay");
  expect(decisions).toContain("personal Soma home remains single-principal");
});

test("team overlay design denies personal-private compartments", () => {
  for (const denied of ["Identity", "Telos", "Relationship", "Raw/security"]) {
    expect(designDoc).toContain(denied);
  }
  expect(designDoc).toContain("Personal relationship memory is private");
  expect(decisions).toMatch(/Identity,\s+Telos, Relationship, raw transcripts, and security traces are never mounted\s+from a team overlay/);
});

test("team overlay design starts read-only and keeps provenance", () => {
  expect(designDoc).toContain('"mode": "read-only"');
  expect(designDoc).toContain("team/source/version provenance");
  expect(designDoc).toContain("Follow-up work can add reviewed team writeback");
  expect(decisions).toContain("Team overlays start read-only");
});

test("team overlay design preserves Arc and Compass ownership", () => {
  expect(designDoc).toContain("Arc owns distribution");
  expect(designDoc).toContain("Compass owns SOPs and governance");
  expect(boundaries).toContain("Team skill distribution | Arc");
  expect(boundaries).toContain("Team SOPs and governance | Compass");
});

test("team overlay design is linked from public architecture docs", () => {
  expect(readme).toContain("docs/team-overlays.md");
  expect(architecture).toContain("docs/team-overlays.md");
});
