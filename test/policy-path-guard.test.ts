import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluatePathGuard, parseBashDestructivePaths } from "../src/policy-path-guard";
import { evaluateSomaPolicy } from "../src/policy";
import { renderPathGuardExtension } from "../src/adapters/pi-dev-path-guard";
import { bootstrapSomaHome } from "../src/soma-home";
import { checkSomaPolicy } from "../src/policy-audit";

const execFileAsync = promisify(execFile);

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-policy-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

// ── Bash Command Parsing ──

test("parses rm -rf targeting a path", () => {
  const result = parseBashDestructivePaths("rm -rf /tmp/test", "/home/user");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toBe(resolve("/tmp/test"));
});

test("parses rm -r targeting a tilde path", () => {
  const result = parseBashDestructivePaths("rm -r ~/.soma/memory", "/tmp/cwd");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma/memory");
});

test("parses rmdir command", () => {
  const result = parseBashDestructivePaths("rmdir /tmp/old-dir", "/tmp");

  expect(result.command).toBe("rmdir");
  expect(result.targetPaths).toHaveLength(1);
});

test("parses trash command", () => {
  const result = parseBashDestructivePaths("trash ~/.claude/memory", "/tmp");

  expect(result.command).toBe("trash");
  expect(result.targetPaths).toHaveLength(1);
});

test("parses mv command (source is destructive)", () => {
  const result = parseBashDestructivePaths("mv ~/.soma/profile.md /tmp/backup", "/tmp");

  expect(result.command).toBe("mv");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma/profile.md");
});

test("ignores non-destructive commands", () => {
  const result = parseBashDestructivePaths("ls -la ~/.soma", "/tmp");

  // Command is parsed but not destructive, so targetPaths is empty
  expect(result.targetPaths).toEqual([]);
});

test("ignores read-only commands like cat, grep", () => {
  const result = parseBashDestructivePaths("grep pattern ~/.soma/*.md", "/tmp");

  expect(result.targetPaths).toEqual([]);
});

test("skips flag arguments", () => {
  const result = parseBashDestructivePaths("rm -rf --preserve-root /tmp/file", "/home");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toBe(resolve("/tmp/file"));
});

test("handles bun/npx/sudo prefix", () => {
  const result = parseBashDestructivePaths("sudo rm -rf /etc/nope", "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
});

test("handles quoted paths", () => {
  const result = parseBashDestructivePaths("rm -rf \"My Documents\"", "/home/user");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toBe(resolve("/home/user/My Documents"));
});

test("detects multiple deletion targets", () => {
  const result = parseBashDestructivePaths("rm -rf dir1 dir2 dir3", "/base");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(3);
});

test("stops at chain operators", () => {
  const result = parseBashDestructivePaths("rm -rf target && echo done", "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
});

test("detects glob pattern rm *", () => {
  const result = parseBashDestructivePaths("rm -rf *", join(process.env.HOME ?? "/tmp", ".soma"));

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
});

// ── Path Guard Evaluation ──

test("blocks rm -rf on Soma home", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "memory", "WORK", "test.md")],
    cwd: "/tmp",
    action: "delete",
  });

  expect(result.blocked).toBe(true);
  expect(result.matchedPaths).toHaveLength(1);
  expect(result.matchedDescriptions[0]).toContain("Soma portable assistant home");
});

test("blocks rm -rf on Claude/PAI home", () => {
  const claudeHome = join(process.env.HOME ?? "/tmp", ".claude");
  const result = evaluatePathGuard({
    targetPaths: [join(claudeHome, "memory")],
    cwd: "/tmp",
    action: "delete",
  });

  expect(result.blocked).toBe(true);
  expect(result.matchedDescriptions[0]).toContain("Claude Code / PAI home");
});

test("blocks rm -rf on Pi.dev home", () => {
  const piHome = join(process.env.HOME ?? "/tmp", ".pi");
  const result = evaluatePathGuard({
    targetPaths: [join(piHome, "agent", "extensions")],
    cwd: "/tmp",
    action: "delete",
  });

  expect(result.blocked).toBe(true);
});

test("allows rm on unprotected paths", () => {
  const result = evaluatePathGuard({
    targetPaths: [resolve("/tmp/safe-dir/file.txt")],
    cwd: "/tmp",
    action: "delete",
  });

  expect(result.blocked).toBe(false);
  expect(result.matchedPaths).toEqual([]);
});

test("allows rm on unprotected relative path", () => {
  const result = evaluatePathGuard({
    targetPaths: [resolve("/home/testuser/work/file.txt")],
    cwd: "/home/testuser/work",
    action: "delete",
  });

  expect(result.blocked).toBe(false);
});

test("blocks modify on write to protected path", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "profile", "identity.md")],
    cwd: "/tmp",
    action: "modify",
  });

  expect(result.blocked).toBe(true);
});

test("honors guardDelete: false", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "memory", "file.md")],
    cwd: "/tmp",
    action: "delete",
    protectedPaths: [{ path: "~/.soma", description: "test", guardDelete: false }],
  });

  expect(result.blocked).toBe(false);
});

test("honors guardModify: false", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "memory", "file.md")],
    cwd: "/tmp",
    action: "modify",
    protectedPaths: [{ path: "~/.soma", description: "test", guardModify: false }],
  });

  expect(result.blocked).toBe(false);
});

// ── Policy Integration ──

