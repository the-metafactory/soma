import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { installToolNudges, readToolNudges, skillNudges } from "../../src/substrates/adapters/shared/tool-nudges";
import { renderSomaRoutingExtension } from "../../src/substrates/adapters/pi-dev/extensions/soma-routing";
import { STUB_RUNTIME_SOURCE } from "../fixtures/stub-runtime";
import { installSomaForClaudeCode, installSomaForCodex, installSomaForPiDev } from "../fixtures/shared-runtime";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "soma-tool-nudges-"));
  roots.push(root);
  return root;
}

const BENCHMARK = `---
name: benchmark-checklist
route: When measuring performance
nudge:
  - tool: Bash
    command: '\\bhyperfine\\b'
    text: 'Benchmark checklist: read {path}.'
---
# Benchmark checklist
`;

async function putSkill(home: string, name: string, content = BENCHMARK): Promise<string> {
  const file = join(home, "skills", name, "SKILL.md");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

test("skill nudges accept flow and block YAML, CRLF, multiple rules and quoted regexes", () => {
  expect(skillNudges(BENCHMARK, "skills/benchmark-checklist/SKILL.md")).toEqual([{
    tool: "Bash", command: "\\bhyperfine\\b", text: "Benchmark checklist: read {path}.", file: "skills/benchmark-checklist/SKILL.md",
  }]);
  const flow = '---\r\nname: arbitrary-pack-skill\r\nnudge: [{tool: Read, text: "Inspect {path}"}, {tool: Bash, command: "^measure", text: "Measure"}]\r\n---\r\n';
  expect(skillNudges(flow, "skills/arbitrary/SKILL.md")).toHaveLength(2);
  expect(skillNudges("---\nname: no-nudge\n---\nnudge: ignored body", "x")).toEqual([]);
  expect(skillNudges("# no frontmatter", "x")).toEqual([]);
});

test("additive nudge fields are ignored and cannot override the installed target", () => {
  expect(skillNudges('---\nnudge: [{tool: Bash, text: hi, file: /outside, future: true}]\n---\n', "skills/pack/SKILL.md"))
    .toEqual([{ tool: "Bash", text: "hi", file: "skills/pack/SKILL.md" }]);
});

test("invalid installed skills warn and retain only their own prior rules", async () => {
  const home = await tempHome();
  const file = await putSkill(home, "benchmark-checklist");
  const removed = await putSkill(home, "removed");
  const edited = await putSkill(home, "edited");
  await installToolNudges({ somaHome: home });
  await rm(dirname(removed), { recursive: true });
  await writeFile(edited, BENCHMARK.replace("Benchmark checklist:", "UPDATED:"));
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await putSkill(home, "new-invalid", '---\nnudge: wrong\n---\n');
    for (const value of ['[{tool: Bash, command: "[", text: hi}]', '[{tool: Bash}]', 'wrong', '[broken']) {
      await writeFile(file, `---\nnudge: ${value}\n---\n`);
      await installToolNudges({ somaHome: home });
      const rules = await readToolNudges(home);
      expect(rules).toHaveLength(5);
      expect(rules.find(({ file }) => file === "skills/benchmark-checklist/SKILL.md")?.text).toBe("Benchmark checklist: read {path}.");
      expect(rules.find(({ file }) => file === "skills/edited/SKILL.md")?.text).toBe("UPDATED: read {path}.");
      expect(warning.mock.calls.flat().join("\n")).toContain("skills/benchmark-checklist/SKILL.md");
    }
    await writeFile(file, "---\nname: benchmark-checklist\n---\n");
    await installToolNudges({ somaHome: home });
    expect(await readToolNudges(home)).toHaveLength(4);
  } finally {
    warning.mockRestore();
  }
});

test("invalid new skill metadata installs without prior rules, including a corrupt prior cache", async () => {
  const home = await tempHome();
  await putSkill(home, "bad", '---\nnudge: [{tool: Bash}]\n---\n');
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await installToolNudges({ somaHome: home });
    expect(await readToolNudges(home)).toHaveLength(3);
    for (const content of ["bad JSON", '[{"tool":42}]']) {
      await writeFile(join(home, "runtime/tool-nudges.json"), content);
      await installToolNudges({ somaHome: home });
      expect(await readToolNudges(home)).toHaveLength(3);
    }
    expect(warning.mock.calls.flat().join("\n")).toContain("skills/bad/SKILL.md");
  } finally {
    warning.mockRestore();
  }
});

