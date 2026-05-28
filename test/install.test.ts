import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { installSomaForCodex, installSomaForPiDev, planSomaForCodexInstall, planSomaForPiDevInstall } from "../src/index";
import { codexInstallSpec } from "../src/adapters/codex/install";
import { renderStartupContextSummary } from "../src/adapters/codex/hooks/codex-hook-entry.mjs";
import {
  SOMA_MEMORY_CATEGORIES,
  SOMA_PAI_BOUND_MEMORY_CATEGORIES,
} from "../src/memory-readmes";
import { somaMemoryPrivateRoots, somaProjectionPrivateRoots } from "../src/projection-private-roots";
import { allInstallSpecs, installSpecFor } from "../src/install-spec-registry";

// #88 — Canonical PAI v5.0.0 memory taxonomy (DD-2). 17 substrate-neutral +
// 2 PAI-bound = 19. Tests consume the production-exported lists from
// `memory-readmes.ts` so the taxonomy split stays single-sourced (Sage R1
// maintainability finding).
const SOMA_CANONICAL_MEMORY_DIRS = SOMA_MEMORY_CATEGORIES;
const SOMA_PAI_BOUND_MEMORY_DIRS = SOMA_PAI_BOUND_MEMORY_CATEGORIES;

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-install-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function waitForFileContaining(path: string, text: string): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      last = await readFile(path, "utf8");
      if (last.includes(text)) return last;
    } catch {
      last = "";
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

interface CodexHookTestOutput {
  continue?: boolean;
  hookSpecificOutput?: {
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

function runCodexHook(
  hook: string,
  event: string,
  homeDir: string,
  input: unknown,
  options: { extraEnv?: NodeJS.ProcessEnv; rawInput?: boolean } = {},
): { status: number | null; output: CodexHookTestOutput } {
  // soma#73: the lifecycle hook ships with `#!/usr/bin/env bun`.
  // Tests still spawn under system Node — the hook body itself works
  // under either runtime (the child spawn uses an explicit bunPath
  // from config so the substrate runtime doesn't matter). When
  // Codex fires the hook in production, the env-bun shebang resolves
  // bun automatically.
  const result = spawnSync("node", [hook, event], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...options.extraEnv,
      HOME: homeDir,
    },
    input: options.rawInput ? String(input) : JSON.stringify(input),
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: JSON.parse(result.stdout) as CodexHookTestOutput,
  };
}

function runCodexPreToolUseHook(
  hook: string,
  homeDir: string,
  input: unknown,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; output: CodexHookTestOutput } {
  return runCodexHook(hook, "pre-tool-use", homeDir, input, { extraEnv });
}

function runRawCodexPreToolUseHook(hook: string, homeDir: string, input: string): { status: number | null; output: CodexHookTestOutput } {
  return runCodexHook(hook, "pre-tool-use", homeDir, input, { rawInput: true });
}

test("installs soma source home and codex home projection", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installSomaForCodex({ homeDir });

    expect(result.substrate).toBe("codex");
    expect(result.somaHome.somaHome).toBe(join(homeDir, ".soma"));
    expect(result.substrateHome.rootDir).toBe(join(homeDir, ".codex"));
    expect(result.substrateHome.files).toHaveLength(21);

    const telos = await readFile(join(homeDir, ".soma/profile/telos.md"), "utf8");
    const rules = await readFile(join(homeDir, ".codex/rules/soma.rules"), "utf8");
    const config = await readFile(join(homeDir, ".codex/config.toml"), "utf8");
    const hooks = await readFile(join(homeDir, ".codex/hooks.json"), "utf8");
    const hookEntry = await readFile(join(homeDir, ".codex/hooks/codex-hook-entry.mjs"), "utf8");
    const feedbackHook = await readFile(join(homeDir, ".codex/hooks/soma-feedback-capture.mjs"), "utf8");
    const somaRepo = await readFile(join(homeDir, ".codex/memories/soma/soma-repo.txt"), "utf8");
    const agents = await readFile(join(homeDir, ".codex/AGENTS.md"), "utf8");
    const skill = await readFile(join(homeDir, ".codex/skills/soma/SKILL.md"), "utf8");
    const algorithmSkill = await readFile(join(homeDir, ".codex/skills/the-algorithm/SKILL.md"), "utf8");
    const startupContext = await readFile(join(homeDir, ".codex/memories/soma/startup-context.md"), "utf8");

    expect(telos).toContain("Keep personal assistant context portable across substrates.");
    expect(rules).toContain(`Soma source of truth: ${join(homeDir, ".soma")}`);
    expect(config).not.toContain("sandbox_mode");
    expect(config).toContain(`[sandbox_workspace_write]\nwritable_roots = ["${join(homeDir, ".soma")}"]`);
    expect(config).toContain("hooks = true");
    expect(config).not.toContain("codex_hooks");
    expect(hooks).toContain("soma-lifecycle.mjs");
    expect(hooks).toContain("UserPromptSubmit");
    expect(hookEntry).toContain("soma-feedback-capture.mjs");
    expect(feedbackHook).toContain("--stdin");
    expect(hookEntry).not.toContain("__SOMA_FEEDBACK_TRIGGER_PATTERN_SOURCE__");
    expect(hookEntry).not.toContain("__SOMA_FEEDBACK_CAPTURE_HELPER__");
    expect(somaRepo).toContain("soma");
    expect(agents).toContain("@./skills/the-algorithm/SKILL.md");
    expect(agents).toContain("@./memories/soma/startup-context.md");
    expect(skill).toContain("name: soma");
    expect(algorithmSkill).toContain("━━━ 👁️ OBSERVE ━━━ 1/7");
    expect(algorithmSkill).toContain("━━━ 📃 SUMMARY ━━━ 7/7");
    expect(algorithmSkill).toContain("Start with `Workflows/RunAlgorithm.md`");
    expect(algorithmSkill).toContain("The harness is mutable run state");
    expect(startupContext).toContain("Soma Startup Context");
  });
});

