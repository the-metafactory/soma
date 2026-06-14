import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  buildCodexHomeProjection,
  buildCursorHomeProjection,
  buildPiDevHomeProjection,
  installCodexHomeProjection,
  installCursorHomeProjection,
  installPiDevHomeProjection,
  resolveHomeProjectionPaths,
} from "../src/index";
import { portableProjectionInput } from "./fixtures";

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

test("resolves claude-code home projection paths (#37)", () => {
  const paths = resolveHomeProjectionPaths("claude-code", { homeDir: "/tmp/soma-test-home" });
  expect(paths.substrate).toBe("claude-code");
  expect(paths.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(paths.substrateHome).toBe("/tmp/soma-test-home/.claude");
});

test("resolves cursor home projection paths", () => {
  const paths = resolveHomeProjectionPaths("cursor", { homeDir: "/tmp/soma-test-home" });
  expect(paths.substrate).toBe("cursor");
  expect(paths.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(paths.substrateHome).toBe("/tmp/soma-test-home");
});

test("rejects unimplemented home projection substrates", () => {
  expect(() => resolveHomeProjectionPaths("cortex", { homeDir: "/tmp/soma-test-home" })).toThrow("not implemented");
  expect(() => resolveHomeProjectionPaths("custom", { homeDir: "/tmp/soma-test-home" })).toThrow("not implemented");
});

test("builds codex home projection bundle for default availability", () => {
  const projection = buildCodexHomeProjection(portableProjectionInput, { homeDir: "/tmp/soma-test-home" });

  expect(projection.substrateHome).toBe("/tmp/soma-test-home/.codex");
  expect(projection.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(projection.bundle.files.map((file) => file.path)).toEqual([
    "rules/soma.rules",
    "hooks.json",
    "hooks/soma-lifecycle.mjs",
    "hooks/soma-lifecycle.config.json",
    "hooks/codex-hook-entry.mjs",
    "hooks/soma-feedback-capture.mjs",
    "hooks/codex-policy-hook.mjs",
    "hooks/codex-policy-targets.mjs",
    "hooks/policy-marker.mjs",
    "skills/soma/SKILL.md",
    "memories/soma/profile.md",
    "memories/soma/memory-layout.md",
    "memories/soma/pai-imports.md",
    "memories/soma/lifecycle.md",
    "memories/soma/skills.md",
    "memories/soma/policy.md",
    "skills/the-algorithm/SKILL.md",
    "memories/soma/active-isa.md",
  ]);
  expect(projection.bundle.instructions).toContain("Soma default availability");
  expect(projection.bundle.instructions).toContain("/tmp/soma-test-home/.soma");
  // soma#73: lifecycle hook is shipped verbatim, config lives in colocated JSON.
  expect(projection.bundle.files.find((file) => file.path === "hooks/soma-lifecycle.mjs")?.content).toContain("#!/usr/bin/env bun");
  expect(projection.bundle.files.find((file) => file.path === "hooks/soma-lifecycle.config.json")?.content).toContain("policyMarkers");
  expect(projection.bundle.files.find((file) => file.path === "hooks/soma-lifecycle.config.json")?.content).toContain("memory/RAW/untrusted");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-hook-entry.mjs")?.content).toContain("runSomaPolicyCheck");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-hook-entry.mjs")?.content).toContain("runSomaInboundContentScan");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-hook-entry.mjs")?.content).toContain("runSomaRuntimePolicyInspect");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-hook-entry.mjs")?.content).toContain("unexpected structure");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-hook-entry.mjs")?.content).toContain('"./codex-policy-hook.mjs"');
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-hook-entry.mjs")?.content).toContain(
    '"./soma-feedback-capture.mjs"',
  );
  expect(projection.bundle.files.find((file) => file.path === "hooks/soma-feedback-capture.mjs")?.content).toContain("--stdin");
  expect(projection.bundle.files.find((file) => file.path === "hooks/soma-feedback-capture.mjs")?.content).not.toContain(
    "__SOMA_FEEDBACK_TRIGGER_PATTERN_SOURCE__",
  );
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-policy-hook.mjs")?.content).toContain("./codex-policy-targets.mjs");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-policy-hook.mjs")?.content).toContain("extractInboundContentTargets");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-policy-targets.mjs")?.content).toContain("targetExtractors");
  expect(projection.bundle.files.find((file) => file.path === "hooks/codex-policy-targets.mjs")?.content).toContain("inboundTargetExtractors");
  expect(projection.bundle.files.find((file) => file.path === "skills/the-algorithm/SKILL.md")?.content).toContain(
    "━━━ 👁️ OBSERVE ━━━ 1/7",
  );
  expect(projection.bundle.files.find((file) => file.path === "skills/the-algorithm/SKILL.md")?.content).toContain(
    "When entering ALGORITHM mode, emit these banners",
  );
  expect(projection.bundle.files.find((file) => file.path === "skills/the-algorithm/SKILL.md")?.content).toContain(
    "Start with `Workflows/RunAlgorithm.md`",
  );
  expect(projection.bundle.files.find((file) => file.path === "skills/the-algorithm/SKILL.md")?.content).toContain(
    "The harness is mutable run state",
  );
});

