/**
 * soma#368 — opt-in generated ~/.claude/CLAUDE.md with a preserved overlay.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { installSomaForClaudeCode } from "../src/index";
import { resolveClaudeMdOverlay } from "../src/adapters/claude-code/claude-md";
import { OVERLAY_BEGIN, OVERLAY_END, hasProvenanceHeader } from "../src/adapters/shared";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-368-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

const claudeMdPath = (homeDir: string) => join(homeDir, ".claude/CLAUDE.md");

test("default install does NOT create CLAUDE.md (opt-in only)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir });
    let existed = true;
    try {
      await readFile(claudeMdPath(homeDir), "utf8");
    } catch {
      existed = false;
    }
    expect(existed).toBe(false);
  });
});

test("--claude-md generates CLAUDE.md with provenance header, pointer, and overlay markers", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, claudeMd: true });
    const content = await readFile(claudeMdPath(homeDir), "utf8");
    expect(hasProvenanceHeader(content)).toBe(true);
    expect(content).toContain("rules/soma/CONTEXT.md");
    expect(content).toContain(OVERLAY_BEGIN);
    expect(content).toContain(OVERLAY_END);
    // sage#378: the regenerate instruction must name the opt-in flag, else it
    // is a no-op.
    expect(content).toContain("soma install claude-code --apply --claude-md");
  });
});

test("CLAUDE.md projection is byte-idempotent across reinstalls", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, claudeMd: true });
    const first = await readFile(claudeMdPath(homeDir), "utf8");
    await installSomaForClaudeCode({ homeDir, claudeMd: true });
    const second = await readFile(claudeMdPath(homeDir), "utf8");
    expect(second).toBe(first);
  });
});

test("a hand edit inside the overlay survives reprojection", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForClaudeCode({ homeDir, claudeMd: true });
    const before = await readFile(claudeMdPath(homeDir), "utf8");
    const edited = before.replace(
      OVERLAY_END,
      `my machine-local note\n\n${OVERLAY_END}`,
    );
    await writeFile(claudeMdPath(homeDir), edited, "utf8");

    await installSomaForClaudeCode({ homeDir, claudeMd: true });
    const after = await readFile(claudeMdPath(homeDir), "utf8");
    expect(after).toContain("my machine-local note");
    // Still exactly one overlay block (no marker duplication).
    expect(after.split(OVERLAY_BEGIN).length - 1).toBe(1);
    expect(after.split(OVERLAY_END).length - 1).toBe(1);
  });
});

test("a pre-existing hand-maintained CLAUDE.md is preserved into the overlay (lossless first conversion)", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(claudeMdPath(homeDir), "# My old CLAUDE.md\n\nimportant hand-written rules\n", "utf8");

    await installSomaForClaudeCode({ homeDir, claudeMd: true });
    const content = await readFile(claudeMdPath(homeDir), "utf8");
    expect(hasProvenanceHeader(content)).toBe(true);
    expect(content).toContain("important hand-written rules");
    // The preserved content lives inside the overlay, not the generated body.
    const overlayStart = content.indexOf(OVERLAY_BEGIN);
    expect(content.indexOf("important hand-written rules")).toBeGreaterThan(overlayStart);
  });
});

test("resolveClaudeMdOverlay: greenfield null, existing overlay preserved, foreign file wholesale", () => {
  expect(resolveClaudeMdOverlay(null)).toBeNull();
  const withOverlay = [OVERLAY_BEGIN, "", "kept", "", OVERLAY_END].join("\n");
  expect(resolveClaudeMdOverlay(withOverlay)).toBe("kept");
  const foreign = resolveClaudeMdOverlay("# foreign\n\nbody");
  expect(foreign).toContain("body");
  expect(foreign).toContain("Preserved from the pre-Soma");
});
