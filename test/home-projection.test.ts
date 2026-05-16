import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  buildCodexHomeProjection,
  buildPiDevHomeProjection,
  installCodexHomeProjection,
  installPiDevHomeProjection,
  resolveHomeProjectionPaths,
} from "../src/index";
import { renderCodexLifecycleHook } from "../src/adapters/codex/hooks/runtime";
import { portableContextInput } from "./fixtures";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-home-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("resolves codex home projection paths from a home directory", () => {
  const paths = resolveHomeProjectionPaths("codex", { homeDir: "/tmp/soma-test-home" });

  expect(paths.substrate).toBe("codex");
  expect(paths.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(paths.substrateHome).toBe("/tmp/soma-test-home/.codex");
});

test("resolves pi.dev home projection paths from a home directory", () => {
  const paths = resolveHomeProjectionPaths("pi-dev", { homeDir: "/tmp/soma-test-home" });

  expect(paths.substrate).toBe("pi-dev");
  expect(paths.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(paths.substrateHome).toBe("/tmp/soma-test-home/.pi");
});

test("rejects unimplemented home projection substrates", () => {
  expect(() => resolveHomeProjectionPaths("claude-code", { homeDir: "/tmp/soma-test-home" })).toThrow("not implemented");
});

test("builds codex home projection bundle for default availability", () => {
  const projection = buildCodexHomeProjection(portableContextInput, { homeDir: "/tmp/soma-test-home" });

  expect(projection.substrateHome).toBe("/tmp/soma-test-home/.codex");
  expect(projection.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(projection.bundle.files.map((file) => file.path)).toEqual([
    "rules/soma.rules",
    "hooks.json",
    "hooks/soma-lifecycle.mjs",
    "hooks/codex-hook-entry.mjs",
    "hooks/soma-feedback-capture.mjs",
    "hooks/codex-policy-hook.mjs",
    "hooks/policy-marker.mjs",
    "skills/soma/SKILL.md",
    "memories/soma/profile.md",
    "memories/soma/memory-layout.md",
    "memories/soma/pai-imports.md",
    "memories/soma/lifecycle.md",
    "memories/soma/skills.md",
    "memories/soma/policy.md",
    "skills/the-algorithm/SKILL.md",
  ]);
  expect(projection.bundle.instructions).toContain("Soma default availability");
  expect(projection.bundle.instructions).toContain("/tmp/soma-test-home/.soma");
  expect(projection.bundle.files.find((file) => file.path === "hooks/soma-lifecycle.mjs")?.content).toContain("policyMarkers");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-hook-entry.mjs")?.content).toContain("runSomaPolicyCheck");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-hook-entry.mjs")?.content).toContain('"./codex-policy-hook.mjs"');
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-hook-entry.mjs")?.content).toContain(
    '"./soma-feedback-capture.mjs"',
  );
  expect(projection.bundle.files.find((file) => file.path === "hooks/soma-feedback-capture.mjs")?.content).toContain("--stdin");
  expect(projection.bundle.files.find((file) => file.path === "hooks/soma-feedback-capture.mjs")?.content).not.toContain(
    "__SOMA_FEEDBACK_TRIGGER_PATTERN_SOURCE__",
  );
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-policy-hook.mjs")?.content).toContain('"./policy-marker.mjs"');
  expect(projection.bundle.files.find((file) => file.path === "skills/the-algorithm/SKILL.md")?.content).toContain(
    "━━━ 👁️ OBSERVE ━━━ 1/7",
  );
  expect(projection.bundle.files.find((file) => file.path === "skills/the-algorithm/SKILL.md")?.content).toContain(
    "When entering ALGORITHM mode, emit these banners",
  );
});

test("renders codex lifecycle hook with an explicit Bun executable", () => {
  const hook = renderCodexLifecycleHook("/tmp/soma-test-home/.soma", "/tmp/soma-test-home", "/tmp/soma-repo", "/opt/homebrew/bin/bun");

  expect(hook).toContain('bunPath: "/opt/homebrew/bin/bun"');
  expect(hook).not.toContain("process.execPath");
});