test("pi contains missing runtime, malformed JSON, and invalid rule failures", async () => {
  const home = await tempHome();
  const extension = join(home, "soma-routing.mjs");
  await writeFile(extension, new Bun.Transpiler({ loader: "ts" }).transformSync(renderSomaRoutingExtension(home)));
  const probe = `
    import extension from ${JSON.stringify(pathToFileURL(extension).href)};
    let handler;
    extension({ on(name, callback) { handler = callback; } });
    const event = { toolName: "bash", input: { command: "hyperfine x" }, content: [{type:"text",text:"ORIGINAL"}] };
    const before = JSON.stringify(event);
    const result = await handler(event);
    if (result !== undefined || JSON.stringify(event) !== before) throw new Error("tool result changed");
    console.log("preserved");
  `;
  const check = () => {
    const result = spawnSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("preserved");
    expect(result.stderr).toContain("Soma tool nudge failed:");
  };
  check();
  await installToolNudges({ somaHome: home });
  for (const content of ["invalid JSON", '[{"tool":42}]']) {
    await writeFile(join(home, "runtime/tool-nudges.json"), content);
    check();
  }
});

test("a missing skills directory still yields exactly the three principle rules", async () => {
  const home = await tempHome();
  const rules = await readToolNudges(home);
  expect(rules).toHaveLength(3);
  expect(rules.every(({ file }) => file.startsWith("skills/the-algorithm/references/principles/"))).toBe(true);
  await mkdir(join(home, "skills"));
  await writeFile(join(home, "skills/stray-file"), "not a skill");
  expect(await readToolNudges(home)).toEqual(rules);
});

test("runtime command tuning rejects the watcher false-positive classes and recognizes real commands", async () => {
  const home = await tempHome();
  await putSkill(home, "benchmark-checklist");
  const principles = join(home, "skills/the-algorithm/references/principles");
  await mkdir(principles, { recursive: true });
  for (const name of ["own-delegated-work", "weigh-review-findings-on-merit", "verify-before-claiming"]) await writeFile(join(principles, `${name}.md`), "# principle");
  await installToolNudges({ somaHome: home });
  const { toolNudgeLines } = await import(pathToFileURL(join(home, "runtime/tool-nudges.mjs")).href);
  const run = (command: string) => toolNudgeLines(home, "Bash", { command });
  for (const command of [
    `grep -n "git commit" src/hooks.ts`,
    `echo '{"command":"git commit"}' | bun hook.mjs`,
    `python3 - <<'EOF'\nprint('git commit')\nEOF`,
    `cat <<'EOF'\ngh pr view 12\nhyperfine x\nEOF`,
    "ls benchmarks/",
    "rg hyperfine .",
    "cat benchmark-checklist/SKILL.md",
    "echo hyperfine",
    "# git commit\nls",
    'printf "%s" "gh pr create; hyperfine; git commit"',
  ]) expect(run(command)).toEqual([]);
  for (const command of [
    "git commit -m x", "cd repo && git add -A && git commit -m x", "git -C repo commit -m x",
    "rtk git -C 'repo with spaces' commit -m x", "rtk proxy git commit -m x", "gh pr create --fill",
    "if true; then git commit -m x; fi", "SOME_VAR=yes git commit -m x",
  ]) expect(run(command).join("\n")).toContain("verify-before-claiming.md");
  for (const command of ["gh pr view 12 --comments", "gh pr checks 12", 'gh api "repos/a/b/pulls/1/reviews"']) {
    expect(run(command).join("\n")).toContain("weigh-review-findings-on-merit.md");
  }
  expect(run("hyperfine 'bun a.ts'").join("\n")).toContain("benchmark-checklist");
  expect(toolNudgeLines(home, "functions.exec_command", { cmd: "hyperfine x" }).join("\n")).toContain("benchmark-checklist");
  expect(toolNudgeLines(home, "shell", { command: ["bash", "-lc", "hyperfine x"] }).join("\n")).toContain("benchmark-checklist");
  expect(toolNudgeLines(home, "wait_agent", {}).join("\n")).toContain("own-delegated-work.md");
  expect(toolNudgeLines(home, "functions.wait", {})).toEqual([]);
  expect(toolNudgeLines(home, "functions.wait", { ids: ["subagent-id"] }).join("\n")).toContain("own-delegated-work.md");
});

const installs = [
  { substrate: "claude-code", install: installSomaForClaudeCode, dir: ".claude" },
  { substrate: "codex", install: installSomaForCodex, dir: ".codex" },
  { substrate: "pi-dev", install: installSomaForPiDev, dir: ".pi" },
];