test("codex install appends AGENTS imports idempotently", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(join(homeDir, ".codex/AGENTS.md"), "# User rules\n\nKeep this line.\n", "utf8");

    await installSomaForCodex({ homeDir });
    await installSomaForCodex({ homeDir });

    const agents = await readFile(join(homeDir, ".codex/AGENTS.md"), "utf8");
    expect(agents.startsWith("# User rules\n\nKeep this line.\n")).toBe(true);
    expect(agents.match(/^@\.\/skills\/the-algorithm\/SKILL\.md$/gm)).toHaveLength(1);
    expect(agents.match(/^@\.\/memories\/soma\/startup-context\.md$/gm)).toHaveLength(1);
  });
});

test("codex install dry-run lists every substrate file apply reports", async () => {
  await withTempHome(async (homeDir) => {
    const plan = planSomaForCodexInstall({ homeDir });
    const result = await installSomaForCodex({ homeDir });

    expect(plan.substrateHome).toBe(join(homeDir, codexInstallSpec.defaultHome));
    expect(plan.substrateFiles).toEqual(codexInstallSpec.homeFiles.map((path) => join(homeDir, ".codex", path)));
    expect(plan.substrateFiles).toContain(join(homeDir, ".codex/config.toml"));
    expect(plan.substrateFiles).toContain(join(homeDir, ".codex/memories/soma/soma-repo.txt"));
    expect(plan.substrateFiles).toContain(join(homeDir, ".codex/AGENTS.md"));
    expect(plan.substrateFiles).toContain(join(homeDir, ".codex/skills/the-algorithm/SKILL.md"));
    expect(new Set(plan.substrateFiles)).toEqual(new Set(result.substrateHome.files));
  });
});

test("codex install spec owns lifecycle and private root facts", () => {
  const homeDir = "/tmp/soma-install-spec-home";

  expect(codexInstallSpec.lifecycleProjection).toEqual({
    startupContextPath: "memories/soma/startup-context.md",
    somaRepoPathPath: "memories/soma/soma-repo.txt",
  });
  expect(codexInstallSpec.postProjection?.map((step) => step.name)).toEqual(["codex-agents-import", "codex-config"]);
  expect(codexInstallSpec.uninstall.kind).toBe("reserved");
  expect(somaProjectionPrivateRoots({ homeDir, substrate: "codex" })).toEqual([join(homeDir, ".codex/skills/soma")]);
  expect(somaMemoryPrivateRoots({ homeDir, substrate: "codex" })).toEqual([join(homeDir, ".codex/memories")]);
});

