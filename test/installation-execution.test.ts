import { expect, test } from "bun:test";
import { SomaInstallError, SomaInstallExecution } from "../src/installation-execution";
import type { SomaInstallOperation } from "../src/installation-execution";

const OPERATIONS: SomaInstallOperation[] = [
  "require-bun",
  "bootstrap-soma-home",
  "stage-runtime-artifact",
  "prepare-soma-home-skills",
  "validate-substrate",
  "install-vsa-skill",
  "build-projection-input",
  "write-home-projection",
  "remove-obsolete-home-files",
  "run-post-projection",
  "install-lifecycle-projection",
  "reconcile-owned-subtrees",
  "project-registry-skills",
];

test("installation execution throws the exact failed operation with its durable prefix", async () => {
  const execution = new SomaInstallExecution("codex");
  const somaHome = {
    somaHome: "/tmp/soma",
    context: {} as never,
    files: [],
  };
  execution.record({ somaHome });

  const cause = new Error("projection write failed");
  await expect(execution.run("write-home-projection", () => { throw cause; })).rejects.toMatchObject({
    name: "SomaInstallError",
    operation: "write-home-projection",
    partial: { substrate: "codex", somaHome },
    cause,
  });
});

test("installation execution preserves a typed error instead of nesting it", async () => {
  const execution = new SomaInstallExecution("codex");
  const original = new SomaInstallError({
    operation: "bootstrap-soma-home",
    partial: { substrate: "codex" },
    cause: new Error("home unavailable"),
  });

  await expect(execution.run("write-home-projection", () => { throw original; })).rejects.toBe(original);
});

test("every installation operation reports its exact name", async () => {
  for (const operation of OPERATIONS) {
    const execution = new SomaInstallExecution("codex");
    await expect(execution.run(operation, () => { throw new Error("failed"); })).rejects.toMatchObject({ operation });
  }
});
