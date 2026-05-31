import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const designDoc = readFileSync("docs/home-replication.md", "utf8");
const architecture = readFileSync("docs/architecture.md", "utf8");
const writeback = readFileSync("docs/writeback-and-policy.md", "utf8");
const decisions = readFileSync("design/design-decisions.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const context = readFileSync("CONTEXT.md", "utf8");

test("home replication design keeps Soma home authoritative", () => {
  expect(designDoc).toContain("home replication");
  expect(designDoc).toContain("The local home is authoritative while a machine is running.");
  expect(designDoc).toMatch(/The remote is an\s+exchange surface and audit history/);
  expect(architecture).toContain("Home replication");
  expect(context).toContain("## home replication");
  expect(context).toContain("Do not call the core model `sync`");
  expect(decisions).toContain("Soma home replication");
});

test("home replication has explicit privacy and scope gates", () => {
  for (const scope of ["identity", "telos", "skills", "policy", "isa", "state-events", "relationship", "raw", "security"]) {
    expect(designDoc).toContain(`\`${scope}\``);
  }
  expect(designDoc).toContain("snapshot safety ignores");
  expect(designDoc).toContain("Private scopes such as `relationship`, `raw`, and `security` require an");
  expect(decisions).toContain("raw and security scopes are off by default");
});

test("home replication defines deterministic merge boundaries", () => {
  expect(designDoc).toContain("`memory/STATE/events.jsonl` merges by event id");
  expect(designDoc).toContain("Session-Keyed Work State");
  expect(designDoc).toContain("concurrent edits are conflicts");
  expect(designDoc).toContain("replication-conflicts.json");
  expect(writeback).toContain("Home replication must preserve these conflict rules");
});

test("home replication uses snapshots before applying remote state", () => {
  expect(designDoc).toContain("must create a Soma snapshot before applying");
  expect(designDoc).toContain("snapshot-before-pull");
  expect(decisions).toMatch(/Every pull or exchange\s+operation snapshots before applying remote state/);
});

test("home replication is linked from public docs", () => {
  expect(readme).toContain("docs/home-replication.md");
  expect(architecture).toContain("docs/home-replication.md");
});
