import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  addAlgorithmCapabilities,
  advanceAlgorithmRun,
  classifyAlgorithmPrompt,
  createAlgorithmRun,
  getCriteria,
  getRunPhase,
  recordAlgorithmCapabilityInvocation,
  recordAlgorithmLearning,
  registerAlgorithmCapabilityDefinition,
  applyAlgorithmBatch,
  removeAlgorithmCapabilitySelection,
  setAlgorithmPlan,
  selectAlgorithmCapability,
  updateAlgorithmPlanStep,
  verifyAlgorithmCriterion,
  writeAlgorithmRun,
} from "../src/index";
import { loadSomaHomeAlgorithmCapabilityRegistry } from "../src/algorithm-capabilities";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-algorithm-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeSkill(homeDir: string, slug: string, name: string, somaHome = ".soma"): Promise<void> {
  const root = join(homeDir, somaHome, "skills", slug);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} test skill.`, "---", "", `# ${name}`, ""].join("\n"),
    "utf8",
  );
}

async function writeSkillManifest(
  homeDir: string,
  slug: string,
  manifest: Record<string, unknown>,
  somaHome = ".soma",
): Promise<void> {
  const root = join(homeDir, somaHome, "skills", slug);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "soma-skill.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeAlgorithmCapabilitiesReference(homeDir: string, somaHome = ".soma"): Promise<void> {
  const root = join(homeDir, somaHome, "skills", "the-algorithm", "references");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "capabilities.md"),
    [
      "# Algorithm Capabilities Reference",
      "",
      "| Capability | Phases | Trigger Signal | Invoke | Typical Cost |",
      "|------------|--------|----------------|--------|--------------|",
      '| FirstPrinciples | THINK | Architecture decisions | `Skill("FirstPrinciples")` | E2+ |',
      '| MissingSkill | THINK | Missing target | `Skill("MissingSkill")` | E2+ |',
      '| ReReadCheck | VERIFY->LEARN | Final check | *(inline doctrine step - no external tool)* | E1+ |',
      '| Forge (code producer) | EXECUTE | Code production | `Agent(subagent_type="Forge", prompt="...")` | E3+ |',
      "",
      "| Capability | When | Invoke |",
      "|------------|------|--------|",
      "| BuildCommand | EXECUTE | `bun run build` |",
      "| WrappedBuildCommand | EXECUTE | *bun run wrapped* |",
      "",
    ].join("\n"),
    "utf8",
  );
}

function registerFirstPrinciples(run: ReturnType<typeof createAlgorithmRun>) {
  return registerAlgorithmCapabilityDefinition(run, {
    name: "FirstPrinciples",
    kind: "skill",
    phases: ["think", "plan"],
    triggerSignals: ["assumption", "root cause", "fundamentals", "first principles"],
    invoke: { contract: "skill", target: "FirstPrinciples" },
  });
}

test("creates deterministic Algorithm runs around ISA criteria", () => {
  const run = createAlgorithmRun({
    id: "ledger-update",
    timestamp: "2026-05-14T10:00:00.000Z",
    prompt: "Create a verified ledger update",
    intent: "Bring ledger state current.",
    currentState: "Ledger is stale.",
    goal: "Ledger is current and verified.",
    criteria: [{ id: "C1", text: "Ledger contains the new entry." }],
  });

  expect(getRunPhase(run)).toBe("observe");
  expect(run.effort).toBe("E1");
  expect(run.effortSource).toBe("auto");
  expect(run.classificationReason).toContain("E1");
  expect(run.isa.frontmatter.phase).toBe("observe");
  expect(getCriteria(run.isa)[0]?.status).toBe("open");
  expect(run.decisions[0]?.text).toContain("Bring ledger state current");
});

test("generates date-first Algorithm run ids", () => {
  const run = createAlgorithmRun({
    timestamp: "2026-05-14T10:00:00.000Z",
    prompt: "Name a run",
    intent: "Exercise generated ids.",
    currentState: "No id provided.",
    goal: "Generated id is sortable.",
    criteria: [{ id: "C1", text: "Id starts with date." }],
  });

  expect(run.id).toMatch(/^20260514_alg_[a-f0-9]{8}$/);
});

