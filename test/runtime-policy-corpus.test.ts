import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, inspectRuntimePolicy } from "../src/index";

/**
 * The prompt rules measured on real text, not on cases picked for one fix.
 *
 * Four runtime-policy fixes (#472, #658, #738, #791) each narrowed the one
 * false positive in front of them, and the next one arrived from a new source
 * of ordinary prose: security-engineering notes, review findings quoted into
 * headless `claude -p` passes, commit bodies, CONTEXT.md. #738's own body says
 * "Three per-instance narrowings had not closed the class."
 *
 * The corpus holds 372 passages of this repo's own review comments, commit
 * bodies and docs that put a guarded verb near a guarded noun. Each row
 * records whether the prompt surface denies it today:
 *
 * - `"denied": false` must stay allowed; a rule change that denies it fails.
 * - `"denied": true, "mustFire": true` quotes an attack phrasing that review
 *   or the must-fire tests pin (#738, #791). Clearing it is a regression; the
 *   test fails and no edit to the row is the fix.
 * - `"denied": true, "mustFire": false` is a known false positive. A fix that
 *   clears it flips the row to `"denied": false` in the same change, so a
 *   reviewer sees what cleared.
 *
 * A witnessed false positive lands here as a `"mustFire": false` row before
 * its fix, and the fix flips it.
 */

interface CorpusRow {
  source: string;
  denied: boolean;
  /** Only on denied rows: true when the row quotes an attack phrasing that must keep firing. */
  mustFire?: boolean;
  text: string;
}

const CORPUS_PATH = join(import.meta.dir, "fixtures/runtime-policy/corpus.jsonl");

test("the prompt rules deny exactly the corpus rows marked denied", async () => {
  const rows = (await readFile(CORPUS_PATH, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CorpusRow);
  const homeDir = await mkdtemp(join(tmpdir(), "soma-runtime-policy-corpus-"));
  try {
    await bootstrapSomaHome({ homeDir });
    const mismatches: string[] = [];
    for (const [index, row] of rows.entries()) {
      const result = await inspectRuntimePolicy({ homeDir, surface: "prompt", prompt: row.text, record: "none" });
      const denied = result.decision === "deny";
      if (denied === row.denied) continue;
      const line = String(index + 1);
      mismatches.push(
        denied
          ? `corpus.jsonl:${line} (${row.source}) is now denied: ${result.reason}`
          : row.mustFire === true
            ? `corpus.jsonl:${line} (${row.source}) quotes an attack phrasing and no longer fires: the rule change regressed`
            : `corpus.jsonl:${line} (${row.source}) known false positive now cleared: set "denied": false and drop "mustFire"`,
      );
    }
    expect(mismatches).toEqual([]);
    expect(rows.length).toBeGreaterThan(300);
    expect(rows.filter((row) => row.denied && typeof row.mustFire !== "boolean")).toEqual([]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