test("install spec registry has adapter-owned facts for every install substrate", () => {
  const substrates = ["codex", "pi-dev", "claude-code", "cursor"] as const;

  expect(allInstallSpecs().map((spec) => spec.substrate).sort()).toEqual([...substrates].sort());

  for (const substrate of substrates) {
    const spec = installSpecFor(substrate);
    expect(spec.substrate).toBe(substrate);
    expect(spec.defaultHome.length).toBeGreaterThan(0);
    expect(spec.homeFiles.length).toBeGreaterThan(0);
    expect(spec.isaSkillProjection.destinationDir("/tmp/substrate-home")).toContain("/tmp/substrate-home");
    expect(spec.uninstall.kind).toMatch(/implemented|reserved/);
  }

  expect(installSpecFor("pi-dev").validator).toBeDefined();
  expect(installSpecFor("pi-dev").lifecycleProjection).toEqual({
    startupContextPath: "agent/soma/startup-context.md",
    somaRepoPathPath: "agent/soma/soma-repo.txt",
  });
  expect(installSpecFor("pi-dev").isaSkillProjection.skillNameOverride).toBe("isa");
  expect(installSpecFor("claude-code").uninstall).toMatchObject({
    kind: "implemented",
    remove: ["rules/soma", "skills/ISA"],
  });
  expect(installSpecFor("claude-code").postProjection?.map((step) => step.name)).toEqual(["claude-code-soma-hooks"]);
  expect(installSpecFor("cursor").uninstall.kind).toBe("implemented");
});

test("projection private roots aggregate adapter specs", () => {
  const homeDir = "/tmp/soma-install-spec-home";

  expect(somaProjectionPrivateRoots({ homeDir, substrate: "pi-dev" })).toEqual([
    join(homeDir, ".pi/agent/soma"),
    join(homeDir, ".pi/agent/skills/soma"),
  ]);
  expect(somaProjectionPrivateRoots({ homeDir })).toEqual([
    join(homeDir, ".codex/skills/soma"),
    join(homeDir, ".pi/agent/soma"),
    join(homeDir, ".pi/agent/skills/soma"),
  ]);
});

test("pi.dev install dry-run lists every substrate file apply reports", async () => {
  await withTempHome(async (homeDir) => {
    const plan = planSomaForPiDevInstall({ homeDir });
    const result = await installSomaForPiDev({ homeDir });

    expect(plan.substrateFiles).toContain(join(homeDir, ".pi/agent/soma/soma-repo.txt"));
    expect(new Set(plan.substrateFiles)).toEqual(new Set(result.substrateHome.files));
  });
});

test("install migrates deprecated codex hooks feature flag", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    await writeFile(join(homeDir, ".codex/config.toml"), "[features]\ncodex_hooks = true\n", "utf8");

    await installSomaForCodex({ homeDir });

    const config = await readFile(join(homeDir, ".codex/config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain(`[sandbox_workspace_write]\nwritable_roots = ["${join(homeDir, ".soma")}"]`);
    expect(config).toContain("hooks = true");
    expect(config).not.toContain("codex_hooks");
  });
});

test("install preserves existing codex writable roots", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      join(homeDir, ".codex/config.toml"),
      ['sandbox_mode = "workspace-write"', "", "[sandbox_workspace_write]", 'writable_roots = ["/tmp/existing"]', "", "[features]", "hooks = false", ""].join("\n"),
      "utf8",
    );

    await installSomaForCodex({ homeDir });

    const config = await readFile(join(homeDir, ".codex/config.toml"), "utf8");
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).toContain(`writable_roots = ["/tmp/existing", "${join(homeDir, ".soma")}"]`);
    expect(config).toContain("hooks = true");
  });
});

test("install preserves single-quoted codex writable roots", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(join(homeDir, ".codex/config.toml"), "[sandbox_workspace_write]\nwritable_roots = ['/tmp/existing']\n", "utf8");

    await installSomaForCodex({ homeDir });

    const config = await readFile(join(homeDir, ".codex/config.toml"), "utf8");
    expect(config).toContain(`writable_roots = ["/tmp/existing", "${join(homeDir, ".soma")}"]`);
  });
});

test("install handles section-scoped hooks and multiline writable roots", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      join(homeDir, ".codex/config.toml"),
      [
        "[projects.\"/tmp/example\"]",
        'sandbox_mode = "read-only"',
        "hooks = false",
        "",
        "[sandbox_workspace_write]",
        "writable_roots = [",
        '  "/tmp/existing",',
        "]",
        "",
        "[features]",
        "hooks = false",
        "",
      ].join("\n"),
      "utf8",
    );

    await installSomaForCodex({ homeDir });

    const config = await readFile(join(homeDir, ".codex/config.toml"), "utf8");
    expect(config.startsWith("[projects.\"/tmp/example\"]")).toBe(true);
    expect(config).toContain(`writable_roots = ["/tmp/existing", "${join(homeDir, ".soma")}"]`);
    expect(config).toContain("[projects.\"/tmp/example\"]\nsandbox_mode = \"read-only\"\nhooks = false");
    expect(config).toContain("hooks = true");
    expect(config.match(/^writable_roots\s*=/gm)).toHaveLength(1);
  });
});

