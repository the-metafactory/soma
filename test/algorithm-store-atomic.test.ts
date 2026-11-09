import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createAlgorithmRun } from "../src/algorithm";
import {
  algorithmRunPath,
  claimAlgorithmRun,
  readAlgorithmRun,
  StaleOwnershipError,
  writeAlgorithmRun,
} from "../src/algorithm-store";

async function withHome<T>(fn: (opts: { homeDir: string }) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-atomic-"));
  try {
    return await fn({ homeDir });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function makeRun(id: string, goal = "Goal one") {
  return createAlgorithmRun({
    id,
    timestamp: "2026-11-09T10:00:00.000Z",
    prompt: "Atomic store test",
    intent: "Exercise the store.",
    currentState: "Nothing written.",
    goal,
    criteria: [{ id: "C1", text: "Store holds." }],
  });
}

test("a crash mid-save leaves the previous run intact and no partial file", async () => {
  await withHome(async (opts) => {
    const original = makeRun("atomic-1", "Original goal");
    const { path } = await writeAlgorithmRun(original, opts);
    const before = await readFile(path, "utf8");

    const updated = makeRun("atomic-1", "Replacement goal that is long enough to be cut in half");
    await expect(
      writeAlgorithmRun(updated, {
        ...opts,
        faultAfterPartialWrite: () => { throw new Error("simulated crash"); },
      }),
    ).rejects.toThrow("simulated crash");

    expect(await readFile(path, "utf8")).toBe(before);
    expect((await readAlgorithmRun(path)).id).toBe("atomic-1");
    const names = await readdir(join(path, ".."));
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

test("8 concurrent claims each win a distinct epoch, 1 through 8", async () => {
  await withHome(async (opts) => {
    await writeAlgorithmRun(makeRun("claim-1"), opts);
    const epochs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimAlgorithmRun("claim-1", `token-${i}`, opts)),
    );
    expect([...epochs].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const final = await readAlgorithmRun(algorithmRunPath({ id: "claim-1" }, opts));
    expect(final.ownership?.epoch).toBe(8);
  });
});

test("a write carrying a stale epoch is rejected and the file is unchanged", async () => {
  await withHome(async (opts) => {
    const run = makeRun("stale-1");
    await writeAlgorithmRun(run, opts);
    const epochA = await claimAlgorithmRun("stale-1", "A", opts);
    const epochB = await claimAlgorithmRun("stale-1", "B", opts);
    expect([epochA, epochB]).toEqual([1, 2]);

    const path = algorithmRunPath(run, opts);
    const before = await readFile(path, "utf8");
    const stale = makeRun("stale-1", "Written by the superseded owner");
    await expect(writeAlgorithmRun(stale, { ...opts, expectedEpoch: epochA })).rejects.toBeInstanceOf(StaleOwnershipError);
    expect(await readFile(path, "utf8")).toBe(before);

    await writeAlgorithmRun({ ...stale, ownership: { token: "B", epoch: epochB } }, { ...opts, expectedEpoch: epochB });
    expect((await readAlgorithmRun(path)).ownership).toEqual({ token: "B", epoch: epochB });
  });
});

test("a run file without ownership reads unchanged and claims to epoch 1", async () => {
  await withHome(async (opts) => {
    const run = makeRun("legacy-own");
    const { path } = await writeAlgorithmRun(run, opts);
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect("ownership" in raw).toBe(false);
    expect((await readAlgorithmRun(path)).ownership).toBeUndefined();
    expect(await claimAlgorithmRun("legacy-own", "T", opts)).toBe(1);
  });
});

test("an unfenced write of a pre-claim snapshot keeps the on-disk epoch, so no epoch is issued twice", async () => {
  await withHome(async (opts) => {
    const snapshot = makeRun("regress-1");
    await writeAlgorithmRun(snapshot, opts);
    const epochA = await claimAlgorithmRun("regress-1", "A", opts);
    // A legacy writer that read the run before the claim saves it back without a fence.
    await writeAlgorithmRun(snapshot, opts);
    const path = algorithmRunPath(snapshot, opts);
    expect((await readAlgorithmRun(path)).ownership).toEqual({ token: "A", epoch: epochA });

    const epochC = await claimAlgorithmRun("regress-1", "C", opts);
    expect(epochC).toBe(epochA + 1);
    await expect(
      writeAlgorithmRun({ ...snapshot, ownership: { token: "A", epoch: epochA } }, { ...opts, expectedEpoch: epochA }),
    ).rejects.toBeInstanceOf(StaleOwnershipError);
  });
});

test("a fenced write cannot rewrite ownership; only a claim moves the epoch", async () => {
  await withHome(async (opts) => {
    const run = makeRun("regress-2");
    await writeAlgorithmRun(run, opts);
    const epoch = await claimAlgorithmRun("regress-2", "B", opts);
    // Correct epoch, but the run object carries no ownership (or a forged one).
    await writeAlgorithmRun(run, { ...opts, expectedEpoch: epoch });
    await writeAlgorithmRun({ ...run, ownership: { token: "X", epoch: 0 } }, { ...opts, expectedEpoch: epoch });
    expect((await readAlgorithmRun(algorithmRunPath(run, opts))).ownership).toEqual({ token: "B", epoch });
  });
});

test("the temp file is written beside the run file, so the rename stays on one filesystem", async () => {
  await withHome(async (opts) => {
    const run = makeRun("beside-1");
    const { path } = await writeAlgorithmRun(run, opts);
    const dir = join(path, "..");
    let tmpNames: string[] = [];
    await writeAlgorithmRun(run, {
      ...opts,
      faultAfterPartialWrite: async () => { tmpNames = (await readdir(dir)).filter((n) => n.endsWith(".tmp")); },
    });
    expect(tmpNames.length).toBe(1);
    expect(tmpNames[0]!.startsWith("beside-1.json.")).toBe(true);
  });
});
