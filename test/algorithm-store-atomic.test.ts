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