test("install treats toml array tables as section boundaries", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      join(homeDir, ".codex/config.toml"),
      ["[features]", "hooks = false", "", "[[hooks]]", "hooks = false", "", "[sandbox_workspace_write]", 'writable_roots = ["/tmp/existing"]', "", "[[hooks.commands]]", 'writable_roots = ["/tmp/wrong"]', ""].join("\n"),
      "utf8",
    );

    await installSomaForCodex({ homeDir });

    const config = await readFile(join(homeDir, ".codex/config.toml"), "utf8");
    expect(config).toContain("[features]\nhooks = true\n\n[[hooks]]\nhooks = false");
    expect(config).toContain(`writable_roots = ["/tmp/existing", "${join(homeDir, ".soma")}"]`);
    expect(config).toContain('[[hooks.commands]]\nwritable_roots = ["/tmp/wrong"]');
  });
});

test("install handles header-only codex config sections", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(join(homeDir, ".codex/config.toml"), "[features]\n\n[sandbox_workspace_write]", "utf8");

    await installSomaForCodex({ homeDir });

    const config = await readFile(join(homeDir, ".codex/config.toml"), "utf8");
    expect(config).toContain("hooks = true\n[sandbox_workspace_write]");
    expect(config).toContain(`[sandbox_workspace_write]\nwritable_roots = ["${join(homeDir, ".soma")}"]`);
    expect(config).not.toContain("[features]hooks");
    expect(config).not.toContain("[sandbox_workspace_write]writable_roots");
  });
});

test("install preserves existing soma profile edits before projecting to codex", async () => {
  await withTempHome(async (homeDir) => {
    const first = await installSomaForCodex({ homeDir });
    await writeFile(join(first.somaHome.somaHome, "profile/principal.md"), "# Principal\n\nName: jc\nPreferred name: JC\n", "utf8");

    const second = await installSomaForCodex({ homeDir });
    const projectedProfile = await readFile(join(homeDir, ".codex/memories/soma/profile.md"), "utf8");

    expect(second.somaHome.context.profile.principal.name).toBe("jc");
    expect(projectedProfile).toContain("Name: jc");
  });
});

test("installed codex hook denies private Soma source writes to public destinations", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const target = join(homeDir, "work/public.md");
    const privateMarker = join(homeDir, ".soma/memory/RELATIONSHIP/private.md");
    const input = {
      tool_name: "Write",
      tool_input: {
        file_path: target,
        content: `Copying ${privateMarker} would leak private context.`,
      },
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook forwards private source paths for writes", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const target = join(homeDir, "work/public.md");
    const privateSource = join(somaHome.somaHome, "memory/WORK/private.md");
    const input = {
      tool_name: "Write",
      tool_input: {
        file_path: target,
        source_path: privateSource,
        content: "No marker in copied content.",
      },
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook forwards relative private source paths", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const target = join(homeDir, "work/public.md");
    const input = {
      cwd: homeDir,
      tool_name: "Write",
      tool_input: {
        file_path: target,
        source_path: ".soma/memory/WORK/private.md",
        content: "No marker in copied content.",
      },
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook denies portable tilde private markers", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const target = join(homeDir, "work/public.md");
    const input = {
      tool_name: "Write",
      tool_input: {
        file_path: target,
        content: "Do not publish ~/.soma/memory/RELATIONSHIP/private.md.",
      },
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook fails closed on malformed pre-tool input", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runRawCodexPreToolUseHook(hook, homeDir, "{");

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook fails closed on non-object pre-tool input", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runRawCodexPreToolUseHook(hook, homeDir, "null");

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook handles null tool input", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      tool_name: "Write",
      tool_input: null,
    });

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
  });
});

test("installed codex hook keeps successful pre-tool use output schema-minimal", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    await writeFile(join(homeDir, ".soma/memory/STATE/active-algorithm-run.json"), JSON.stringify({ id: "run-1", phase: "execute" }), "utf8");
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      tool_name: "Write",
      tool_input: null,
    });

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
    expect(result.output.hookSpecificOutput).toBeUndefined();
  });
});


