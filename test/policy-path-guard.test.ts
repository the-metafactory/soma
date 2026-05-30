import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluatePathGuard, parseBashDestructivePaths } from "../src/policy-path-guard";
import { evaluateSomaPolicy } from "../src/policy";
import { renderPathGuardExtension } from "../src/adapters/pi-dev/path-guard";
import { bootstrapSomaHome } from "../src/soma-home";
import { checkSomaPolicy, checkSomaPolicyBatch } from "../src/policy-audit";

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

test("parses mv command source and destination", () => {
  const result = parseBashDestructivePaths("mv ~/.soma/profile.md /tmp/backup", "/tmp");

  expect(result.command).toBe("mv");
  expect(result.targetPaths).toHaveLength(2);
  expect(result.targetPaths[0]).toContain(".soma/profile.md");
});

test("parses all mv sources and destination", () => {
  const protectedRef = "~/." + "soma/secret.md";
  const result = parseBashDestructivePaths(`mv safe.txt ${protectedRef} /tmp/backup/`, "/tmp");

  expect(result.command).toBe("mv");
  expect(result.targetPaths).toHaveLength(3);
  expect(result.targetPaths[1]).toContain(".soma/secret.md");
});

test("parses protected mv destination", () => {
  const protectedRef = "~/." + "soma/profile.md";
  const result = parseBashDestructivePaths(`mv /tmp/evil ${protectedRef}`, "/tmp");

  expect(result.command).toBe("mv");
  expect(result.targetPaths[1]).toContain(".soma/profile.md");
});

test("detects destructive absolute command paths", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`/bin/rm -rf ${protectedRef}`, "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
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

test("handles shell command builtin prefix", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`command rm -rf ${protectedRef}`, "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
});

test("handles quoted paths", () => {
  const result = parseBashDestructivePaths("rm -rf \"My Documents\"", "/home/user");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toBe(resolve("/home/user/My Documents"));
});

test("preserves ordinary filename parentheses", () => {
  const result = parseBashDestructivePaths("rm photo(1).jpg", "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toEqual([resolve("/tmp/photo(1).jpg")]);
});

test("handles backslash-escaped characters", () => {
  const protectedRef = "~/." + "\\soma";
  const result = parseBashDestructivePaths(`rm -rf ${protectedRef}`, "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
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

test("scans destructive commands after chain operators", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`cd /tmp && rm -rf ${protectedRef}`, "/work");

  expect(result.command).toBe("cd");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
});

test("scans destructive commands after newlines", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`ls\nrm -rf ${protectedRef}`, "/work");

  expect(result.command).toBe("ls");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
});

test("parses destructive shell wrapper payloads", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`bash -c "rm -rf ${protectedRef}"`, "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
});

test("parses destructive eval payloads", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`eval rm -rf ${protectedRef}`, "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
});

test("parses destructive xargs payloads", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`printf '%s\\n' ${protectedRef} | xargs rm -rf ${protectedRef}`, "/tmp");

  expect(result.command).toBe("printf");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
});

test("parses find -delete target paths", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`find ${protectedRef} -delete`, "/tmp");

  expect(result.command).toBe("find");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
});

test("parses find global options before target paths", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`find -L ${protectedRef} -name '*.tmp' -delete`, "/tmp");

  expect(result.command).toBe("find");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
});

