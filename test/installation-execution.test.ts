import { expect, test } from "bun:test";
import { SomaInstallError } from "../src/installation-execution";
import type { SomaInstallOperation } from "../src/installation-execution";

const OPERATIONS: SomaInstallOperation[] = [
  "require-bun",
  "bootstrap-soma-home",
  "stage-runtime-artifact",
  "prune-legacy-vsa-skill",
  "install-soma-home-vsa-skill",
  "install-bundled-skills",
  "reload-soma-home-context",
  "validate-substrate",
  "prepare-substrate-vsa-skill",
  "install-substrate-vsa-skill",
  "build-projection-input",
  "write-home-projection",
  "remove-obsolete-home-files",
  "run-post-projection",
  "install-lifecycle-projection",
  "reconcile-owned-subtrees",
  "project-registry-skills",
];

test("installation errors preserve a snapshot of the durable prefix", () => {
  const somaHome = {
    somaHome: "/tmp/soma",
    context: {} as never,
    files: [] as string[],
  };
  const cause = new Error("projection write failed");
  const error = new SomaInstallError({
    operation: "write-home-projection",
    partial: { substrate: "codex", somaHome },
    cause,
  });
  somaHome.files.push("/tmp/soma/later-file");

  expect(error).toMatchObject({
    name: "SomaInstallError",
    operation: "write-home-projection",
    partial: { substrate: "codex", somaHome: { ...somaHome, files: [] } },
    cause,
  });
  expect(error.partial.somaHome?.files).toEqual([]);
});

test("every declared installation operation can label a typed failure", () => {
  for (const operation of OPERATIONS) {
    expect(new SomaInstallError({
      operation,
      partial: { substrate: "codex" },
      cause: new Error("failed"),
    })).toMatchObject({ operation });
  }
});