test("classifies prompts into Algorithm mode and effort tiers", () => {
  expect(classifyAlgorithmPrompt("ok")).toMatchObject({
    mode: "minimal",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("ok thanks")).toMatchObject({
    mode: "minimal",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("great, that works nicely")).toMatchObject({
    mode: "minimal",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("what's next?")).toMatchObject({
    mode: "native",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("what time is it")).toMatchObject({
    mode: "native",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("run the tests")).toMatchObject({
    mode: "native",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("how does PAI handle the classification?")).toMatchObject({
    mode: "native",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("Implement a multi-file migration for the adapter")).toMatchObject({
    mode: "algorithm",
    effort: "E3",
    source: "auto",
  });
  expect(
    classifyAlgorithmPrompt(
      "Identify a genuinely surprising, telos-aligned outcome of Jens-Christian's AI-consulting work, with clear reasoning and implications.",
    ),
  ).toMatchObject({
    mode: "algorithm",
    effort: "E2",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("/e4 redesign the policy enforcement architecture")).toMatchObject({
    mode: "algorithm",
    effort: "E4",
    source: "explicit",
  });
});

test("enforces Algorithm phase gates", () => {
  let run = createAlgorithmRun({
    id: "portable-test",
    timestamp: "2026-05-14T10:00:00.000Z",
    prompt: "Make this portable",
    intent: "Create a portable harness.",
    currentState: "Algorithm is declarative.",
    goal: "Algorithm has enforced phase gates.",
    criteria: [{ id: "C1", text: "Phase gates reject incomplete work." }],
  });

  run = advanceAlgorithmRun(run, "2026-05-14T10:01:00.000Z");
  expect(getRunPhase(run)).toBe("think");

  expect(() => advanceAlgorithmRun(run)).toThrow("selected capabilities");
  run = addAlgorithmCapabilities(run, ["sequential-analysis"], "2026-05-14T10:02:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:03:00.000Z");
  expect(getRunPhase(run)).toBe("plan");

  expect(() => advanceAlgorithmRun(run)).toThrow("criterion-mapped plan");
  run = setAlgorithmPlan(
    run,
    [{ id: "P1", text: "Add harness tests.", criteriaIds: ["C1"], status: "open" }],
    "2026-05-14T10:04:00.000Z",
  );
  run = advanceAlgorithmRun(run, "2026-05-14T10:05:00.000Z");
  expect(getRunPhase(run)).toBe("build");

  run = {
    ...run,
    changelog: [{ timestamp: "2026-05-14T10:06:00.000Z", phase: "build", text: "Added harness." }],
  };
  run = advanceAlgorithmRun(run, "2026-05-14T10:07:00.000Z");
  expect(getRunPhase(run)).toBe("execute");

  expect(() => advanceAlgorithmRun(run)).toThrow("plan step");
  run = updateAlgorithmPlanStep(run, "P1", "done", "Harness tests pass.", "2026-05-14T10:08:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:09:00.000Z");
  expect(getRunPhase(run)).toBe("verify");

  expect(() => advanceAlgorithmRun(run)).toThrow("criterion");
  run = verifyAlgorithmCriterion(run, "C1", "passed", "Test asserted gate failures and success path.", "2026-05-14T10:10:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:11:00.000Z");
  expect(getRunPhase(run)).toBe("learn");

  run = {
    ...run,
    learning: [{ timestamp: "2026-05-14T10:12:00.000Z", phase: "learn", text: "Harness gates doctrine." }],
  };
  expect(() => advanceAlgorithmRun(run)).toThrow("not invoked or removed");
  run = recordAlgorithmCapabilityInvocation(
    run,
    { name: "sequential-analysis", substrate: "codex", evidence: "Used sequential analysis to reduce the phase gates to necessary state transitions." },
    "2026-05-14T10:12:30.000Z",
  );
  run = advanceAlgorithmRun(run, "2026-05-14T10:13:00.000Z");
  expect(getRunPhase(run)).toBe("complete");
});

test("records structured Algorithm capability selections and invocations", () => {
  let run = createAlgorithmRun({
    id: "capability-binding",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Use structured capabilities",
    intent: "Port PAI capability invocation semantics.",
    currentState: "Capabilities are only strings.",
    goal: "Selected capabilities require invocation evidence.",
    criteria: [{ id: "C1", text: "Capability selection is structured." }],
  });
  run = registerFirstPrinciples(run);

  run = selectAlgorithmCapability(
    run,
    { name: "FirstPrinciples", phase: "think", reason: "Need to reduce the issue to portable primitives." },
    "2026-05-21T10:01:00.000Z",
  );

  expect(run.capabilities).toEqual(["FirstPrinciples"]);
  expect(run.capabilitySelections?.[0]).toMatchObject({
    name: "FirstPrinciples",
    phase: "think",
    reason: "Need to reduce the issue to portable primitives.",
    status: "selected",
  });

  run = recordAlgorithmCapabilityInvocation(
    run,
    { name: "FirstPrinciples", substrate: "codex", evidence: "Deconstructed PAI semantics into registry, selection, and invocation evidence." },
    "2026-05-21T10:02:00.000Z",
  );

  expect(run.capabilitySelections?.[0]).toMatchObject({
    status: "invoked",
    invocation: {
      substrate: "codex",
      contract: "skill",
      target: "FirstPrinciples",
      evidence: "Deconstructed PAI semantics into registry, selection, and invocation evidence.",
    },
  });
});

test("loads migrated PAI Algorithm skill capabilities from Soma home", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmCapabilitiesReference(homeDir);
    await writeSkill(homeDir, "first-principles", "FirstPrinciples");

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir });

    expect(registry.definitions.find((definition) => definition.name === "FirstPrinciples")).toMatchObject({
      name: "FirstPrinciples",
      kind: "skill",
      phases: ["think"],
      invoke: { contract: "skill", target: "FirstPrinciples" },
    });
    expect(registry.definitions.find((definition) => definition.name === "Forge")).toMatchObject({
      name: "Forge",
      kind: "agent",
      phases: ["execute"],
      invoke: { contract: "agent", target: "Forge" },
    });
    expect(registry.definitions.find((definition) => definition.name === "ReReadCheck")).toMatchObject({
      name: "ReReadCheck",
      kind: "inline",
      phases: ["verify", "learn"],
    });
    expect(registry.definitions.find((definition) => definition.name === "BuildCommand")).toMatchObject({
      name: "BuildCommand",
      kind: "command",
      phases: ["execute"],
      invoke: { contract: "command", target: "bun run build" },
    });
    expect(registry.definitions.find((definition) => definition.name === "WrappedBuildCommand")).toMatchObject({
      name: "WrappedBuildCommand",
      kind: "command",
      phases: ["execute"],
      invoke: { contract: "command", target: "bun run wrapped" },
    });
    expect(registry.definitions.some((definition) => definition.name === "MissingSkill")).toBe(false);
    expect(registry.unsupported).toContain("MissingSkill");
  });
});

test("prefers explicit skill manifest Algorithm capability metadata", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmCapabilitiesReference(homeDir);
    await writeSkill(homeDir, "first-principles", "FirstPrinciples");
    await writeSkillManifest(homeDir, "first-principles", {
      schema: "soma.skill.v1",
      name: "FirstPrinciples",
      description: "Manifest-backed first principles skill.",
      source: { kind: "pai-pack", packName: "FirstPrinciples" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: ["manifest trigger"],
      substrates: ["codex", "pi-dev"],
      algorithmCapability: {
        kind: "skill",
        phases: ["verify"],
        triggerSignals: ["manifest signal"],
      },
    });

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });

    expect(registry.definitions.find((definition) => definition.name === "FirstPrinciples")).toMatchObject({
      name: "FirstPrinciples",
      kind: "skill",
      phases: ["verify"],
      triggerSignals: ["manifest signal"],
      invoke: { contract: "skill", target: "FirstPrinciples" },
    });
  });
});