test("expands HOME variables before resolving targets", () => {
  const result = parseBashDestructivePaths("rm -rf $HOME/.soma", "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
});

test("expands bare HOME variables before resolving targets", () => {
  const result = parseBashDestructivePaths("rm -rf ${HOME}", "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toEqual([homedir()]);
});

test("parses shell redirection targets as destructive writes", () => {
  const protectedRef = "~/." + "soma/profile.md";
  const result = parseBashDestructivePaths(`cat /dev/null > ${protectedRef}`, "/tmp");

  expect(result.command).toBe("cat");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma/profile.md");
});

test("parses heredoc redirection targets as destructive writes", () => {
  const protectedRef = "~/." + "soma/profile.md";
  const result = parseBashDestructivePaths(`cat <<EOF > ${protectedRef}`, "/tmp");

  expect(result.command).toBe("cat");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma/profile.md");
});

test("parses subshell-expanded protected path tokens conservatively", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`rm -rf $(echo ${protectedRef})`, "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths.some((target) => target.includes(".soma"))).toBe(true);
});

test("parses destructive write command destinations", () => {
  const protectedRef = "~/." + "soma/profile.md";

  expect(parseBashDestructivePaths(`cp /dev/null ${protectedRef}`, "/tmp").targetPaths[0]).toContain(".soma/profile.md");
  expect(parseBashDestructivePaths(`cp -t ${protectedRef} source`, "/tmp").targetPaths[0]).toContain(".soma/profile.md");
  expect(parseBashDestructivePaths(`dd if=/dev/null of=${protectedRef}`, "/tmp").targetPaths[0]).toContain(".soma/profile.md");
  expect(parseBashDestructivePaths(`tee ${protectedRef}`, "/tmp").targetPaths[0]).toContain(".soma/profile.md");
});

test("does not treat redirect operands as rm targets", () => {
  const result = parseBashDestructivePaths("rm -rf target > logfile", "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toEqual([resolve("/tmp/target"), resolve("/tmp/logfile")]);
});

test("does not let redirects hide cp destinations", () => {
  const protectedRef = "~/." + "soma/profile.md";
  const result = parseBashDestructivePaths(`cp source ${protectedRef} > log`, "/tmp");

  expect(result.command).toBe("cp");
  expect(result.targetPaths[0]).toContain(".soma/profile.md");
});

test("treats arguments after double dash as paths", () => {
  const protectedRef = "~/." + "soma";
  const result = parseBashDestructivePaths(`rm -- -rf ${protectedRef}`, "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths.some((target) => target.includes(".soma"))).toBe(true);
});

test("detects glob pattern rm *", () => {
  const result = parseBashDestructivePaths("rm -rf *", join(process.env.HOME ?? "/tmp", ".soma"));

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
});

test("keeps glob directory specificity", () => {
  const protectedRef = "~/." + "soma/*";
  const result = parseBashDestructivePaths(`rm -rf ${protectedRef}`, "/tmp");

  expect(result.command).toBe("rm");
  expect(result.targetPaths).toHaveLength(1);
  expect(result.targetPaths[0]).toContain(".soma");
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

test("blocks direct tilde delete targets on Claude/PAI home", () => {
  const claudeMemory = "~/." + "claude/memory";
  const result = evaluatePathGuard({
    targetPaths: [claudeMemory],
    cwd: "/tmp",
    action: "delete",
  });

  expect(result.blocked).toBe(true);
  expect(result.matchedPaths[0]).toContain(".claude/memory");
  expect(result.matchedDescriptions[0]).toContain("Claude Code / PAI home");
});

test("blocks direct relative delete targets under protected roots", () => {
  const root = "/tmp/soma-direct-path-guard";
  const result = evaluatePathGuard({
    targetPaths: ["memory"],
    cwd: root,
    action: "delete",
    protectedPaths: [{ path: root, description: "custom" }],
  });

  expect(result.blocked).toBe(true);
  expect(result.matchedPaths).toEqual([resolve(root, "memory")]);
  expect(result.matchedDescriptions[0]).toContain("custom");
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

test("blocks symlinks resolving into protected paths", async () => {
  await withTempHome(async (homeDir) => {
    const protectedDir = join(homeDir, "protected");
    const linkPath = join(homeDir, "link-to-protected");
    await mkdir(protectedDir, { recursive: true });
    await symlink(protectedDir, linkPath);

    const result = evaluatePathGuard({
      targetPaths: [linkPath],
      cwd: homeDir,
      action: "delete",
      protectedPaths: [{ path: protectedDir, description: "protected" }],
    });

    expect(result.blocked).toBe(true);
  });
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

// ── Allowed Subpaths (legitimate memory/ISA writes) ──

test("allows modify on ~/.soma/isa subtree by default", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "isa", "personal", "draft.md")],
    cwd: "/tmp",
    action: "modify",
  });

  expect(result.blocked).toBe(false);
  expect(result.matchedPaths).toEqual([]);
});

test("allows modify on ~/.soma/memory subtree by default", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "memory", "STATE", "active.json")],
    cwd: "/tmp",
    action: "modify",
  });

  expect(result.blocked).toBe(false);
});

