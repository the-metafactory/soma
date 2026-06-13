import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseBunExecutable, isEphemeralBunPath } from "../src/bun-probe";

describe("isEphemeralBunPath (soma#316)", () => {
  test("flags bun's temp self-extraction dir", () => {
    expect(isEphemeralBunPath("/tmp/bun-node-0d9b296af/bun")).toBe(true);
    expect(isEphemeralBunPath("/home/u/.cache/bun-node-abc123/bun")).toBe(true);
  });

  test("flags any path under the OS temp dir", () => {
    expect(isEphemeralBunPath(join(tmpdir(), "whatever", "bun"))).toBe(true);
  });

  test("does not flag a durable install path", () => {
    expect(isEphemeralBunPath("/home/u/.bun/bin/bun")).toBe(false);
    expect(isEphemeralBunPath("/opt/homebrew/bin/bun")).toBe(false);
    expect(isEphemeralBunPath("/usr/local/bin/bun")).toBe(false);
  });

  test("empty path is not ephemeral", () => {
    expect(isEphemeralBunPath("")).toBe(false);
  });
});

describe("chooseBunExecutable (soma#316)", () => {
  test("SOMA_BUN_PATH override wins, even over an ephemeral execPath", () => {
    expect(
      chooseBunExecutable({
        somaBunPath: "/custom/bun",
        fromPath: null,
        runningUnderBun: true,
        execPath: "/tmp/bun-node-x/bun",
      }),
    ).toBe("/custom/bun");
  });

  test("PATH-resolved bun wins over an ephemeral execPath", () => {
    expect(
      chooseBunExecutable({
        fromPath: "/home/u/.bun/bin/bun",
        runningUnderBun: true,
        execPath: "/tmp/bun-node-x/bun",
      }),
    ).toBe("/home/u/.bun/bin/bun");
  });

  test("falls back to a durable execPath when nothing else resolves", () => {
    expect(
      chooseBunExecutable({
        fromPath: null,
        runningUnderBun: true,
        execPath: "/home/u/.bun/bin/bun",
      }),
    ).toBe("/home/u/.bun/bin/bun");
  });

  test("rejects an ephemeral PATH result (which bun can resolve to /tmp)", () => {
    expect(() =>
      chooseBunExecutable({
        fromPath: "/tmp/bun-node-x/bun",
        runningUnderBun: false,
        execPath: "",
      }),
    ).toThrow(/ephemeral|reboot|SOMA_BUN_PATH/);
  });

  test("skips an ephemeral PATH result but accepts a durable execPath", () => {
    expect(
      chooseBunExecutable({
        fromPath: "/tmp/bun-node-x/bun",
        runningUnderBun: true,
        execPath: "/home/u/.bun/bin/bun",
      }),
    ).toBe("/home/u/.bun/bin/bun");
  });

  test("rejects an ephemeral execPath instead of embedding it (the bug)", () => {
    expect(() =>
      chooseBunExecutable({
        fromPath: null,
        runningUnderBun: true,
        execPath: "/tmp/bun-node-0d9b296af/bun",
      }),
    ).toThrow(/ephemeral|reboot|SOMA_BUN_PATH/);
  });

  test("throws when no bun resolves at all", () => {
    expect(() =>
      chooseBunExecutable({ fromPath: null, runningUnderBun: false, execPath: "" }),
    ).toThrow(/SOMA_BUN_PATH|PATH/);
  });
});