test("derives manifest capability contract from kind", async () => {
  await withTempHome(async (homeDir) => {
    await writeSkill(homeDir, "delegate", "Delegate");
    await writeSkillManifest(homeDir, "delegate", {
      schema: "soma.skill.v1",
      name: "Delegate",
      description: "Agent-backed delegation skill.",
      source: { kind: "pai-pack", packName: "Delegate" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: ["delegate"],
      substrates: ["codex"],
      algorithmCapability: {
        kind: "agent",
        phases: ["execute"],
        triggerSignals: ["delegate"],
      },
    });

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });

    expect(registry.definitions.find((definition) => definition.name === "Delegate")).toMatchObject({
      name: "Delegate",
      kind: "agent",
      phases: ["execute"],
      invoke: { contract: "agent", target: "Delegate" },
    });
  });
});

test("treats explicitly invalid manifest capability phases as unsupported", async () => {
  await withTempHome(async (homeDir) => {
    await writeSkill(homeDir, "bad-phases", "BadPhases");
    await writeSkillManifest(homeDir, "bad-phases", {
      schema: "soma.skill.v1",
      name: "BadPhases",
      description: "Invalid phase metadata.",
      source: { kind: "pai-pack", packName: "BadPhases" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: ["bad phases"],
      substrates: ["codex"],
      algorithmCapability: {
        kind: "skill",
        phases: ["verfy"],
        triggerSignals: ["bad phases"],
      },
    });

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });

    expect(registry.definitions.some((definition) => definition.name === "BadPhases")).toBe(false);
    expect(registry.unsupported).toContain("BadPhases");
  });
});