test("allows modify on ~/.claude memory subtrees by default", () => {
  const claudeHome = join(process.env.HOME ?? "/tmp", ".claude");
  for (const subpath of ["memory", "memories", join("PAI", "MEMORY")]) {
    const result = evaluatePathGuard({
      targetPaths: [join(claudeHome, subpath, "note.md")],
      cwd: "/tmp",
      action: "modify",
    });
    expect(result.blocked).toBe(false);
  }
});

test("allows modify on ~/.pi agent memory subtree by default", () => {
  const piHome = join(process.env.HOME ?? "/tmp", ".pi");
  const result = evaluatePathGuard({
    targetPaths: [join(piHome, "agent", "memory", "session.md")],
    cwd: "/tmp",
    action: "modify",
  });

  expect(result.blocked).toBe(false);
});

test("still blocks modify on ~/.soma/profile (private root)", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "profile", "identity.md")],
    cwd: "/tmp",
    action: "modify",
  });

  expect(result.blocked).toBe(true);
});

test("still blocks modify on ~/.soma root files (not in allowed subpaths)", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "secret.md")],
    cwd: "/tmp",
    action: "modify",
  });

  expect(result.blocked).toBe(true);
});

test("still blocks delete on ~/.soma/memory (allowed-subpath does not extend to delete)", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "memory", "STATE", "active.json")],
    cwd: "/tmp",
    action: "delete",
  });

  expect(result.blocked).toBe(true);
});

test("still blocks delete on ~/.soma/isa (allowed-subpath does not extend to delete)", () => {
  const somaHome = join(process.env.HOME ?? "/tmp", ".soma");
  const result = evaluatePathGuard({
    targetPaths: [join(somaHome, "isa", "personal", "draft.md")],
    cwd: "/tmp",
    action: "delete",
  });

  expect(result.blocked).toBe(true);
});

test("respects explicit allowedSubpaths on custom protected paths", () => {
  const customRoot = "/tmp/custom-root";
  const allowed = evaluatePathGuard({
    targetPaths: [resolve(customRoot, "scratch/note.md")],
    cwd: "/tmp",
    action: "modify",
    protectedPaths: [{ path: customRoot, description: "custom", allowedSubpaths: ["scratch"] }],
  });
  const blocked = evaluatePathGuard({
    targetPaths: [resolve(customRoot, "vault/secret.md")],
    cwd: "/tmp",
    action: "modify",
    protectedPaths: [{ path: customRoot, description: "custom", allowedSubpaths: ["scratch"] }],
  });

  expect(allowed.blocked).toBe(false);
  expect(blocked.blocked).toBe(true);
});

test("allowedSubpaths does not affect delete action", () => {
  const customRoot = "/tmp/custom-root";
  const result = evaluatePathGuard({
    targetPaths: [resolve(customRoot, "scratch/note.md")],
    cwd: "/tmp",
    action: "delete",
    protectedPaths: [{ path: customRoot, description: "custom", allowedSubpaths: ["scratch"] }],
  });

  expect(result.blocked).toBe(true);
});

// ── allowedSubpaths input hardening (#79 R2 important: prevent escape via
// absolute paths, tilde-prefixes, or `..` traversal in operator-supplied
// allowedSubpaths values) ──

test("allowedSubpaths rejects absolute-path subpath values (cannot relax beyond root)", () => {
  const customRoot = "/tmp/custom-root";
  // An attacker / misconfigured operator passes an absolute path. The
  // expected behavior: the unsafe value is dropped, the target is still
  // blocked because it is inside the protected root and no safe allowed
  // subpath matches.
  const result = evaluatePathGuard({
    targetPaths: [resolve(customRoot, "private/identity.md")],
    cwd: "/tmp",
    action: "modify",
    protectedPaths: [{ path: customRoot, description: "custom", allowedSubpaths: ["/"] }],
  });

  expect(result.blocked).toBe(true);
});

