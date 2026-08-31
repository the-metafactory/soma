import { expect, test } from "bun:test";
import { SomaInstallError } from "../src/installation-execution";

const OPERATIONS = [
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
] as const;

test("installation errors preserve a redacted snapshot of completed operations", () => {
  const somaHome = {
    somaHome: "/tmp/soma",
    context: {} as never,
    files: [] as string[],
  };
  const cause = new Error("projection write failed");
  const error = new SomaInstallError({
    operation: "write-home-projection",
    stage: "projection",
    partial: { substrate: "codex", somaHome },
    cause,
  });
  somaHome.files.push("/tmp/soma/later-file");

  expect(error).toMatchObject({
    name: "SomaInstallError",
    operation: "write-home-projection",
    stage: "projection",
    partial: { substrate: "codex", somaHome: { somaHome: "/tmp/soma", files: [] } },
    cause,
  });
  expect(error.partial.somaHome?.files).toEqual([]);
  expect(error.partial.somaHome).toEqual({ somaHome: "/tmp/soma", files: [] });
});

test("exact installation labels remain available without becoming a public enum", () => {
  for (const operation of OPERATIONS) {
    expect(new SomaInstallError({
      operation,
      stage: "projection",
      partial: { substrate: "codex" },
      cause: new Error("failed"),
    })).toMatchObject({ operation });
  }
});