test("falls back to loaded Soma skills when no Algorithm reference exists", async () => {
  await withTempHome(async (homeDir) => {
    await writeSkill(homeDir, "context-search", "ContextSearch");

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir });

    expect(registry.definitions.find((definition) => definition.name === "ContextSearch")).toMatchObject({
      name: "ContextSearch",
      kind: "skill",
      phases: ["observe", "think", "plan", "build", "execute", "verify", "learn"],
      invoke: { contract: "skill", target: "ContextSearch" },
    });
  });
});

test("filters manifest-declared Algorithm capabilities by substrate", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmCapabilitiesReference(homeDir);
    await writeSkill(homeDir, "pi-only", "PiOnly");
    await writeSkillManifest(homeDir, "pi-only", {
      schema: "soma.skill.v1",
      name: "PiOnly",
      description: "Pi-only skill.",
      source: { kind: "pai-pack", packName: "PiOnly" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: ["pi only"],
      substrates: ["pi-dev"],
      algorithmCapability: {
        kind: "skill",
        phases: ["think"],
        triggerSignals: ["pi only"],
      },
    });

    const codexRegistry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });
    const piRegistry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "pi-dev" });

    expect(codexRegistry.definitions.some((definition) => definition.name === "PiOnly")).toBe(false);
    expect(codexRegistry.unsupported).toContain("PiOnly");
    expect(piRegistry.definitions.find((definition) => definition.name === "PiOnly")).toMatchObject({
      name: "PiOnly",
      phases: ["think"],
    });
  });
});

test("migrated reference rows cannot re-register substrate-unsupported skills", async () => {
  await withTempHome(async (homeDir) => {
    const root = join(homeDir, ".soma", "skills", "the-algorithm", "references");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "capabilities.md"),
      [
        "# Algorithm Capabilities Reference",
        "",
        "| Capability | Phases | Trigger Signal | Invoke | Typical Cost |",
        "|------------|--------|----------------|--------|--------------|",
        '| PiOnly | THINK | Pi only | `Skill("PiOnly")` | E2+ |',
        '| WrapperCapability | THINK | Wraps PiOnly | `Skill("PiOnly")` | E2+ |',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeSkill(homeDir, "pi-only", "PiOnly");
    await writeSkillManifest(homeDir, "pi-only", {
      schema: "soma.skill.v1",
      name: "PiOnly",
      description: "Pi-only skill.",
      source: { kind: "pai-pack", packName: "PiOnly" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: ["pi only"],
      substrates: ["pi-dev"],
      algorithmCapability: {
        kind: "skill",
        phases: ["think"],
        triggerSignals: ["pi only"],
      },
    });

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });

    expect(registry.definitions.some((definition) => definition.name === "PiOnly")).toBe(false);
    expect(registry.definitions.some((definition) => definition.name === "WrapperCapability")).toBe(false);
    expect(registry.unsupported).toContain("PiOnly");
    expect(registry.unsupported).toContain("WrapperCapability");
  });
});