test("allowedSubpaths rejects parent-traversal subpath values", () => {
  const customRoot = "/tmp/custom-root";
  // `..` would resolve to /tmp and let any modify inside /tmp/* pass.
  const result = evaluatePathGuard({
    targetPaths: [resolve(customRoot, "private/identity.md")],
    cwd: "/tmp",
    action: "modify",
    protectedPaths: [{ path: customRoot, description: "custom", allowedSubpaths: [".."] }],
  });

  expect(result.blocked).toBe(true);
});

test("allowedSubpaths rejects tilde-prefixed subpath values", () => {
  const customRoot = "/tmp/custom-root";
  const result = evaluatePathGuard({
    targetPaths: [resolve(customRoot, "private/identity.md")],
    cwd: "/tmp",
    action: "modify",
    protectedPaths: [{ path: customRoot, description: "custom", allowedSubpaths: ["~/anywhere"] }],
  });

  expect(result.blocked).toBe(true);
});

test("allowedSubpaths rejects empty and dot-only subpath values", () => {
  const customRoot = "/tmp/custom-root";
  for (const unsafe of ["", ".", "./"]) {
    const result = evaluatePathGuard({
      targetPaths: [resolve(customRoot, "private/identity.md")],
      cwd: "/tmp",
      action: "modify",
      protectedPaths: [{ path: customRoot, description: "custom", allowedSubpaths: [unsafe] }],
    });
    expect(result.blocked).toBe(true);
  }
});

test("allowedSubpaths drops unsafe entries but still honors safe siblings", () => {
  const customRoot = "/tmp/custom-root";
  // The "../escape" is unsafe and dropped; "scratch" is safe and applied.
  const escape = evaluatePathGuard({
    targetPaths: [resolve(customRoot, "private/identity.md")],
    cwd: "/tmp",
    action: "modify",
    protectedPaths: [{ path: customRoot, description: "custom", allowedSubpaths: ["../escape", "scratch"] }],
  });
  const safe = evaluatePathGuard({
    targetPaths: [resolve(customRoot, "scratch/note.md")],
    cwd: "/tmp",
    action: "modify",
    protectedPaths: [{ path: customRoot, description: "custom", allowedSubpaths: ["../escape", "scratch"] }],
  });

  expect(escape.blocked).toBe(true);
  expect(safe.blocked).toBe(false);
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

test("policy check denies delete on configured-home Claude path by default", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "delete",
      destinationPath: "~/." + "claude/memory",
      record: "none",
    });

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "protected-path",
    });
  });
});

test("policy check allows modify on Soma ISA subtree (legitimate Soma write)", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      somaHome,
      action: "modify",
      destinationPath: join(somaHome, "isa", "personal", "active.md"),
      record: "none",
    });

    expect(result.decision).toBe("allow");
  });
});

test("policy check allows modify on Soma memory subtree (legitimate memory write)", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      somaHome,
      action: "modify",
      destinationPath: join(somaHome, "memory", "STATE", "active.json"),
      record: "none",
    });

    expect(result.decision).toBe("allow");
  });
});

test("policy check still denies modify on Soma profile (private root)", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      somaHome,
      action: "modify",
      destinationPath: join(somaHome, "profile", "identity.md"),
      record: "none",
    });

    expect(result.decision).toBe("deny");
  });
});

test("policy check still denies delete on Soma memory subtree", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      somaHome,
      action: "delete",
      destinationPath: join(somaHome, "memory", "STATE", "active.json"),
      record: "none",
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

test("policy check honors explicit cwd for relative paths", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      somaHome: join(homeDir, ".soma"),
      cwd: homeDir,
      action: "delete",
      destinationPath: "." + "/.soma/profile.md",
      record: "none",
    });

    expect(result.decision).toBe("deny");
  });
});

