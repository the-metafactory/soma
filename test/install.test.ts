import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { installSomaForCodex, installSomaForPiDev } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-install-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function runCodexHook(
  hook: string,
  event: string,
  homeDir: string,
  input: unknown,
  options: { extraEnv?: NodeJS.ProcessEnv; rawInput?: boolean } = {},
): { status: number | null; output: { continue?: boolean; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } } } {
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
    output: JSON.parse(result.stdout) as { continue?: boolean; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } },
  };
}

function runCodexPreToolUseHook(
  hook: string,
  homeDir: string,
  input: unknown,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; output: { continue?: boolean; hookSpecificOutput?: { permissionDecision?: string } } } {
  return runCodexHook(hook, "pre-tool-use", homeDir, input, { extraEnv });
}

function runRawCodexPreToolUseHook(hook: string, homeDir: string, input: string): { status: number | null; output: { continue?: boolean; hookSpecificOutput?: { permissionDecision?: string } } } {
  return runCodexHook(hook, "pre-tool-use", homeDir, input, { rawInput: true });
}

test("installs soma source home and codex home projection", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installSomaForCodex({ homeDir });

    expect(result.substrate).toBe("codex");
    expect(result.somaHome.somaHome).toBe(join(homeDir, ".soma"));
    expect(result.substrateHome.rootDir).toBe(join(homeDir, ".codex"));
    expect(result.substrateHome.files).toHaveLength(16);

    const telos = await readFile(join(homeDir, ".soma/profile/telos.md"), "utf8");
    const rules = await readFile(join(homeDir, ".codex/rules/soma.rules"), "utf8");
    const config = await readFile(join(homeDir, ".codex/config.toml"), "utf8");
    const hooks = await readFile(join(homeDir, ".codex/hooks.json"), "utf8");
    const somaRepo = await readFile(join(homeDir, ".codex/memories/soma/soma-repo.txt"), "utf8");
    const skill = await readFile(join(homeDir, ".codex/skills/soma/SKILL.md"), "utf8");
    const startupContext = await readFile(join(homeDir, ".codex/memories/soma/startup-context.md"), "utf8");

    expect(telos).toContain("Keep personal assistant context portable across substrates.");
    expect(rules).toContain(`Soma source of truth: ${join(homeDir, ".soma")}`);
    expect(config).not.toContain("sandbox_mode");
    expect(config).toContain(`[sandbox_workspace_write]\nwritable_roots = ["${join(homeDir, ".soma")}"]`);
    expect(config).toContain("hooks = true");
    expect(config).not.toContain("codex_hooks");
    expect(hooks).toContain("soma-lifecycle.mjs");
    expect(hooks).toContain("UserPromptSubmit");
    expect(somaRepo).toContain("soma");
    expect(skill).toContain("name: soma");
    expect(startupContext).toContain("Soma Startup Context");
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
    const result = runCodexHook(hook, "prompt-submit", homeDir, { prompt: "Build the Soma guard." }, { extraEnv: { SOMA_REPO: maliciousRepo } });

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("Soma Prompt Classification");
    expect(result.output.hookSpecificOutput?.additionalContext).not.toContain("malicious");
  });
});

test("installed codex hook uses explicit soma repo path", async () => {
  await withTempHome(async (homeDir) => {
    const explicitRepo = join(homeDir, "trusted-soma-repo");
    await installSomaForCodex({ homeDir, somaRepoPath: explicitRepo });
    const hook = await readFile(join(homeDir, ".codex/hooks/soma-lifecycle.mjs"), "utf8");
    const somaRepo = await readFile(join(homeDir, ".codex/memories/soma/soma-repo.txt"), "utf8");

    expect(hook).toContain(JSON.stringify(explicitRepo));
    expect(hook).not.toContain(JSON.stringify(process.cwd()));
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
    expect(result.substrateHome.files).toHaveLength(11);

    const extension = await readFile(join(homeDir, ".pi/agent/extensions/soma.ts"), "utf8");
    const profile = await readFile(join(homeDir, ".pi/agent/soma/profile.md"), "utf8");
    const startupContext = await readFile(join(homeDir, ".pi/agent/soma/startup-context.md"), "utf8");
    const somaRepo = await readFile(join(homeDir, ".pi/agent/soma/soma-repo.txt"), "utf8");

    expect(extension).toContain("soma_context");
    expect(extension).toContain("before_agent_start");
    expect(extension).toContain("startup_context");
    expect(extension).toContain("Soma Prompt Classification");
    expect(extension).toContain("runSomaClassification");
    expect(extension).toContain("soma_memory_promote");
    expect(extension).not.toContain('"memory_promote"');
    expect(extension).toContain("session_shutdown");
    expect(extension).toContain("tool_execution_end");
    expect(profile).toContain("Name: soma");
    expect(startupContext).toContain("Soma Startup Context");
    expect(somaRepo).toContain("soma");
  });
});