test("treats malformed manifest substrate metadata as unsupported without throwing", async () => {
  await withTempHome(async (homeDir) => {
    await writeSkill(homeDir, "broken", "BrokenSkill");
    await writeSkillManifest(homeDir, "broken", {
      schema: "soma.skill.v1",
      name: "BrokenSkill",
      description: "Broken substrate metadata.",
      source: { kind: "pai-pack", packName: "BrokenSkill" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: ["broken"],
      substrates: "codex",
      algorithmCapability: {
        kind: "skill",
        phases: ["think"],
        triggerSignals: ["broken"],
      },
    });

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });

    expect(registry.definitions.some((definition) => definition.name === "BrokenSkill")).toBe(false);
    expect(registry.unsupported).toContain("BrokenSkill");
  });
});

test("ignores malformed manifest trigger metadata without throwing", async () => {
  await withTempHome(async (homeDir) => {
    await writeSkill(homeDir, "broken-triggers", "BrokenTriggers");
    await writeSkillManifest(homeDir, "broken-triggers", {
      schema: "soma.skill.v1",
      name: "BrokenTriggers",
      description: "Broken trigger metadata.",
      source: { kind: "pai-pack", packName: "BrokenTriggers" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: "not-an-array",
      substrates: ["codex"],
      algorithmCapability: {
        kind: "skill",
        phases: ["think"],
        triggerSignals: [123],
      },
    });

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });

    expect(registry.definitions.find((definition) => definition.name === "BrokenTriggers")).toMatchObject({
      name: "BrokenTriggers",
      phases: ["think"],
      triggerSignals: ["Broken trigger metadata."],
      invoke: { contract: "skill", target: "BrokenTriggers" },
    });
  });
});

test("empty manifest names fall back to SKILL name while preserving metadata", async () => {
  await withTempHome(async (homeDir) => {
    await writeSkill(homeDir, "empty-name", "FallbackName");
    await writeSkillManifest(homeDir, "empty-name", {
      schema: "soma.skill.v1",
      name: "",
      description: "Invalid empty manifest name.",
      source: { kind: "pai-pack", packName: "FallbackName" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: ["invalid"],
      substrates: ["codex"],
      algorithmCapability: {
        kind: "skill",
        phases: ["think"],
        triggerSignals: ["invalid"],
      },
    });

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });

    expect(registry.definitions.find((definition) => definition.name === "FallbackName")).toMatchObject({
      name: "FallbackName",
      phases: ["think"],
      triggerSignals: ["invalid"],
      invoke: { contract: "skill", target: "FallbackName" },
    });
    expect(registry.definitions.some((definition) => definition.name === "")).toBe(false);
  });
});

test("empty manifest names still preserve substrate filtering", async () => {
  await withTempHome(async (homeDir) => {
    await writeSkill(homeDir, "empty-pi-only", "EmptyPiOnly");
    await writeSkillManifest(homeDir, "empty-pi-only", {
      schema: "soma.skill.v1",
      name: "",
      description: "Pi-only manifest with invalid name.",
      source: { kind: "pai-pack", packName: "EmptyPiOnly" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: ["pi only"],
      substrates: ["pi-dev"],
      algorithmCapability: {
        kind: "skill",
        phases: ["think"],
        triggerSignals: ["pi only"],
      },
    });

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });

    expect(registry.definitions.some((definition) => definition.name === "EmptyPiOnly")).toBe(false);
    expect(registry.unsupported).toContain("EmptyPiOnly");
  });
});