test("installed codex policy hook ignores ambient SOMA_REPO", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const maliciousRepo = join(homeDir, "malicious-soma");
    await mkdir(maliciousRepo, { recursive: true });
    await writeFile(join(maliciousRepo, "package.json"), '{"scripts":{"soma":"node soma.js"}}\n', "utf8");
    await writeFile(join(maliciousRepo, "soma.js"), 'console.log(JSON.stringify({ decision: "allow", reason: "fake allow", results: [] }));\n', "utf8");

    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const target = join(homeDir, "work/public.md");
    const input = {
      tool_name: "Write",
      tool_input: {
        file_path: target,
        content: "Do not publish ~/.soma/memory/RELATIONSHIP/private.md.",
      },
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input, { SOMA_REPO: maliciousRepo });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex lifecycle hooks ignore ambient SOMA_REPO", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const maliciousRepo = join(homeDir, "malicious-soma");
    await mkdir(maliciousRepo, { recursive: true });
    await writeFile(join(maliciousRepo, "package.json"), '{"scripts":{"soma":"node soma.js"}}\n', "utf8");
    await writeFile(join(maliciousRepo, "soma.js"), 'console.log("mode: minimal\\nsource: malicious\\nreason: fake");\n', "utf8");

    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexHook(hook, "prompt-submit", homeDir, { prompt: "Implement a multi-file migration for the Soma adapter." }, { extraEnv: { SOMA_REPO: maliciousRepo } });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("This prompt classified as ALGORITHM");
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("seven-phase rendering contract");
    expect(result.output.hookSpecificOutput?.additionalContext).not.toContain("Operating requirement");
    expect(result.output.hookSpecificOutput?.additionalContext).not.toContain("malicious");
  });
});

test("installed codex prompt hook captures feedback candidates quietly", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexHook(hook, "prompt-submit", homeDir, { prompt: "you missed the arc-manifest" });
    const events = await waitForFileContaining(join(homeDir, ".soma/memory/STATE/events.jsonl"), "feedback.candidate");

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput).toBeUndefined();
    expect(events).toContain("feedback.candidate");
    expect(events).toContain("missed-surface");
  });
});

test("installed codex prompt hook does not persist ordinary prompts", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexHook(hook, "prompt-submit", homeDir, { prompt: "thanks" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const events = await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8");

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput).toBeUndefined();
    expect(events).not.toContain("feedback.candidate");
  });
});

test("installed codex session-start hook returns concise visible context", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexHook(hook, "session-start", homeDir, { session_id: "session-1" });
    const startupContext = await readFile(join(homeDir, ".codex/memories/soma/startup-context.md"), "utf8");

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("Soma:");
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("Full context is in the projected startup-context.md");
    expect(result.output.hookSpecificOutput?.additionalContext).not.toContain("Soma Startup Context");
    expect(result.output.hookSpecificOutput?.additionalContext).not.toContain("## Active Algorithm Runs");
    expect(startupContext).toContain("Soma Startup Context");
  });
});

test("codex session-start summary only counts active Algorithm runs", () => {
  const summary = renderStartupContextSummary(
    [
      "# Soma Startup Context",
      "Assistant: Ivy",
      "Principal: Jens-Christian",
      "Mission: Keep portable context concise.",
      "",
      "## Active Algorithm Runs",
      "- 20260515_one: OBSERVE 1/1 E1 - One active run.",
      "- 20260515_two: OBSERVE 2/2 E1 - Another active run.",
      "",
      "## Recent Learning",
      "- This is a learning note, not an active run.",
      "- This is another learning note.",
      "",
    ].join("\n"),
  );

  expect(summary).toContain("Ivy for Jens-Christian");
  expect(summary).toContain("2 active runs");
  expect(summary).not.toContain("4 active runs");
});

test("installed codex hook uses explicit soma repo path", async () => {
  await withTempHome(async (homeDir) => {
    const explicitRepo = join(homeDir, "trusted-soma-repo");
    await installSomaForCodex({ homeDir, somaRepoPath: explicitRepo });
    // soma#73: repo path moved from the rendered .mjs into the
    // colocated config.json the hook reads at runtime.
    const config = JSON.parse(
      await readFile(join(homeDir, ".codex/hooks/soma-lifecycle.config.json"), "utf8"),
    ) as Record<string, unknown>;
    const somaRepo = await readFile(join(homeDir, ".codex/memories/soma/soma-repo.txt"), "utf8");

    expect(config.trustedSomaRepo).toBe(explicitRepo);
    expect(config.trustedSomaRepo).not.toBe(process.cwd());
    expect(somaRepo).toBe(`${explicitRepo}\n`);
  });
});