test("builds pi.dev home projection bundle for default availability", () => {
  const projection = buildPiDevHomeProjection(portableContextInput, { homeDir: "/tmp/soma-test-home" });

  expect(projection.substrateHome).toBe("/tmp/soma-test-home/.pi");
  expect(projection.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(projection.bundle.files.map((file) => file.path)).toEqual([
    "agent/extensions/soma.ts",
    "agent/soma/context.md",
    "agent/soma/profile.md",
    "agent/soma/memory-layout.md",
    "agent/soma/pai-imports.md",
    "agent/soma/tools.md",
    "agent/soma/skills.md",
    "agent/soma/policy.md",
    "agent/extensions/soma-path-guard.ts",
    "agent/skills/soma/SKILL.md",
  ]);
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("before_agent_start");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("session_start");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("tool_execution_end");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("session_shutdown");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("resources_discover");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("soma_context");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("runSomaClassification");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("Soma: ${label}");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).not.toContain("Operating requirement");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).toContain("soma_memory_promote");
  expect(projection.bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content).not.toContain('"memory_promote"');
  expect(projection.bundle.files.find((file) => file.path === "agent/skills/soma/SKILL.md")?.content).toContain("name: soma");
});

test("installs codex home projection into a substrate home", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installCodexHomeProjection(portableContextInput, { homeDir });

    expect(result.substrate).toBe("codex");
    expect(result.rootDir).toBe(join(homeDir, ".codex"));
    expect(result.files).toHaveLength(15);

    const rules = await readFile(join(homeDir, ".codex/rules/soma.rules"), "utf8");
    const hooks = await readFile(join(homeDir, ".codex/hooks.json"), "utf8");
    const hookScript = await readFile(join(homeDir, ".codex/hooks/soma-lifecycle.mjs"), "utf8");
    const hookEntry = await readFile(join(homeDir, ".codex/hooks/codex-hook-entry.mjs"), "utf8");
    const feedbackHook = await readFile(join(homeDir, ".codex/hooks/soma-feedback-capture.mjs"), "utf8");
    const policyHook = await readFile(join(homeDir, ".codex/hooks/codex-policy-hook.mjs"), "utf8");
    const skill = await readFile(join(homeDir, ".codex/skills/soma/SKILL.md"), "utf8");
    const algorithmSkill = await readFile(join(homeDir, ".codex/skills/the-algorithm/SKILL.md"), "utf8");
    const profile = await readFile(join(homeDir, ".codex/memories/soma/profile.md"), "utf8");
    const paiImports = await readFile(join(homeDir, ".codex/memories/soma/pai-imports.md"), "utf8");
    const lifecycle = await readFile(join(homeDir, ".codex/memories/soma/lifecycle.md"), "utf8");

    expect(rules).toContain("Use Soma as the portable personal assistant context");
    expect(hooks).toContain("SessionStart");
    expect(hooks).toContain("UserPromptSubmit");
    expect(hooks).toContain("PreToolUse");
    expect(hookScript).toContain("runCodexHook");
    expect(hookScript).toContain("trustedSomaRepo");
    expect(hookScript).toContain("policyMarkers");
    expect(hookScript).toContain("bunPath");
    expect(hookEntry).toContain('"./soma-feedback-capture.mjs"');
    expect(feedbackHook).toContain("--stdin");
    expect(feedbackHook).not.toContain("__SOMA_FEEDBACK_TRIGGER_PATTERN_SOURCE__");
    expect(policyHook).toContain("targetExtractors");
    expect(policyHook).toContain("normalizeToolInvocation");
    expect(hookScript).not.toContain("function privateRoots");
    expect(rules.split("\n").filter((line) => line.trim() !== "")).toSatisfy((lines: string[]) =>
      lines.every((line) => line.startsWith("#")),
    );
    expect(skill).toContain("name: soma");
    expect(skill).toContain("pai-imports.md");
    expect(skill).toContain("Do not assume a global `soma` binary exists");
    expect(algorithmSkill).toContain("━━━ ✅ VERIFY ━━━ 6/7");
    expect(algorithmSkill).toContain("━━━ 📃 SUMMARY ━━━ 7/7");
    expect(profile).toContain("ISC-PORTABLE-1");
    expect(paiImports).toContain(`${homeDir}/.soma/profile/imports/claude/DA_IDENTITY.md`);
    expect(lifecycle).toContain("Soma Lifecycle Projection");
    expect(lifecycle).toContain("soma-repo.txt");
    expect(lifecycle).toContain("Do not use `command -v soma`");
  });
});