test("treats non-object manifest capability metadata as absent", async () => {
  await withTempHome(async (homeDir) => {
    await writeSkill(homeDir, "bad-capability-shape", "BadCapabilityShape");
    await writeSkillManifest(homeDir, "bad-capability-shape", {
      schema: "soma.skill.v1",
      name: "BadCapabilityShape",
      description: "Malformed capability metadata.",
      source: { kind: "pai-pack", packName: "BadCapabilityShape" },
      entrypoint: "SKILL.md",
      references: [],
      workflows: [],
      tools: [],
      triggers: ["fallback trigger"],
      substrates: ["codex"],
      algorithmCapability: "bad",
    });

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, substrate: "codex" });

    expect(registry.definitions.find((definition) => definition.name === "BadCapabilityShape")).toMatchObject({
      name: "BadCapabilityShape",
      kind: "skill",
      phases: ["observe", "think", "plan", "build", "execute", "verify", "learn"],
      triggerSignals: ["fallback trigger"],
      invoke: { contract: "skill", target: "BadCapabilityShape" },
    });
  });
});

test("resolves relative Soma home capability paths under homeDir", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmCapabilitiesReference(homeDir, "runtime-soma");
    await writeSkill(homeDir, "first-principles", "FirstPrinciples", "runtime-soma");

    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({ homeDir, somaHome: "runtime-soma" });

    expect(registry.definitions.find((definition) => definition.name === "FirstPrinciples")).toMatchObject({
      kind: "skill",
      invoke: { contract: "skill", target: "FirstPrinciples" },
    });
  });
});

test("rejects phantom Algorithm capabilities", () => {
  const run = createAlgorithmRun({
    id: "phantom-capability",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Reject invented capability",
    intent: "Keep capability names portable.",
    currentState: "Names could drift.",
    goal: "Only registry names are accepted.",
    criteria: [{ id: "C1", text: "Unknown names fail." }],
  });

  expect(() => selectAlgorithmCapability(run, { name: "MadeUpCapability" })).toThrow("not registered");
});

test("rejects Algorithm capabilities selected for unsupported phases", () => {
  let run = createAlgorithmRun({
    id: "wrong-capability-phase",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Reject wrong phase",
    intent: "Keep capability contracts meaningful.",
    currentState: "Phase can be supplied by callers.",
    goal: "Selection honors registered phases.",
    criteria: [{ id: "C1", text: "Unsupported phases fail." }],
  });
  run = registerFirstPrinciples(run);

  expect(() => selectAlgorithmCapability(run, { name: "FirstPrinciples", phase: "complete" })).toThrow("cannot be selected for complete");
});

test("registers adapter-provided Algorithm skill capabilities", () => {
  let run = createAlgorithmRun({
    id: "adapter-capability",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Use adapter capability",
    intent: "Allow adapter startup registration.",
    currentState: "Registry is in core.",
    goal: "Adapter capability can be selected.",
    criteria: [{ id: "C1", text: "Registered adapter capability selects." }],
  });
  run = registerAlgorithmCapabilityDefinition(
    run,
    {
      name: "FirstPrinciples",
      kind: "skill",
      phases: ["think", "plan"],
      triggerSignals: ["assumption", "root cause", "fundamentals", "first principles"],
      invoke: { contract: "skill", target: "FirstPrinciples" },
    },
    "2026-05-21T10:01:00.000Z",
  );

  run = selectAlgorithmCapability(
    run,
    { name: "FirstPrinciples", phase: "think", reason: "Registered by adapter startup." },
    "2026-05-21T10:02:00.000Z",
  );

  expect(run.capabilityDefinitions?.[0]?.name).toBe("FirstPrinciples");
  expect(run.capabilitySelections?.[0]).toMatchObject({
    name: "FirstPrinciples",
    status: "selected",
  });
});

test("rejects malformed adapter capability definitions", () => {
  const run = createAlgorithmRun({
    id: "malformed-adapter-capability",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Reject malformed capability",
    intent: "Validate adapter registrations before cloning.",
    currentState: "Adapter definition is malformed.",
    goal: "Registration fails with a domain error.",
    criteria: [{ id: "C1", text: "Malformed registration is rejected." }],
  });

  expect(() =>
    registerAlgorithmCapabilityDefinition(run, {
      name: "MalformedCapability",
      kind: "adapter",
      phases: ["think"],
      invoke: { contract: "adapter", target: "adapter.malformed" },
    } as Parameters<typeof registerAlgorithmCapabilityDefinition>[1]),
  ).toThrow("triggerSignals");
});

