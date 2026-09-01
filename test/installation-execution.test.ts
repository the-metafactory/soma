import { expect, test } from "bun:test";
import { SomaInstallError } from "../src/installation-execution";
import { SOMA_INSTALL_OPERATIONS } from "../src/installation-executor";

test("installation errors preserve a redacted snapshot of completed operations", () => {
  const somaHome = { filesWritten: 1 };
  const cause = new Error("projection write failed at /private/soma-secret");
  const error = new SomaInstallError({
    operation: "write-home-projection",
    stage: "projection",
    partial: { substrate: "codex", somaHome },
    cause,
  });
  somaHome.filesWritten = 2;

  expect(error).toMatchObject({
    name: "SomaInstallError",
    operation: "write-home-projection",
    stage: "projection",
    partial: { substrate: "codex", somaHome: { filesWritten: 1 } },
  });
  expect(error.message).toBe("Soma install failed during write-home-projection.");
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  expect(error.partial.somaHome).toEqual({ filesWritten: 1 });
  expect(() => ((error.partial.somaHome as { filesWritten: number }).filesWritten = 2)).toThrow(TypeError);
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
