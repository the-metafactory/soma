import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const daemonDoc = readFileSync("docs/daemon-mode.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const architecture = readFileSync("docs/architecture.md", "utf8");
const boundaries = readFileSync("docs/boundaries.md", "utf8");
const progressiveLoading = readFileSync("docs/progressive-skill-loading.md", "utf8");
const substrateAdapters = readFileSync("docs/substrate-adapters.md", "utf8");
const decisions = readFileSync("design/design-decisions.md", "utf8");

test("daemon design keeps Myelin protocol ownership outside Soma", () => {
  expect(daemonDoc).toMatch(/Myelin\s+owns transport and envelope semantics/);
  expect(daemonDoc).toMatch(/exact subject names,\s+wire versions, credentials, and retry policy must come from Myelin\/Cortex/);
  expect(boundaries).toContain("not a new bus contract");
  expect(boundaries).toContain("daemon-mode.md");
  expect(decisions).toMatch(/daemon mode consumes Myelin contracts without owning\s+the bus/);
});

test("daemon design defines a dry-run and health first slice before live subscription", () => {
  expect(daemonDoc).toContain("soma daemon --dry-run");
  expect(daemonDoc).toContain("soma daemon --health");
  expect(daemonDoc).toContain("The second slice can add read-only subscription");
  expect(decisions).toContain("Live subscription, work claiming, substrate");
});

test("daemon design preserves policy, writeback, and private compartments", () => {
  expect(daemonDoc).toContain("Every inbound envelope is policy-checked");
  expect(daemonDoc).toContain("same writeback gate used by substrate sessions");
  expect(daemonDoc).toContain("must not expose Identity, Telos, Relationship, raw transcripts, or");
});

test("daemon design is linked from architecture and routing docs", () => {
  expect(readme).toContain("docs/daemon-mode.md");
  expect(architecture).toContain("docs/daemon-mode.md");
  expect(progressiveLoading).toContain("daemon-mode.md");
  expect(substrateAdapters).toContain("daemon-mode.md");
});