test("removes stale adapter capability selections without current definitions", () => {
  let run = createAlgorithmRun({
    id: "stale-adapter-capability",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Remove stale adapter selection",
    intent: "Unblock completion after registry drift.",
    currentState: "Adapter definition is not registered in this process.",
    goal: "Stored selection can still be removed.",
    criteria: [{ id: "C1", text: "Removal does not require current definition." }],
  });
  run = {
    ...run,
    capabilitySelections: [
      {
        name: "AdapterOnlyCapability",
        phase: "think",
        reason: "Selected in a previous adapter process.",
        status: "selected",
        selectedAt: "2026-05-21T10:01:00.000Z",
      },
    ],
  };

  run = removeAlgorithmCapabilitySelection(run, { name: "AdapterOnlyCapability", reason: "Adapter is not available now." });

  expect(run.capabilitySelections?.[0]).toMatchObject({
    name: "AdapterOnlyCapability",
    status: "removed",
  });
});

test("reselecting an invoked capability creates a fresh unresolved commitment", () => {
  let run = createAlgorithmRun({
    id: "reselected-capability",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Reselect capability",
    intent: "Avoid stale invocation reuse.",
    currentState: "Capability was invoked for an earlier reason.",
    goal: "New reason requires new evidence.",
    criteria: [{ id: "C1", text: "Reselection is unresolved." }],
  });
  run = registerFirstPrinciples(run);
  run = selectAlgorithmCapability(run, { name: "FirstPrinciples", phase: "think", reason: "Initial decomposition." });
  run = recordAlgorithmCapabilityInvocation(run, { name: "FirstPrinciples", evidence: "Initial invocation." });

  run = selectAlgorithmCapability(run, { name: "FirstPrinciples", phase: "plan", reason: "New planning decomposition." });

  expect(run.capabilitySelections).toHaveLength(2);
  expect(run.capabilitySelections?.[1]).toMatchObject({
    name: "FirstPrinciples",
    phase: "plan",
    reason: "New planning decomposition.",
    status: "selected",
  });
});

test("reselecting an unchanged invoked capability preserves invocation evidence", () => {
  let run = createAlgorithmRun({
    id: "idempotent-reselected-capability",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Reselect same capability",
    intent: "Keep idempotent selection safe.",
    currentState: "Capability was invoked.",
    goal: "Same selection preserves evidence.",
    criteria: [{ id: "C1", text: "Invocation evidence remains." }],
  });
  run = registerFirstPrinciples(run);
  run = selectAlgorithmCapability(run, { name: "FirstPrinciples", phase: "think", reason: "Initial decomposition." });
  run = recordAlgorithmCapabilityInvocation(run, { name: "FirstPrinciples", evidence: "Initial invocation." });

  run = selectAlgorithmCapability(run, { name: "FirstPrinciples", phase: "think", reason: "Initial decomposition." });

  expect(run.capabilitySelections).toHaveLength(1);
  expect(run.capabilitySelections?.[0]).toMatchObject({
    status: "invoked",
    invocation: { evidence: "Initial invocation." },
  });
});

test("removed Algorithm capabilities do not block completion", () => {
  let run = createAlgorithmRun({
    id: "removed-capability",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Remove unnecessary capability",
    intent: "Allow explicit de-selection.",
    currentState: "Capability was selected too early.",
    goal: "Completion is not blocked after removal.",
    criteria: [{ id: "C1", text: "Removal records reason." }],
  });

  run = selectAlgorithmCapability(run, { name: "ReReadCheck", phase: "verify", reason: "Initial verification concern." });
  run = removeAlgorithmCapabilitySelection(run, { name: "ReReadCheck", reason: "Covered by a narrower manual check." });

  expect(run.capabilitySelections?.[0]).toMatchObject({
    status: "removed",
    removalReason: "Covered by a narrower manual check.",
  });
});