test("soma#73 sage r2: installed lifecycle hook is executable (0o755)", async () => {
  await withTempHome(async (homeDir) => {
    await installCodexHomeProjection(portableProjectionInput, { homeDir });
    const { stat } = await import("node:fs/promises");
    const info = await stat(join(homeDir, ".codex/hooks/soma-lifecycle.mjs"));
    // Owner-execute bit (0o100) must be set so Codex can run the
    // shebang directly.
    expect((info.mode & 0o100) !== 0).toBe(true);
    // Config JSON next to it stays non-executable.
    const configInfo = await stat(join(homeDir, ".codex/hooks/soma-lifecycle.config.json"));
    expect((configInfo.mode & 0o100) === 0).toBe(true);
  });
});

test("soma#73: codex lifecycle hook ships verbatim with bun shebang + colocated config", () => {
  const projection = buildCodexHomeProjection(portableProjectionInput, { homeDir: "/tmp/soma-test-home" });
  const hook = projection.bundle.files.find((f) => f.path === "hooks/soma-lifecycle.mjs");
  const config = projection.bundle.files.find((f) => f.path === "hooks/soma-lifecycle.config.json");
  expect(hook).toBeDefined();
  expect(config).toBeDefined();
  expect(hook!.content).toContain("#!/usr/bin/env bun");
  expect(hook!.content).toContain("soma-lifecycle.config.json");
  expect(hook!.content).not.toContain("bunPath");
  // No install-time template markers left in the rendered hook.
  expect(hook!.content).not.toContain("__SOMA_");
  // Config has the install-time fields the hook will read at runtime.
  const parsed = JSON.parse(config!.content) as Record<string, unknown>;
  expect(parsed.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(parsed.trustedSomaRepo).toBeDefined();
  expect(parsed.bunPath).toBeDefined();
  expect(Array.isArray(parsed.privateRoots)).toBe(true);
  expect(Array.isArray(parsed.policyMarkers)).toBe(true);
  expect(parsed.inboundSecurity).toMatchObject({
    untrustedRoots: ["/tmp/soma-test-home/.soma/memory/RAW/untrusted"],
    traceRoot: "/tmp/soma-test-home/.soma/memory/SECURITY/inbound-content",
  });
});

test("builds pi.dev home projection bundle for default availability", () => {
  const projection = buildPiDevHomeProjection(portableProjectionInput, { homeDir: "/tmp/soma-test-home" });

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
    // #43 — Algorithm phase renderer extension.
    "agent/extensions/soma-algorithm.ts",
    "agent/skills/soma/SKILL.md",
    "agent/soma/active-isa.md",
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

test("builds cursor home projection bundle for default availability", () => {
  const projection = buildCursorHomeProjection(portableProjectionInput, { homeDir: "/tmp/soma-test-home" });

  expect(projection.substrateHome).toBe("/tmp/soma-test-home");
  expect(projection.somaHome).toBe("/tmp/soma-test-home/.soma");
  expect(projection.bundle.files.map((file) => file.path)).toEqual([
    ".cursorrules",
    ".cursor/rules/soma/README.md",
    ".cursor/rules/soma/CONTEXT.md",
    ".cursor/rules/soma/PROFILE.md",
    ".cursor/rules/soma/TELOS.md",
    ".cursor/rules/soma/MEMORY_LAYOUT.md",
    ".cursor/rules/soma/SKILLS.md",
    ".cursor/rules/soma/POLICY.md",
    ".cursor/rules/soma/MCP.md",
    ".cursor/rules/soma/ACTIVE_ISA.md",
  ]);
  expect(projection.bundle.files.find((file) => file.path === ".cursorrules")?.content).toContain(".cursor/rules/soma/CONTEXT.md");
  expect(projection.bundle.files.find((file) => file.path === ".cursor/rules/soma/MCP.md")?.content).toContain("MCP");
});

test("installs cursor home projection files", async () => {
  await withTempHome(async (homeDir) => {
    await installCursorHomeProjection(portableProjectionInput, { homeDir });
    await expect(readFile(join(homeDir, ".cursorrules"), "utf8")).resolves.toContain("Soma Cursor Projection");
    await expect(readFile(join(homeDir, ".cursor/rules/soma/CONTEXT.md"), "utf8")).resolves.toContain("Soma Cursor Context");
  });
});

test("pi.dev home projection normalizes portable skill paths and frontmatter names", () => {
  const projection = buildPiDevHomeProjection(
    {
      ...portableProjectionInput,
      profile: {
        ...portableProjectionInput.profile,
        skills: [
          {
            // The canonical ISA skill has a dedicated, managed projection
            // (installIsaSkillProjection); the generic portable-skill loop
            // delegates it and must NOT also emit its files here.
            name: "ISA",
            path: "skills/ISA",
            description: "Ideal State Artifact.",
            triggers: ["isa"],
            files: [
              {
                path: "SKILL.md",
                content: "---\nname: ISA\n---\n\n# ISA\n",
              },
            ],
          },
          {
            // A non-dedicated uppercase skill exercises the general
            // name/path normalization (FAQ -> faq) through the portable loop.
            name: "FAQ",
            path: "skills/FAQ",
            description: "Frequently asked questions.",
            triggers: ["faq"],
            files: [
              {
                path: "SKILL.md",
                content: "---\nname: FAQ\n---\n\n# FAQ\n",
              },
            ],
          },
          {
            name: "Ledger Update",
            path: "skills/ledger-update",
            description: "Update a project ledger.",
            triggers: ["ledger"],
            files: [
              {
                path: "SKILL.md",
                content: "---\nname: Ledger Update\n---\n\n# Ledger Update\n",
              },
            ],
          },
          {
            name: "Body Example",
            path: "skills/body-example",
            description: "Contains a body example that looks like YAML.",
            triggers: ["body"],
            files: [
              {
                path: "SKILL.md",
                content: "# Body Example\n\n```yaml\nname: Body Example\n```\n",
              },
            ],
          },
        ],
      },
    },
    { homeDir: "/tmp/soma-test-home" },
  );

  const faq = projection.bundle.files.find((file) => file.path === "agent/skills/faq/SKILL.md");
  const ledger = projection.bundle.files.find((file) => file.path === "agent/skills/ledger-update/SKILL.md");
  const bodyExample = projection.bundle.files.find((file) => file.path === "agent/skills/body-example/SKILL.md");

  expect(faq?.content).toContain("name: faq");
  expect(faq?.content).not.toContain("name: FAQ");
  expect(ledger?.content).toContain("name: ledger-update");
  expect(bodyExample?.content).toContain("name: Body Example");
  expect(bodyExample?.content).not.toContain("name: body-example");
  // The dedicated ISA skill is delegated to installIsaSkillProjection and is
  // not double-emitted through the portable-skill loop (neither cased form).
  expect(projection.bundle.files.map((file) => file.path)).not.toContain("agent/skills/isa/SKILL.md");
  expect(projection.bundle.files.map((file) => file.path)).not.toContain("agent/skills/ISA/SKILL.md");
});

test("pi.dev home projection rejects normalized portable skill id collisions", () => {
  expect(() =>
    buildPiDevHomeProjection(
      {
        ...portableProjectionInput,
        profile: {
          ...portableProjectionInput.profile,
          skills: [
            {
              name: "Ledger Update",
              path: "skills/ledger-update",
              description: "Update a project ledger.",
              triggers: ["ledger"],
              files: [{ path: "SKILL.md", content: "---\nname: Ledger Update\n---\n" }],
            },
            {
              name: "Ledger-Update",
              path: "skills/ledger-update-alt",
              description: "Collision.",
              triggers: ["ledger"],
              files: [{ path: "SKILL.md", content: "---\nname: Ledger-Update\n---\n" }],
            },
          ],
        },
      },
      { homeDir: "/tmp/soma-test-home" },
    ),
  ).toThrow("Pi.dev skill id collision");
});

test("non-Claude home projections rewrite Claude-only paths in portable skill payloads", () => {
  const claudeHome = "~/" + ".claude";
  const somaHome = "~/" + ".soma";
  const relativeClaudeMemory = "." + "claude/memory";
  const dotRelativeClaudeMemory = "./" + relativeClaudeMemory;
  const input = {
    ...portableProjectionInput,
    profile: {
      ...portableProjectionInput.profile,
      skills: [
        {
          name: "the-algorithm",
          path: "skills/the-algorithm",
          description: "Imported Algorithm skill with Claude-specific references.",
          triggers: ["algorithm"],
          files: [
            {
              path: "SKILL.md",
              content: [
                "---",
                "name: the-algorithm",
                "---",
                "",
                `Read ${claudeHome}/skills/ISA/Examples/canonical-isa.md.`,
                "Claude hook: ISASync.hook.ts",
                "Use the ISA Tool before continuing.",
              ].join("\n"),
            },
            {
              path: "Workflows/RunAlgorithm.md",
              content: [
                "# Run Algorithm",
                "",
                `Persist work at ${claudeHome}/PAI/MEMORY/WORK/{slug}/ISA.md.`,
                `Bootstrap reads \`${relativeClaudeMemory}/decisions.md\` and \`${relativeClaudeMemory}/session-log.md\`.`,
                `Dot-relative bootstrap reads \`${dotRelativeClaudeMemory}/handoff.md\`.`,
                `Bare roots: \`${claudeHome}/memory\`, \`${relativeClaudeMemory}\`, and \`${dotRelativeClaudeMemory}\`.`,
                `Search with \`rg ${claudeHome}/PAI/MEMORY/KNOWLEDGE/\`.`,
              ].join("\n"),
            },
            {
              path: "Tools/hook-name.ts",
              content: 'export const hookName = "ISASync.hook.ts";\n',
            },
          ],
        },
      ],
    },
  };

  const codex = buildCodexHomeProjection(input, { homeDir: "/tmp/soma-test-home" });
  const piDev = buildPiDevHomeProjection(input, { homeDir: "/tmp/soma-test-home" });

  const codexWorkflow = codex.bundle.files.find((file) => file.path === "skills/the-algorithm/Workflows/RunAlgorithm.md")?.content ?? "";
  const piSkill = piDev.bundle.files.find((file) => file.path === "agent/skills/the-algorithm/SKILL.md")?.content ?? "";
  const piWorkflow = piDev.bundle.files.find((file) => file.path === "agent/skills/the-algorithm/Workflows/RunAlgorithm.md")?.content ?? "";
  const piTool = piDev.bundle.files.find((file) => file.path === "agent/skills/the-algorithm/Tools/hook-name.ts")?.content ?? "";
  const projected = [codexWorkflow, piSkill, piWorkflow].join("\n");

  expect(projected).not.toContain(claudeHome);
  expect(projected).not.toContain(relativeClaudeMemory);
  expect(projected).not.toContain("./~/");
  expect(projected).not.toContain("ISASync.hook.ts");
  expect(projected).not.toContain("ISA Tool");
  expect(projected).toContain(`${somaHome}/skills/ISA/Examples/canonical-isa.md`);
  expect(projected).toContain(`${somaHome}/memory/WORK/{slug}/ISA.md`);
  expect(projected).toContain(`${somaHome}/memory/decisions.md`);
  expect(projected).toContain(`${somaHome}/memory/handoff.md`);
  expect(projected).toContain(`${somaHome}/memory/KNOWLEDGE/`);
  expect(projected).toContain(`Bare roots: \`${somaHome}/memory\`, \`${somaHome}/memory\`, and \`${somaHome}/memory\`.`);
  expect(piTool).toContain("ISASync.hook.ts");
});


test("installs codex home projection into a substrate home", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installCodexHomeProjection(portableProjectionInput, { homeDir });

    expect(result.substrate).toBe("codex");
    expect(result.rootDir).toBe(join(homeDir, ".codex"));
    expect(result.files).toHaveLength(18);

    const rules = await readFile(join(homeDir, ".codex/rules/soma.rules"), "utf8");
    const hooks = await readFile(join(homeDir, ".codex/hooks.json"), "utf8");
    const hookScript = await readFile(join(homeDir, ".codex/hooks/soma-lifecycle.mjs"), "utf8");
    const hookEntry = await readFile(join(homeDir, ".codex/hooks/codex-hook-entry.mjs"), "utf8");
    const feedbackHook = await readFile(join(homeDir, ".codex/hooks/soma-feedback-capture.mjs"), "utf8");
    const policyHook = await readFile(join(homeDir, ".codex/hooks/codex-policy-hook.mjs"), "utf8");
    const policyTargets = await readFile(join(homeDir, ".codex/hooks/codex-policy-targets.mjs"), "utf8");
    const skill = await readFile(join(homeDir, ".codex/skills/soma/SKILL.md"), "utf8");
    const algorithmSkill = await readFile(join(homeDir, ".codex/skills/the-algorithm/SKILL.md"), "utf8");
    const profile = await readFile(join(homeDir, ".codex/memories/soma/profile.md"), "utf8");
    const paiImports = await readFile(join(homeDir, ".codex/memories/soma/pai-imports.md"), "utf8");
    const lifecycle = await readFile(join(homeDir, ".codex/memories/soma/lifecycle.md"), "utf8");

    expect(rules).toContain("Use Soma as the portable personal assistant context");
    expect(hooks).toContain("SessionStart");
    expect(hooks).toContain("UserPromptSubmit");
    expect(hooks).toContain("PreToolUse");
    // soma#317: hook commands must run under bun (Soma's declared runtime),
    // not node — the README does not list node as a prerequisite, so a
    // `node …` command would fail on a bun-only machine. Aligns with the
    // soma#73 `#!/usr/bin/env bun` shebang the hook script already ships.
    expect(hooks).not.toContain("node ~/.codex/hooks/soma-lifecycle.mjs");
    for (const event of [
      "session-start",
      "prompt-submit",
      "pre-tool-use",
      "algorithm-updated",
      "session-end",
    ]) {
      expect(hooks).toContain(`bun ~/.codex/hooks/soma-lifecycle.mjs ${event}`);
    }
    // soma#73: hookScript ships verbatim with bun shebang; runtime config in JSON.
    expect(hookScript).toContain("#!/usr/bin/env bun");
    expect(hookScript).toContain("runCodexHook");
    expect(hookScript).toContain("soma-lifecycle.config.json");
    expect(hookScript).not.toContain("bunPath");
    const hookConfig = JSON.parse(
      await readFile(join(homeDir, ".codex/hooks/soma-lifecycle.config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(hookConfig.somaHome).toBe(join(homeDir, ".soma"));
    expect(Array.isArray(hookConfig.privateRoots)).toBe(true);
    expect(Array.isArray(hookConfig.policyMarkers)).toBe(true);
    expect(hookEntry).toContain('"./soma-feedback-capture.mjs"');
    expect(feedbackHook).toContain("--stdin");
    expect(feedbackHook).not.toContain("__SOMA_FEEDBACK_TRIGGER_PATTERN_SOURCE__");
    expect(policyHook).toContain("./codex-policy-targets.mjs");
    expect(policyTargets).toContain("targetExtractors");
    expect(policyTargets).toContain("normalizeToolInvocation");
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
        ...portableProjectionInput,
        profile: {
          ...portableProjectionInput.profile,
          skills: [
            ...portableProjectionInput.profile.skills,
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
    expect(algorithmSkill).toContain("Start with `Workflows/RunAlgorithm.md`");
    expect(algorithmSkill).toContain("When the Soma CLI is available");
    expect(algorithmSkill).toContain("♻︎ Entering the PAI ALGORITHM… (Soma) ═════════════");
    expect(algorithmSkill).not.toContain("This body should not replace the Codex rendering contract.");
    expect(workflow).toContain("Imported workflow");
  });
});

test("installs pi.dev home projection into a substrate home", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installPiDevHomeProjection(portableProjectionInput, { homeDir });

    expect(result.substrate).toBe("pi-dev");
    expect(result.rootDir).toBe(join(homeDir, ".pi"));
    // #43 — +1 file (soma-algorithm.ts) projected alongside existing
    // pi-dev home bundle.
    expect(result.files).toHaveLength(12);

    const extension = await readFile(join(homeDir, ".pi/agent/extensions/soma.ts"), "utf8");
    const algorithmExtension = await readFile(join(homeDir, ".pi/agent/extensions/soma-algorithm.ts"), "utf8");
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
    // #43 AC-1: the renderer extension file is written + has the
    // default-export shape + slash-command registration.
    expect(algorithmExtension).toContain("export default function (pi: ExtensionAPI)");
    expect(algorithmExtension).toContain('pi.registerCommand("algorithm"');
  });
});
