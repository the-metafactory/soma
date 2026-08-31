import { expect, test } from "bun:test";
import { SomaInstallError } from "../src/installation-execution";
import { SOMA_INSTALL_OPERATIONS } from "../src/installation-executor";

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
  expect(() => (error.partial.somaHome?.files as string[]).push("/tmp/soma/mutated")).toThrow(TypeError);
});

test("exact installation labels remain available without becoming a public enum", () => {
  for (const operation of SOMA_INSTALL_OPERATIONS) {
    expect(new SomaInstallError({
      operation,
      stage: "projection",
      partial: { substrate: "codex" },
      cause: new Error("failed"),
    })).toMatchObject({ operation });
  }
});