test("applies Algorithm batch operations with one timestamp", () => {
  let run = createAlgorithmRun({
    id: "batch-timestamp",
    timestamp: "2026-05-21T10:00:00.000Z",
    prompt: "Batch timestamps",
    intent: "Keep batch mutations coherent.",
    currentState: "Batch operations can touch several capability fields.",
    goal: "Batch mutation timestamps are consistent.",
    criteria: [{ id: "C1", text: "Capability selection and invocation share a timestamp." }],
  });
  run = advanceAlgorithmRun(run, "2026-05-21T10:01:00.000Z");

  run = applyAlgorithmBatch(
    run,
    [
      { kind: "capability", capability: "sequential-analysis" },
      { kind: "capability-invocation", capability: "sequential-analysis", evidence: "Batch invocation evidence." },
    ],
    "2026-05-21T10:02:00.000Z",
  );

  expect(run.updatedAt).toBe("2026-05-21T10:02:00.000Z");
  expect(run.capabilitySelections?.[0]?.selectedAt).toBe("2026-05-21T10:02:00.000Z");
  expect(run.capabilitySelections?.[0]?.invocation?.timestamp).toBe("2026-05-21T10:02:00.000Z");
});

test("records per-hop substrate provenance for Algorithm mutations", () => {
  let run = createAlgorithmRun({
    id: "provenance-run",
    substrate: "claude-code",
    prompt: "Track cross-substrate provenance.",
    intent: "Track cross-substrate provenance.",
    currentState: "Run is new.",
    goal: "Run records substrate hops.",
    criteria: [{ id: "C1", text: "Criterion is verified." }],
    timestamp: "2026-05-14T10:00:00.000Z",
  });

  run = advanceAlgorithmRun(run, "2026-05-14T10:01:00.000Z", { substrate: "codex" });
  run = verifyAlgorithmCriterion(
    run,
    "C1",
    "passed",
    "Codex verified the criterion.",
    "2026-05-14T10:02:00.000Z",
    { substrate: "codex" },
  );
  run = recordAlgorithmLearning(run, "Pi.dev captured the lesson.", "2026-05-14T10:03:00.000Z", {
    substrate: "pi-dev",
  });

  expect(run.provenance).toEqual([
    {
      timestamp: "2026-05-14T10:00:00.000Z",
      phase: "observe",
      operation: "run.created",
      substrate: "claude-code",
    },
    {
      timestamp: "2026-05-14T10:01:00.000Z",
      phase: "think",
      operation: "phase.advance",
      substrate: "codex",
    },
    {
      timestamp: "2026-05-14T10:02:00.000Z",
      phase: "think",
      operation: "criterion.verify",
      substrate: "codex",
      detail: "C1",
    },
    {
      timestamp: "2026-05-14T10:03:00.000Z",
      phase: "think",
      operation: "learning.record",
      substrate: "pi-dev",
    },
  ]);
});

test("abandoned runs cannot advance", async () => {
  const { abandonAlgorithmRun } = await import("../src/index");
  const run = createAlgorithmRun({
    id: "abandoned-test",
    timestamp: "2026-05-16T10:00:00.000Z",
    prompt: "Test abandonment",
    intent: "Verify terminal state",
    currentState: "Run starts fresh",
    goal: "Run cannot advance after abandonment",
    criteria: [{ id: "C1", text: "Abandonment is terminal" }],
  });
  const abandoned = abandonAlgorithmRun(run, "intentional test abort", "2026-05-16T10:01:00.000Z");
  expect(getRunPhase(abandoned)).toBe("abandoned");
  expect(() => advanceAlgorithmRun(abandoned)).toThrow("abandoned");
});

test("persists Algorithm runs under Soma WORK memory", async () => {
  await withTempHome(async (homeDir) => {
    const run = createAlgorithmRun({
      id: "stored-run",
      prompt: "Store this run",
      intent: "Persist deterministic work state.",
      currentState: "No persisted run.",
      goal: "Run is stored in Soma memory.",
      criteria: [{ id: "C1", text: "JSON file exists." }],
    });
    const written = await writeAlgorithmRun(run, { homeDir });

    expect(written.path).toBe(join(homeDir, ".soma/memory/WORK/algorithm-runs/stored-run.json"));
    await expect(readFile(written.path, "utf8")).resolves.toContain('"phase": "observe"');
  });
});