for (const { substrate, install, dir } of installs) {
  test(`${substrate}: real install and emitted hook consume pack data, edits, missing targets and removal`, async () => {
    const homeDir = await tempHome();
    const somaHome = join(homeDir, ".soma");
    const file = await putSkill(somaHome, "benchmark-checklist", BENCHMARK.replace("\n---\n", "\n  - tool: Read\n    text: 'Read nudge: {path}'\n---\n"));
    const options = { homeDir, runtimeSourceRoot: STUB_RUNTIME_SOURCE, modeClassifier: false, policyGuard: false, preCompact: false, statusLine: false, feedbackCapture: false };
    await install(options);
    const substrateHome = join(homeDir, dir);
    let run: (tool: string, command: string) => Promise<string>;
    let runtimeMissing = false;
    if (substrate === "pi-dev") {
      const extension = join(substrateHome, "agent/extensions/soma-routing.ts");
      const module = await import(pathToFileURL(extension).href);
      const nodeModule = join(homeDir, "pi-routing-node.mjs");
      await writeFile(nodeModule, new Bun.Transpiler({ loader: "ts" }).transformSync(await readFile(extension, "utf8")));
      const probe = `
        import extension from ${JSON.stringify(pathToFileURL(nodeModule).href)};
        let handler;
        extension({ on(name, callback) { if (name === "tool_result") handler = callback; } });
        const result = await handler({ toolName: "bash", input: { command: "hyperfine x" }, content: [{type:"text",text:"NODE ORIGINAL"}] });
        console.log(JSON.stringify(result));
      `;
      const node = spawnSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
      expect(node.status).toBe(0);
      expect(node.stderr).toBe("");
      expect(node.stdout).toContain("NODE ORIGINAL");
      expect(node.stdout).toContain(file);
      interface Event { toolName: string; input: { command: string }; content: { type: "text"; text: string }[] }
      type Handler = (event: Event) => Promise<{ content: { type: string; text: string }[] } | undefined>;
      let handler: Handler | undefined;
      module.default({ on: (name: string, callback: Handler) => { expect(name).toBe("tool_result"); handler = callback; } });
      run = async (tool, command) => {
        if (!handler) throw new Error("pi tool_result handler was not registered");
        const result = await handler({ toolName: tool, input: { command }, content: [{ type: "text", text: "ORIGINAL TOOL OUTPUT" }] });
        if (result === undefined) return "";
        expect(result.content[0]?.text).toBe("ORIGINAL TOOL OUTPUT");
        return result.content.slice(1).map(({ text }) => text).join("\n");
      };
    } else {
      const isCodex = substrate === "codex";
      const hook = join(substrateHome, isCodex ? "hooks/soma-lifecycle.mjs" : "hooks/soma/soma-claude-code-hook.mjs");
      const config = JSON.parse(await readFile(join(substrateHome, isCodex ? "hooks.json" : "settings.json"), "utf8"));
      const registration = config.hooks.PostToolUse.flatMap((group: { hooks: { command: string }[] }) => group.hooks)
        .find((entry: { command: string }) => entry.command.endsWith(isCodex ? " post-tool-use" : " principle-nudge"));
      expect(registration).toBeDefined();
      run = async (tool, command) => {
        const input = isCodex ? { tool_name: tool, tool_input: { cmd: command } } : { tool_name: tool, tool_input: { command } };
        const result = spawnSync(process.execPath, [hook, isCodex ? "post-tool-use" : "principle-nudge"], { input: JSON.stringify(input), encoding: "utf8" });
        expect(result.status).toBe(0);
        if (runtimeMissing && isCodex) expect(result.stderr).toContain("Soma tool nudge failed:");
        else expect(result.stderr).toBe("");
        return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : "";
      };
    }
    const shell = substrate === "codex" ? "functions.exec_command" : substrate === "pi-dev" ? "bash" : "Bash";
    expect(await run(shell, "hyperfine 'bun a.ts'")).toContain(file);
    expect(await run("Read", "")).toContain("Read nudge:");
    expect(await run(shell, 'rg "hyperfine" skills/')).toBe("");
    expect(await run(shell, "git -C repo commit -m x")).toContain("verify-before-claiming.md");
    expect(await run(shell, "gh pr view 12 --comments")).toContain("weigh-review-findings-on-merit.md");
    expect(await run(substrate === "codex" ? "wait_agent" : "Agent", "")).toContain("own-delegated-work.md");

    await writeFile(file, BENCHMARK.replace("hyperfine", "measure").replace("Benchmark checklist:", "UPDATED:"));
    await install(options);
    expect(await run(shell, "hyperfine x")).toBe("");
    expect(await run(shell, "measure x")).toContain("UPDATED:");
    await writeFile(file, '---\nnudge: [{tool: Bash}]\n---\n');
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await install(options);
      expect(warning.mock.calls.flat().join("\n")).toContain("skills/benchmark-checklist/SKILL.md");
      expect(await run(shell, "measure x")).toContain("UPDATED:");
    } finally {
      warning.mockRestore();
    }
    await rm(file);
    expect(await run(shell, "measure x")).toBe("");
    await rm(dirname(file), { recursive: true });
    await install(options);
    expect(await run(shell, "hyperfine x")).toBe("");
    expect(await run(shell, "measure x")).toBe("");
    const rules = JSON.parse(await readFile(join(somaHome, "runtime/tool-nudges.json"), "utf8"));
    expect(rules).toHaveLength(3);
    expect(await run(shell, "git commit -m x")).toContain("verify-before-claiming.md");
    expect(await run(shell, "gh pr view 12")).toContain("weigh-review-findings-on-merit.md");
    expect(await run("Agent", "")).toContain("own-delegated-work.md");
    // The pi missing-runtime case is covered above in a fresh Node process.
    await rm(join(somaHome, "runtime/tool-nudges.mjs"));
    runtimeMissing = true;
    if (substrate !== "pi-dev") expect(await run(shell, "git commit -m x")).toBe("");
  }, 60000);
}
