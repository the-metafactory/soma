/**
 * Adapter-owned statusline mode+effort state writer (claude-code).
 *
 * This is the substrate-side write logic for the statusline's mode+effort feed:
 * the portable `soma algorithm classify` command stays pure, and the
 * mode-classifier hook (mode-classifier-hook.mjs) mirrors this ~4-line write
 * inline (it cannot import TypeScript). These tests exercise the TS helper
 * directly — path construction, payload shape, and session-id sanitization
 * (traversal safety). The hook's end-to-end write is asserted in
 * test/claude-code-install.test.ts.
 */
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { expect, test } from "bun:test";
import {
  buildStatuslineModeState,
  sanitizeStatuslineSessionId,
  statuslineModeStatePath,
  writeStatuslineModeState,
} from "../src/adapters/claude-code/statusline-mode-state";

async function withTempSomaHome<T>(fn: (somaHome: string) => Promise<T>): Promise<T> {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-statusline-mode-state-"));
  try {
    return await fn(somaHome);
  } finally {
    await rm(somaHome, { recursive: true, force: true });
  }
}

test("writeStatuslineModeState writes mode, effort, and updatedAt at the session-scoped path", async () => {
  await withTempSomaHome(async (somaHome) => {
    const path = writeStatuslineModeState({
      somaHome,
      sessionId: "sess1",
      mode: "algorithm",
      effort: "E3",
      updatedAt: "2026-07-09T10:00:00.000Z",
    });

    expect(path).toBe(join(somaHome, "memory/STATE/statusline-mode-sess1.json"));
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content).toEqual({
      mode: "algorithm",
      effort: "E3",
      updatedAt: "2026-07-09T10:00:00.000Z",
    });
  });
});

test("buildStatuslineModeState defaults a missing effort to the empty string", () => {
  expect(buildStatuslineModeState({ mode: "minimal", updatedAt: "2026-07-09T10:05:00.000Z" })).toEqual({
    mode: "minimal",
    effort: "",
    updatedAt: "2026-07-09T10:05:00.000Z",
  });
});

test("sanitizeStatuslineSessionId is the identity for a safe token", () => {
  expect(sanitizeStatuslineSessionId("abc-123_ID.v2")).toBe("abc-123_ID.v2");
});

test("statuslineModeStatePath addresses the sanitized filename inside STATE", () => {
  expect(statuslineModeStatePath("/soma", "sess1")).toBe("/soma/memory/STATE/statusline-mode-sess1.json");
  expect(statuslineModeStatePath("/soma", "a/b")).toBe("/soma/memory/STATE/statusline-mode-a-b.json");
});

test("sanitizeStatuslineSessionId collapses path separators so no subdir is created", () => {
  expect(sanitizeStatuslineSessionId("../../etc/passwd")).toBe("..-..-etc-passwd");
  expect(sanitizeStatuslineSessionId("a/b")).toBe("a-b");
});

test("a traversal session id cannot write outside the STATE directory", async () => {
  await withTempSomaHome(async (somaHome) => {
    const stateDir = resolve(join(somaHome, "memory/STATE"));
    const path = writeStatuslineModeState({
      somaHome,
      sessionId: "../../../../tmp/evil",
      mode: "algorithm",
      effort: "E3",
      updatedAt: "2026-07-09T10:10:00.000Z",
    });

    // The write landed as a single sanitized basename directly inside STATE —
    // its parent dir is STATE, and the relative path back to STATE never
    // escapes upward.
    const resolved = resolve(path);
    expect(resolve(dirname(resolved))).toBe(stateDir);
    const rel = relative(stateDir, resolved);
    expect(rel.startsWith(`..${sep}`)).toBe(false);
    expect(rel).not.toContain(sep);

    // And STATE contains exactly the one sanitized file (no traversal escape).
    const entries = await readdir(stateDir);
    expect(entries).toEqual(["statusline-mode-..-..-..-..-tmp-evil.json"]);
  });
});