test("policy check denies delete on Soma home path", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      somaHome,
      action: "delete",
      destinationPath: join(somaHome, "memory", "WORK", "test.md"),
    });

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "protected-path",
    });
  });
});

test("policy check denies modify on Soma home path", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      somaHome,
      action: "modify",
      destinationPath: join(somaHome, "profile", "test.md"),
    });

    expect(result.decision).toBe("deny");
  });
});

test("policy check allows delete on unprotected path", async () => {
  await withTempHome(async (homeDir) => {
    const result = await checkSomaPolicy({
      homeDir,
      action: "delete",
      destinationPath: join(homeDir, "work", "scratch.md"),
      record: "none",
    });

    expect(result.decision).toBe("allow");
  });
});

test("cli supports --action delete", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const targetPath = join(homeDir, ".soma", "should-be-blocked.md");

    const { stdout } = await execFileAsync("bun", [
      "run",
      "soma",
      "policy",
      "check",
      "--action",
      "delete",
      "--destination",
      targetPath,
      "--home-dir",
      homeDir,
      "--soma-home",
      join(homeDir, ".soma"),
    ], { encoding: "utf8" });

    expect(stdout).toContain("decision: deny");
    expect(stdout).toContain("protected-path");
  });
}, { timeout: 15000 });

test("cli supports --action modify", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const targetPath = join(homeDir, ".soma", "profile", "test.md");

    const { stdout } = await execFileAsync("bun", [
      "run",
      "soma",
      "policy",
      "check",
      "--action",
      "modify",
      "--destination",
      targetPath,
      "--home-dir",
      homeDir,
      "--soma-home",
      join(homeDir, ".soma"),
    ], { encoding: "utf8" });

    expect(stdout).toContain("decision: deny");
  });
}, { timeout: 15000 });

test("cli supports --protected-path flag", async () => {
  await withTempHome(async (homeDir) => {
    const protectedDir = join(homeDir, "extra-protected");

    const { stdout } = await execFileAsync("bun", [
      "run",
      "soma",
      "policy",
      "check",
      "--action",
      "delete",
      "--destination",
      join(protectedDir, "test.txt"),
      "--home-dir",
      homeDir,
      "--soma-home",
      join(homeDir, ".soma"),
      "--protected-path",
      protectedDir,
      "--protected-path-name",
      "My extra protected dir",
    ], { encoding: "utf8" });

    expect(stdout).toContain("decision: deny");
    expect(stdout).toContain("protected-path");
  });
}, { timeout: 15000 });

test("cli --action delete on unprotected path allows", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });

    const { stdout } = await execFileAsync("bun", [
      "run",
      "soma",
      "policy",
      "check",
      "--action",
      "delete",
      "--destination",
      join(homeDir, "work", "public", "ok.md"),
      "--home-dir",
      homeDir,
      "--soma-home",
      join(homeDir, ".soma"),
      "--record",
      "none",
    ], { encoding: "utf8" });

    expect(stdout).toContain("decision: allow");
  });
}, { timeout: 15000 });

// ── Pi.dev Extension Generation ──

test("generates pi.dev path guard extension", () => {
  const extension = renderPathGuardExtension("/test/home/.soma");

  expect(extension).toContain("import type { ExtensionAPI }");
  expect(extension).toContain("DESTRUCTIVE_DELETE");
  expect(extension).toContain("rm");
  expect(extension).toContain("rmdir");
  expect(extension).toContain("trash");
  expect(extension).toContain("DESTRUCTIVE_MOVE");
  expect(extension).toContain("mv");
  expect(extension).toContain("tool_call");
  expect(extension).toContain("protected path");
  expect(extension).toContain("block: true");
  expect(extension).toContain("~/.soma");
  expect(extension).toContain("~/.claude");
  expect(extension).toContain("~/.pi");
  expect(extension).toContain("~/.config/cortex");
  expect(extension).toContain("~/.config/metafactory");
  expect(extension).toContain("~/.config/k");
});

test("generated pi.dev guard extension is valid TypeScript", async () => {
  // Verify the generated extension is syntactically valid JS/TS
  // by writing it to a temp file and checking it doesn't crash Bun's parser

  const extension = renderPathGuardExtension("/test/home/.soma");
  const tmpDir = await mkdtemp(join(tmpdir(), "soma-guard-ext-"));
  const extPath = join(tmpDir, "test-extension.ts");

  try {
    await writeFile(extPath, extension, "utf8");

    // Bun can parse it without syntax errors
    await execFileAsync("bun", ["--eval", extension], {
      encoding: "utf8",
      timeout: 5000,
    });

    // The key assertion: it didn't throw a syntax error
    expect(true).toBe(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("generated pi.dev guard extension handles env.HOME reference", () => {
  const extension = renderPathGuardExtension("/test/home/.soma");

  expect(extension).toContain("process.env.HOME");
});

// ── Policy write action still works ──

test("write policy does not trigger path guard findings", () => {
  const result = evaluateSomaPolicy({
    homeDir: "/tmp/test",
    action: "write",
    destinationPath: "/tmp/test/public.md",
    content: "Public content",
    record: "none",
  });

  expect(result.findings.every((f) => f.kind !== "protected-path")).toBe(true);
});

test("write policy with explicit action still blocks private markers", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: join(homeDir, "work", "public", "leak.md"),
      content: `Private: ${somaHome}/memory/private.md`,
    });

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "private-marker",
    });
  });
});
