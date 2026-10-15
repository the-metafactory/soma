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
 * records whether the prompt surface denies it today. A rule change that
 * denies one more passage fails here, naming it; one that clears a passage
 * must flip its row in the same change, so a reviewer sees what cleared.
 * Some denied rows quote attack phrasings from review (#738's must-fire
 * shapes); clearing one of those is a regression, not a fix.
 *
 * A witnessed false positive lands here as a row (`"denied": true`) before
 * its fix, and the fix flips it.
 */

interface CorpusRow {
  source: string;
  denied: boolean;
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
          : `corpus.jsonl:${line} (${row.source}) no longer denied; set "denied": false if this clears a false positive, keep it if it quotes an attack phrasing`,
      );
    }
    expect(mismatches).toEqual([]);
    expect(rows.length).toBeGreaterThan(300);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