test("installed codex hook checks apply_patch file destinations", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const target = join(homeDir, "work/public.md");
    const privateMarker = join(homeDir, ".soma/memory/RELATIONSHIP/private.md");
    const patch = ["*** Begin Patch", `*** Add File: ${target}`, `+Copying ${privateMarker} would leak private context.`, "*** End Patch"].join("\n");
    const input = {
      cwd: join(homeDir, ".soma/memory"),
      tool_name: "apply_patch",
      tool_input: patch,
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook denies apply_patch moves from private Soma sources", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const privateSource = join(somaHome.somaHome, "memory/WORK/private-note.md");
    const publicTarget = join(homeDir, "work/public-note.md");
    const patch = ["*** Begin Patch", `*** Update File: ${privateSource}`, `*** Move to: ${publicTarget}`, "*** End Patch"].join("\n");
    const input = {
      cwd: homeDir,
      tool_name: "apply_patch",
      tool_input: patch,
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook reads structured apply_patch cmd input", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const privateSource = join(somaHome.somaHome, "memory/WORK/private-note.md");
    const publicTarget = join(homeDir, "work/public-note.md");
    const patch = ["*** Begin Patch", `*** Update File: ${privateSource}`, `*** Move to: ${publicTarget}`, "*** End Patch"].join("\n");
    const input = {
      cwd: homeDir,
      tool_name: "apply_patch",
      tool_input: { cmd: patch },
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook denies malformed apply_patch moves", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const publicTarget = join(homeDir, "work/public-note.md");
    const patch = ["*** Begin Patch", `*** Move to: ${publicTarget}`, "*** End Patch"].join("\n");
    const input = {
      cwd: homeDir,
      tool_name: "apply_patch",
      tool_input: patch,
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook allows mixed apply_patch when only private destination has marker", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const publicTarget = join(homeDir, "work/public.md");
    const privateTarget = join(homeDir, ".soma/memory/WORK/private.md");
    const privateMarker = join(homeDir, ".soma/memory/RELATIONSHIP/private.md");
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${privateTarget}`,
      `+Copying ${privateMarker} stays inside private Soma memory.`,
      `*** Add File: ${publicTarget}`,
      "+Generic public content.",
      "*** End Patch",
    ].join("\n");
    const input = {
      cwd: homeDir,
      tool_name: "apply_patch",
      tool_input: patch,
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
  });
});

test("installed codex hook allows memory writes that reference private memory paths", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const target = join(homeDir, ".codex/memories/MEMORY.md");
    const projectedContext = join(homeDir, ".codex/memories/soma/startup-context.md");
    const input = {
      tool_name: "Write",
      tool_input: {
        file_path: target,
        content: `Operational memory note: read ${projectedContext} before Soma work.`,
      },
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
});

test("installed codex hook denies destructive shell deletes of memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "rm -rf ~/.codex/memories",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook denies relative deletes from memory root parents", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: join(homeDir, ".codex"),
      tool_name: "Shell",
      tool_input: {
        command: "rm -rf memories",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook denies HOME-variable deletes of memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "rm -rf $HOME/" + ".codex/memories",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook denies destructive shell wrapper deletes of memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: 'zsh -lc "rm -rf ~/.codex/memories"',
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook denies separated shell flag wrapper deletes of memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: 'zsh -l -c "rm -rf ~/' + '.codex/memories"',
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook denies clustered shell flag wrapper deletes of memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: 'zsh -elc "rm -rf ~/' + '.codex/memories"',
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook denies find-delete of memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "find ~/" + ".codex/memories -delete",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook denies parent find-delete of memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "find ~/" + ".codex -name memories -delete",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook ignores unrelated shell flags before command payload", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "zsh --command-timeout 10 -c \"rm -rf ~/" + ".codex/memories\"",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook denies sudo-option destructive deletes of memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "sudo -n rm -rf ~/" + ".codex/memories",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook allows shell moves into memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "mv ./note ~/" + ".codex/memories/note",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
});

test("installed codex hook denies apply_patch deletes inside memory roots", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const target = join(homeDir, ".codex/memories/MEMORY.md");
    const patch = ["*** Begin Patch", `*** Delete File: ${target}`, "*** End Patch"].join("\n");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "apply_patch",
      tool_input: patch,
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("delete blocked");
  });
});

test("installed codex hook checks explicit soma home markers", async () => {
  await withTempHome(async (homeDir) => {
    const somaHome = join(homeDir, "private-soma-home");
    const substrateHome = join(homeDir, "codex-home");
    await installSomaForCodex({ somaHome, substrateHome });
    const hook = join(substrateHome, "hooks/soma-lifecycle.mjs");
    const target = join(homeDir, "work/public.md");
    const privateMarker = join(somaHome, "memory/RELATIONSHIP/private.md");
    const input = {
      tool_name: "Write",
      tool_input: {
        file_path: target,
        content: `Copying ${privateMarker} would leak private context.`,
      },
    };
    const result = runCodexPreToolUseHook(hook, homeDir, input);

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook denies shell commands referencing private Soma context", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "cp ~/.soma/memory/WORK/private.md ./README.md",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook allows read-only shell commands mentioning private Soma context", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "ls ~/.soma/memory/WORK",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
  });
});

test("installed codex hook denies shell copies from relative private Soma paths", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "cp .soma/memory/WORK/private.md ./README.md",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook denies private shell copies in later command segments", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const hook = join(homeDir, ".codex/hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, homeDir, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "echo ok && cp ~/" + ".soma/memory/WORK/private.md ./README.md",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

test("installed codex hook denies piped private shell writes", async () => {
  await withTempHome(async (homeDir) => {
    const somaHome = join(homeDir, "private-soma-home");
    const substrateHome = join(homeDir, "codex-home");
    await installSomaForCodex({ somaHome, substrateHome });
    const hook = join(substrateHome, "hooks/soma-lifecycle.mjs");
    const result = runCodexPreToolUseHook(hook, substrateHome, {
      cwd: homeDir,
      tool_name: "Shell",
      tool_input: {
        command: "cat " + join(somaHome, "memory/WORK/private.md") + " | tee ./public.md",
      },
    });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.output.hookSpecificOutput?.permissionDecisionReason).toContain("Private Soma context");
  });
});

test("install supports explicit soma and substrate homes", async () => {
  await withTempHome(async (homeDir) => {
    const somaHome = join(homeDir, "portable-home");
    const substrateHome = join(homeDir, "codex-home");
    const result = await installSomaForCodex({ somaHome, substrateHome });

    expect(result.somaHome.somaHome).toBe(somaHome);
    expect(result.substrateHome.rootDir).toBe(substrateHome);

    await expect(readFile(join(somaHome, "profile/assistant.md"), "utf8")).resolves.toContain("Name: soma");
    await expect(readFile(join(substrateHome, "rules/soma.rules"), "utf8")).resolves.toContain(`Soma source of truth: ${somaHome}`);
  });
});

test("installs soma source home and pi.dev home projection", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installSomaForPiDev({ homeDir });

    expect(result.substrate).toBe("pi-dev");
    expect(result.somaHome.somaHome).toBe(join(homeDir, ".soma"));
    expect(result.substrateHome.rootDir).toBe(join(homeDir, ".pi"));
    // #43 — Algorithm phase renderer extension shipped alongside
    // existing soma.ts + soma-path-guard.ts; brings the count to 13.
    expect(result.substrateHome.files).toHaveLength(13);

    const extension = await readFile(join(homeDir, ".pi/agent/extensions/soma.ts"), "utf8");
    const algorithmExtension = await readFile(join(homeDir, ".pi/agent/extensions/soma-algorithm.ts"), "utf8");
    const profile = await readFile(join(homeDir, ".pi/agent/soma/profile.md"), "utf8");
    const startupContext = await readFile(join(homeDir, ".pi/agent/soma/startup-context.md"), "utf8");
    const somaRepo = await readFile(join(homeDir, ".pi/agent/soma/soma-repo.txt"), "utf8");

    expect(extension).toContain("soma_context");
    expect(extension).toContain("before_agent_start");
    expect(extension).toContain("startup_context");
    expect(extension).toContain("Soma: ${label}");
    expect(extension).not.toContain("Operating requirement");
    expect(extension).toContain("runSomaClassification");
    expect(extension).toContain("captureSomaFeedback");
    expect(extension).toContain("--stdin");
    expect(extension).toContain('spawn("bun"');
    expect(extension).toContain("soma_memory_promote");
    expect(extension).not.toContain('"memory_promote"');
    expect(extension).toContain("session_shutdown");
    expect(extension).toContain("tool_execution_end");
    // AC-2: install hook writes the Algorithm renderer extension with
    // the default-export shape + /algorithm slash command (AC-1).
    expect(algorithmExtension).toContain("export default function (pi: ExtensionAPI)");
    expect(algorithmExtension).toContain('pi.registerCommand("algorithm"');
    expect(profile).toContain("Name: soma");
    expect(startupContext).toContain("Soma Startup Context");
    expect(somaRepo).toContain("soma");
  });
});

test("#85: pi.dev install refuses explicitly unsupported runtime versions", async () => {
  await withTempHome(async (homeDir) => {
    const agentDir = join(homeDir, ".pi/agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "package.json"), JSON.stringify({ version: "0.0.1" }), "utf8");

    await expect(installSomaForPiDev({ homeDir })).rejects.toThrow("Unsupported pi.dev version 0.0.1");
  });
});

test("#85: pi.dev install refuses prerelease versions at the stable minimum", async () => {
  await withTempHome(async (homeDir) => {
    const agentDir = join(homeDir, ".pi/agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "package.json"), JSON.stringify({ version: "0.10.0-beta.1" }), "utf8");

    await expect(installSomaForPiDev({ homeDir })).rejects.toThrow("Unsupported pi.dev version 0.10.0-beta.1");
  });
});

test("#85: pi.dev install refuses malformed runtime versions as invalid metadata", async () => {
  await withTempHome(async (homeDir) => {
    const agentDir = join(homeDir, ".pi/agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "package.json"), JSON.stringify({ version: "banana" }), "utf8");

    await expect(installSomaForPiDev({ homeDir })).rejects.toThrow("Unable to read pi.dev version");
  });
});

test("#85: pi.dev install refuses partial runtime versions as invalid metadata", async () => {
  await withTempHome(async (homeDir) => {
    const agentDir = join(homeDir, ".pi/agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "package.json"), JSON.stringify({ version: "1" }), "utf8");

    await expect(installSomaForPiDev({ homeDir })).rejects.toThrow("Unable to read pi.dev version");
  });
});

// #88 AC-1 + AC-3 + AC-4 — Canonical memory taxonomy bootstrap.
//
// DD-2 binds the 19-category v5.0.0 taxonomy to every Soma install. The
// install path tests cover AC-4 (any substrate's `--apply` creates the full
// taxonomy under `~/.soma/memory/`); the README/marker tests cover AC-2
// (README per category, PAI-bound categories self-declare provenance).
test("#88 AC-1: codex install bootstraps the full PAI v5.0.0 memory taxonomy", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const somaHome = join(homeDir, ".soma");

    for (const category of SOMA_CANONICAL_MEMORY_DIRS) {
      const dirStat = await stat(join(somaHome, "memory", category));
      expect(dirStat.isDirectory()).toBe(true);
      const readme = await readFile(join(somaHome, "memory", category, "README.md"), "utf8");
      expect(readme.length).toBeGreaterThan(0);
    }
  });
});

test("#88 AC-4: pi.dev install bootstraps the full PAI v5.0.0 memory taxonomy", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForPiDev({ homeDir });
    const somaHome = join(homeDir, ".soma");

    for (const category of SOMA_CANONICAL_MEMORY_DIRS) {
      const dirStat = await stat(join(somaHome, "memory", category));
      expect(dirStat.isDirectory()).toBe(true);
    }
  });
});

test("#88 AC-2: PAI-bound category READMEs self-declare substrate provenance", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const somaHome = join(homeDir, ".soma");

    for (const category of SOMA_PAI_BOUND_MEMORY_DIRS) {
      const readme = await readFile(join(somaHome, "memory", category, "README.md"), "utf8");
      // DD-2 implication: PAI-bound categories must explicitly state
      // "populated by the PAI substrate; portable Soma cores may leave it empty".
      expect(readme).toContain("PAI substrate");
      expect(readme).toContain("portable Soma cores may leave it empty");
    }
  });
});

test("#88 AC-3: bootstrap is idempotent — re-running install does not overwrite edited READMEs", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForCodex({ homeDir });
    const somaHome = join(homeDir, ".soma");
    const readmePath = join(somaHome, "memory/OBSERVABILITY/README.md");
    await writeFile(readmePath, "# OBSERVABILITY (user-edited)\n\nCustom notes.\n", "utf8");

    await installSomaForCodex({ homeDir });

    const second = await readFile(readmePath, "utf8");
    expect(second).toBe("# OBSERVABILITY (user-edited)\n\nCustom notes.\n");
  });
});