test("batch policy check applies custom protected paths", async () => {
  await withTempHome(async (homeDir) => {
    const protectedDir = join(homeDir, "extra-protected");
    const result = await checkSomaPolicyBatch({
      homeDir,
      action: "delete",
      protectedPaths: [{ path: protectedDir, description: "extra protected" }],
      targets: [{ filePath: join(protectedDir, "test.txt") }],
      record: "none",
    });

    expect(result.decision).toBe("deny");
    expect(result.results[0]?.findings[0]).toMatchObject({
      kind: "protected-path",
    });
    expect(result.results[0]?.findings[0]?.detail).toContain("~/extra-protected/test.txt");
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

test("cli rejects --protected-path-name without --protected-path", async () => {
  await withTempHome(async (homeDir) => {
    await expect(
      execFileAsync("bun", [
        "run",
        "soma",
        "policy",
        "check",
        "--action",
        "delete",
        "--destination",
        join(homeDir, "work", "scratch.md"),
        "--home-dir",
        homeDir,
        "--protected-path-name",
        "dangling name",
      ], { encoding: "utf8" }),
    ).rejects.toThrow("--protected-path-name requires a preceding --protected-path");
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
  expect(extension).toContain("resolvePath");
  expect(extension).toContain("parseBashDestructivePaths");
  expect(extension).toContain("evaluatePathGuard");
  expect(extension).not.toContain("require(");
  expect(extension).toContain("tool_call");
  expect(extension).toContain("protected path");
  expect(extension).toContain("block: true");
  expect(extension).toContain("SOMA_DEFAULT_PROTECTED_PATHS");
  expect(extension).toContain("SOMA_HOME");
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

  expect(extension).toContain("resolvePath");
});

test("generated pi.dev guard blocks destructive commands, redirections, mv sources, and relative write paths", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "soma-guard-ext-runtime-"));
  const extension = renderPathGuardExtension(join(tmpDir, ".soma"));
  const extPath = join(tmpDir, "soma-path-guard.ts");
  const originalHome = process.env.HOME;
  const protectedRef = "~/." + "soma/secret.md";
  let handler: ((event: { toolName: string; input?: { command?: string; file_path?: string } }, ctx: { cwd?: string; ui?: { notify?: (message: string, level: string) => void } }) => unknown) | undefined;

  try {
    process.env.HOME = tmpDir;
    await mkdir(join(tmpDir, ".soma"), { recursive: true });
    await writeFile(extPath, extension, "utf8");
    const mod = (await import(pathToFileURL(extPath).href)) as {
      default: (pi: { on: (event: "tool_call", cb: NonNullable<typeof handler>) => void }) => void;
    };
    mod.default({
      on: (_event, cb) => {
        handler = cb;
      },
    });

    const rmResult = await handler?.({ toolName: "BASH", input: { command: `/bin/rm -rf ${protectedRef}` } }, { cwd: "/tmp" });
    const mvResult = await handler?.({ toolName: "bash", input: { command: `mv safe.txt ${protectedRef} /tmp/backup/` } }, { cwd: "/tmp" });
    const redirectResult = await handler?.({ toolName: "bash", input: { command: `cat /dev/null > ${protectedRef}` } }, { cwd: "/tmp" });
    const writeResult = await handler?.({ toolName: "write", input: { file_path: ".soma/secret.md" } }, { cwd: tmpDir });

    expect(rmResult).toMatchObject({ block: true });
    expect(mvResult).toMatchObject({ block: true });
    expect(redirectResult).toMatchObject({ block: true });
    expect((redirectResult as { reason?: string } | undefined)?.reason).not.toContain("cat /dev/null");
    expect(writeResult).toMatchObject({ block: true });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// Pi.dev rendered-extension harness shared by the #79 AC tests. Boots the
// rendered guard against a temporary HOME, returns the tool_call handler,
// and owns all cleanup (extension file, HOME restore, tmpDir removal).
type RenderedPiHandler = (
  event: { toolName: string; input?: { command?: string; file_path?: string; path?: string } },
  ctx: { cwd?: string; ui?: { notify?: (message: string, level: string) => void } },
) => unknown;

async function withRenderedPiPathGuardHandler<T>(prefix: string, fn: (ctx: { tmpDir: string; handler: RenderedPiHandler }) => Promise<T>): Promise<T> {
  const tmpDir = await mkdtemp(join(tmpdir(), prefix));
  const extension = renderPathGuardExtension(join(tmpDir, ".soma"));
  const extPath = join(tmpDir, "soma-path-guard.ts");
  const originalHome = process.env.HOME;
  let handler: RenderedPiHandler | undefined;

  try {
    process.env.HOME = tmpDir;
    await mkdir(join(tmpDir, ".soma"), { recursive: true });
    await writeFile(extPath, extension, "utf8");
    const mod = (await import(pathToFileURL(extPath).href)) as {
      default: (pi: { on: (event: "tool_call", cb: NonNullable<typeof handler>) => void }) => void;
    };
    mod.default({
      on: (_event, cb) => {
        handler = cb;
      },
    });

    if (!handler) throw new Error("rendered Pi.dev extension did not register a tool_call handler");
    return await fn({ tmpDir, handler });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("generated pi.dev guard allows writes to Soma ISA and memory subtrees", async () => {
  await withRenderedPiPathGuardHandler("soma-guard-ext-allow-", async ({ tmpDir, handler }) => {
    // ISA write should be allowed (#79 AC-1)
    const isaWrite = await handler({ toolName: "write", input: { file_path: ".soma/isa/personal/draft.md" } }, { cwd: tmpDir });
    // ISA edit should be allowed (#79 AC-1)
    const isaEdit = await handler({ toolName: "edit", input: { file_path: ".soma/isa/personal/draft.md" } }, { cwd: tmpDir });
    // Memory write should be allowed (#79 AC-2)
    const memoryWrite = await handler({ toolName: "write", input: { file_path: ".soma/memory/STATE/active.json" } }, { cwd: tmpDir });
    // Memory edit on nested file should be allowed
    const memoryEdit = await handler({ toolName: "edit", input: { file_path: ".soma/memory/WORK/run-123/notes.md" } }, { cwd: tmpDir });

    expect(isaWrite).toBeUndefined();
    expect(isaEdit).toBeUndefined();
    expect(memoryWrite).toBeUndefined();
    expect(memoryEdit).toBeUndefined();
  });
});

test("generated pi.dev guard still blocks destructive deletes of Soma home (#79 AC-3)", async () => {
  await withRenderedPiPathGuardHandler("soma-guard-ext-delete-", async ({ tmpDir, handler }) => {
    const rmHome = await handler({ toolName: "bash", input: { command: "rm -rf ~/.soma" } }, { cwd: tmpDir });
    const rmIsa = await handler({ toolName: "bash", input: { command: "rm -rf ~/.soma/isa" } }, { cwd: tmpDir });
    const rmMemory = await handler({ toolName: "bash", input: { command: "rm -rf ~/.soma/memory" } }, { cwd: tmpDir });

    expect(rmHome).toMatchObject({ block: true });
    expect(rmIsa).toMatchObject({ block: true });
    expect(rmMemory).toMatchObject({ block: true });
  });
});

test("generated pi.dev guard still blocks writes to ~/.soma/profile (#79 AC-4 private root)", async () => {
  await withRenderedPiPathGuardHandler("soma-guard-ext-profile-", async ({ tmpDir, handler }) => {
    const writeProfile = await handler({ toolName: "write", input: { file_path: ".soma/profile/identity.md" } }, { cwd: tmpDir });
    const editProfile = await handler({ toolName: "edit", input: { file_path: ".soma/profile/identity.md" } }, { cwd: tmpDir });
    const writeRoot = await handler({ toolName: "write", input: { file_path: ".soma/secret.md" } }, { cwd: tmpDir });

    expect(writeProfile).toMatchObject({ block: true });
    expect(editProfile).toMatchObject({ block: true });
    expect(writeRoot).toMatchObject({ block: true });
  });
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
