import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  type BunPathProbe,
  isEphemeralBunPath,
  requireBunInPath,
  resolveBunExecutable,
  resolveValidatedBunPath,
} from "../src/bun-probe";

// Hermetic probe fixture: a tiny in-memory filesystem + spawn table so
// every platform/normalization/validation branch runs without touching
// the real disk or spawning anything. `calls` records which PATH
// locators ran and which candidates were spawn-probed — the "which is
// never invoked on win32" and "no silent fallthrough" assertions hang
// off it.
function fixtureProbe(input: {
  files?: string[];
  spawnFails?: string[];
  located?: Partial<Record<"which" | "where", string | null>>;
}): { probe: BunPathProbe; calls: { locate: string[]; spawned: string[] } } {
  const files = new Set(input.files ?? []);
  const spawnFails = new Set(input.spawnFails ?? []);
  const calls = { locate: [] as string[], spawned: [] as string[] };
  const probe: BunPathProbe = {
    exists: (candidate) => files.has(candidate),
    spawnVersion: (candidate) => {
      calls.spawned.push(candidate);
      return spawnFails.has(candidate)
        ? { ok: false, detail: "exit 1: fixture failure" }
        : { ok: true, detail: "1.2.3" };
    },
    locate: (tool) => {
      calls.locate.push(tool);
      return input.located?.[tool] ?? null;
    },
  };
  return { probe, calls };
}

const WIN_BUN = "C:\\Users\\kyle\\scoop\\apps\\bun\\current\\bun.exe";
const WIN_WHERE_BUN = "C:\\Users\\kyle\\scoop\\shims\\bun.exe";
const POSIX_BUN = "/home/kyle/.bun/bin/bun";

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

// The #320 ephemeral guarantees, re-expressed against the validating
// resolver that replaces the old pure `chooseBunExecutable`. A frozen
// path must be DURABLE, not merely spawnable — these lock that in.
describe("resolveValidatedBunPath — soma#316 ephemeral screening", () => {
  test("SOMA_BUN_PATH override wins, even over an ephemeral execPath", () => {
    const { probe } = fixtureProbe({ files: ["/custom/bun"] });
    expect(
      resolveValidatedBunPath({
        env: { SOMA_BUN_PATH: "/custom/bun" },
        platform: "linux",
        execPath: "/tmp/bun-node-x/bun",
        runningUnderBun: true,
        probe,
      }),
    ).toBe("/custom/bun");
  });

  test("PATH-resolved bun wins over an ephemeral execPath", () => {
    const { probe } = fixtureProbe({ files: [POSIX_BUN], located: { which: POSIX_BUN } });
    expect(
      resolveValidatedBunPath({
        env: {},
        platform: "linux",
        execPath: "/tmp/bun-node-x/bun",
        runningUnderBun: true,
        probe,
      }),
    ).toBe(POSIX_BUN);
  });

  test("falls back to a durable execPath when nothing else resolves", () => {
    const { probe } = fixtureProbe({ files: [POSIX_BUN] });
    expect(
      resolveValidatedBunPath({ env: {}, platform: "linux", execPath: POSIX_BUN, runningUnderBun: true, probe }),
    ).toBe(POSIX_BUN);
  });

  test("skips an ephemeral PATH result but accepts a durable execPath", () => {
    const { probe } = fixtureProbe({ files: [POSIX_BUN], located: { which: "/tmp/bun-node-x/bun" } });
    expect(
      resolveValidatedBunPath({ env: {}, platform: "linux", execPath: POSIX_BUN, runningUnderBun: true, probe }),
    ).toBe(POSIX_BUN);
  });

  test("rejects an ephemeral execPath instead of freezing it (the bug)", () => {
    const { probe } = fixtureProbe({});
    expect(() =>
      resolveValidatedBunPath({
        env: {},
        platform: "linux",
        execPath: "/tmp/bun-node-0d9b296af/bun",
        runningUnderBun: true,
        probe,
      }),
    ).toThrow(/ephemeral|reboot/);
  });

  test("rejects an ephemeral PATH result when no durable source remains", () => {
    const { probe } = fixtureProbe({ located: { which: "/tmp/bun-node-x/bun" } });
    expect(() =>
      resolveValidatedBunPath({ env: {}, platform: "linux", execPath: "", runningUnderBun: false, probe }),
    ).toThrow(/ephemeral|reboot/);
  });

  test("an explicit ephemeral SOMA_BUN_PATH fails loudly (the user named a doomed path)", () => {
    const { probe, calls } = fixtureProbe({});
    const attempt = () =>
      resolveValidatedBunPath({ env: { SOMA_BUN_PATH: "/tmp/bun-node-x/bun" }, platform: "linux", probe });
    expect(attempt).toThrow(/ephemeral|reboot/);
    expect(attempt).toThrow(/SOMA_BUN_PATH/);
    expect(calls.spawned).toEqual([]); // rejected before any spawn probe
  });
});