test("codex algorithm contract wins over imported portable skill body", async () => {
  await withTempHome(async (homeDir) => {
    await installCodexHomeProjection(
      {
        ...portableContextInput,
        profile: {
          ...portableContextInput.profile,
          skills: [
            ...portableContextInput.profile.skills,
            {
              name: "the-algorithm",
              path: "skills/the-algorithm",
              description: "Imported PAI Algorithm skill.",
              triggers: ["algorithm"],
              files: [
                {
                  path: "SKILL.md",
                  content: "# Imported Algorithm\n\nThis body should not replace the Codex rendering contract.",
                },
                {
                  path: "Workflows/RunAlgorithm.md",
                  content: "# Imported workflow\n",
                },
              ],
            },
          ],
        },
      },
      { homeDir },
    );

    const algorithmSkill = await readFile(join(homeDir, ".codex/skills/the-algorithm/SKILL.md"), "utf8");
    const workflow = await readFile(join(homeDir, ".codex/skills/the-algorithm/Workflows/RunAlgorithm.md"), "utf8");

    expect(algorithmSkill).toContain("Codex Rendering Contract");
    expect(algorithmSkill).toContain("♻︎ Entering the PAI ALGORITHM… (Soma) ═════════════");
    expect(algorithmSkill).not.toContain("This body should not replace the Codex rendering contract.");
    expect(workflow).toContain("Imported workflow");
  });
});

test("installs pi.dev home projection into a substrate home", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installPiDevHomeProjection(portableContextInput, { homeDir });

    expect(result.substrate).toBe("pi-dev");
    expect(result.rootDir).toBe(join(homeDir, ".pi"));
    expect(result.files).toHaveLength(10);

    const extension = await readFile(join(homeDir, ".pi/agent/extensions/soma.ts"), "utf8");
    const profile = await readFile(join(homeDir, ".pi/agent/soma/profile.md"), "utf8");
    const paiImports = await readFile(join(homeDir, ".pi/agent/soma/pai-imports.md"), "utf8");
    const skill = await readFile(join(homeDir, ".pi/agent/skills/soma/SKILL.md"), "utf8");

    expect(extension).toContain("registerTool");
    expect(extension).toContain("before_agent_start");
    expect(extension).toContain("soma_context");
    expect(extension).toContain("startup_context");
    expect(extension).toContain("algorithm_work_index");
    expect(extension).toContain("runSomaClassification");
    expect(extension).toContain("Soma: ${label}");
    expect(extension).not.toContain("Operating requirement");
    expect(extension).toContain("soma_memory_promote");
    expect(extension).not.toContain('"memory_promote"');
    expect(extension).toContain("session_shutdown");
    expect(extension).toContain("resources_discover");
    expect(profile).toContain("ISC-PORTABLE-1");
    expect(paiImports).toContain(`${homeDir}/.soma/profile/imports/claude/DA_IDENTITY.md`);
    expect(skill).toContain("Do not assume a global `soma` binary exists");
    expect(skill).toContain("name: soma");
  });
});