describe("resolveValidatedBunPath — win32/MSYS resolution + validation", () => {
  test("win32: execPath-under-bun wins when no env override; which is never invoked", () => {
    const { probe, calls } = fixtureProbe({ files: [WIN_BUN, WIN_WHERE_BUN], located: { where: WIN_WHERE_BUN } });
    const resolved = resolveValidatedBunPath({
      env: {},
      platform: "win32",
      execPath: WIN_BUN,
      runningUnderBun: true,
      probe,
    });
    expect(resolved).toBe(WIN_BUN);
    expect(calls.locate).toEqual([]); // execPath won before any PATH probe
    expect(calls.spawned).toEqual([WIN_BUN]);
  });

  test("win32: `where bun` is the fallback when not running under bun; which is never invoked", () => {
    const { probe, calls } = fixtureProbe({ files: [WIN_WHERE_BUN], located: { where: WIN_WHERE_BUN } });
    const resolved = resolveValidatedBunPath({
      env: {},
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      runningUnderBun: false,
      probe,
    });
    expect(resolved).toBe(WIN_WHERE_BUN);
    expect(calls.locate).toEqual(["where"]);
    expect(calls.locate).not.toContain("which");
  });

  test("win32: validated SOMA_BUN_PATH override beats execPath", () => {
    const override = "C:\\tools\\bun\\bun.exe";
    const { probe, calls } = fixtureProbe({ files: [override, WIN_BUN] });
    const resolved = resolveValidatedBunPath({
      env: { SOMA_BUN_PATH: override },
      platform: "win32",
      execPath: WIN_BUN,
      runningUnderBun: true,
      probe,
    });
    expect(resolved).toBe(override);
    expect(calls.spawned).toEqual([override]);
  });

  test("win32: MSYS-form SOMA_BUN_PATH normalizes to the native .exe form before validation", () => {
    // The exact 2026-06-10 incident shape: Git Bash dialect, no .exe.
    const { probe } = fixtureProbe({ files: [WIN_BUN] });
    const resolved = resolveValidatedBunPath({
      env: { SOMA_BUN_PATH: "/c/Users/kyle/scoop/apps/bun/current/bun" },
      platform: "win32",
      runningUnderBun: false,
      probe,
    });
    expect(resolved).toBe(WIN_BUN);
  });

  test("win32: MSYS-form `where` output (Git Bash where shim) normalizes too", () => {
    const { probe } = fixtureProbe({
      files: [WIN_WHERE_BUN],
      located: { where: "/c/Users/kyle/scoop/shims/bun" },
    });
    const resolved = resolveValidatedBunPath({
      env: {},
      platform: "win32",
      runningUnderBun: false,
      probe,
    });
    expect(resolved).toBe(WIN_WHERE_BUN);
  });

  test("win32: broken SOMA_BUN_PATH throws naming the candidate and source — no silent fallthrough", () => {
    // execPath and where would both be valid; a present-but-broken
    // override must still abort the install, not fall through.
    const { probe, calls } = fixtureProbe({ files: [WIN_BUN, WIN_WHERE_BUN], located: { where: WIN_WHERE_BUN } });
    const attempt = () =>
      resolveValidatedBunPath({
        env: { SOMA_BUN_PATH: "C:\\nope\\bun.exe" },
        platform: "win32",
        execPath: WIN_BUN,
        runningUnderBun: true,
        probe,
      });
    expect(attempt).toThrow(/SOMA_BUN_PATH/);
    expect(attempt).toThrow(/C:\\nope\\bun\.exe/);
    expect(attempt).toThrow(/not found on disk/);
    expect(attempt).toThrow(/fail-open/);
    expect(calls.spawned).toEqual([]); // never reached the spawn probe, never tried another candidate
  });

  test("MSYS-form override that still fails validation throws with the raw value in the message", () => {
    const { probe } = fixtureProbe({ files: [] });
    const attempt = () =>
      resolveValidatedBunPath({
        env: { SOMA_BUN_PATH: "/c/gone/bun" },
        platform: "win32",
        runningUnderBun: false,
        probe,
      });
    expect(attempt).toThrow(/C:\\gone\\bun/);
    expect(attempt).toThrow(/\/c\/gone\/bun/);
  });

  test("spawn-probe failure throws naming the source and the probe command", () => {
    const { probe } = fixtureProbe({ files: [WIN_BUN], spawnFails: [WIN_BUN] });
    const attempt = () =>
      resolveValidatedBunPath({
        env: {},
        platform: "win32",
        execPath: WIN_BUN,
        runningUnderBun: true,
        probe,
      });
    expect(attempt).toThrow(/process\.execPath/);
    expect(attempt).toThrow(/--version/);
    expect(attempt).toThrow(/exit 1: fixture failure/);
  });

  test("POSIX: order preserved — which bun beats execPath-under-bun", () => {
    const { probe, calls } = fixtureProbe({ files: [POSIX_BUN, "/proc/self/exe-bun"], located: { which: POSIX_BUN } });
    const resolved = resolveValidatedBunPath({
      env: {},
      platform: "linux",
      execPath: "/proc/self/exe-bun",
      runningUnderBun: true,
      probe,
    });
    expect(resolved).toBe(POSIX_BUN);
    expect(calls.locate).toEqual(["which"]);
  });

  test("POSIX: SOMA_BUN_PATH first, and it too is validated", () => {
    const { probe } = fixtureProbe({ files: [POSIX_BUN], located: { which: POSIX_BUN } });
    const attempt = () =>
      resolveValidatedBunPath({ env: { SOMA_BUN_PATH: "/opt/missing/bun" }, platform: "linux", probe });
    expect(attempt).toThrow(/SOMA_BUN_PATH/);
    expect(attempt).toThrow(/\/opt\/missing\/bun/);
  });

  test("POSIX: execPath-under-bun remains the last-resort fallback", () => {
    const { probe } = fixtureProbe({ files: ["/bun/bin/bun"] });
    const resolved = resolveValidatedBunPath({
      env: {},
      platform: "linux",
      execPath: "/bun/bin/bun",
      runningUnderBun: true,
      probe,
    });
    expect(resolved).toBe("/bun/bin/bun");
  });

  test("no candidate at all: loud install-bun remediation naming the platform's locator", () => {
    const { probe } = fixtureProbe({});
    const win = () => resolveValidatedBunPath({ env: {}, platform: "win32", runningUnderBun: false, probe });
    expect(win).toThrow(/where bun/);
    expect(win).toThrow(/SOMA_BUN_PATH/);
    const posix = () => resolveValidatedBunPath({ env: {}, platform: "linux", runningUnderBun: false, probe });
    expect(posix).toThrow(/which bun/);
  });

  test("empty SOMA_BUN_PATH is treated as unset, not validated as a path", () => {
    const { probe } = fixtureProbe({ files: [WIN_BUN] });
    const resolved = resolveValidatedBunPath({
      env: { SOMA_BUN_PATH: "  " },
      platform: "win32",
      execPath: WIN_BUN,
      runningUnderBun: true,
      probe,
    });
    expect(resolved).toBe(WIN_BUN);
  });
});

// Integration: this suite itself runs under bun, so the production path
// (real probe, real spawn) must resolve and validate — pinned
// SOMA_BUN_PATH or not.
describe("resolveBunExecutable / requireBunInPath (real probe)", () => {
  test("resolveBunExecutable resolves a real, existing bun on this machine", () => {
    const resolved = resolveBunExecutable();
    expect(existsSync(resolved)).toBe(true);
    expect(resolved).toBe(resolveBunExecutable()); // memoized: same value, no re-probe
  });

  test("requireBunInPath passes on this machine", () => {
    expect(() => requireBunInPath()).not.toThrow();
  });
});
