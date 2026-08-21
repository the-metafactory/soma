import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapSomaHome,
  loadSomaHome,
  projectClaudeCode,
  projectClaudeCodeHome,
  projectCodex,
  projectCodexHome,
  projectCursor,
  projectDsh,
  projectDshHome,
  projectGrok,
  projectGrokHome,
  projectPiDev,
  projectPiDevHome,
  type Projection,
  type ProjectionInput,
} from "../src/index";
import { projectAnthropicCoworkHome } from "../src/adapters/anthropic-cowork";
import {
  DECISION_REFERENCE_LETTER,
  RESERVED_REFERENCE_LETTERS,
  isReservedReferenceLetter,
  parseReferenceCode,
} from "../src/communication-contract";
import { portableProjectionInput } from "./fixtures";

const CONTRACT = `# Communication Contract

## Positive patterns

- State each fact once.

## Reference codes

- F: findings
- O: options
- D: decisions

## Aliases

- scr: Simplify, compress, and repeat your response.
- foc: Focus on what matters most here.
`;

const withContract: ProjectionInput = {
  ...portableProjectionInput,
  profile: { ...portableProjectionInput.profile, communication: { content: CONTRACT } },
};

const withoutContract: ProjectionInput = {
  ...portableProjectionInput,
  profile: { ...portableProjectionInput.profile, communication: undefined },
};

/** Every substrate surface that projects the contract, with its native path. */
function contractFiles(input: ProjectionInput): { name: string; file?: { path: string; content: string } }[] {
  const pick = (name: string, projection: Projection, path: string) => ({
    name,
    file: projection.files.find((candidate) => candidate.path === path),
  });
  return [
    pick("claude-code (workspace)", projectClaudeCode(input), ".claude/soma/communication.md"),
    pick("claude-code (home)", projectClaudeCodeHome(input), "rules/soma/COMMUNICATION.md"),
    pick("cursor", projectCursor(input), ".cursor/rules/soma/COMMUNICATION.md"),
    pick("anthropic-cowork", projectAnthropicCoworkHome(input), "soma/communication.md"),
    pick("pi-dev (workspace)", projectPiDev(input), ".pi/extensions/soma-core/communication.md"),
    pick("pi-dev (home)", projectPiDevHome(input, "/tmp/soma-home"), "agent/soma/communication.md"),
    pick("codex (workspace)", projectCodex(input), ".codex/soma/communication.md"),
    pick("codex (home)", projectCodexHome(input, "/tmp/soma-home"), "memories/soma/communication.md"),
    pick("grok (workspace)", projectGrok(input), ".grok/rules/soma/communication.md"),
    pick("grok (home)", projectGrokHome(input, "/tmp/soma-home"), "skills/soma/communication.md"),
    pick("dsh (workspace)", projectDsh(input), ".dsh/soma/communication.md"),
    pick("dsh (home)", projectDshHome(input, "/tmp/soma-home"), "skills/soma/communication.md"),
  ];
}

test("every substrate projects the contract, byte-identical to the source", () => {
  for (const { name, file } of contractFiles(withContract)) {
    expect(file, `${name} did not project the contract`).toBeDefined();
    // Verbatim is the contract: a renderer round-trip is how authored nuance dies.
    expect(file?.content, `${name} re-rendered the contract instead of projecting it`).toBe(CONTRACT);
  }
});

test("a home with no contract projects no contract file", () => {
  for (const { name, file } of contractFiles(withoutContract)) {
    expect(file, `${name} projected a contract file with no source`).toBeUndefined();
  }
});

test("pi-dev appends the contract to the system prompt, and the extension still parses", () => {
  const extension = projectPiDevHome(withContract, "/tmp/soma-home").files.find(
    (file) => file.path === "agent/extensions/soma.ts",
  );
  expect(extension).toBeDefined();

  // Pi's native equivalent of --append-system-prompt-file: the contract has to
  // be on every turn, so the generated extension reads it into the prompt.
  expect(extension?.content).toContain("cachedCommunication ??= readOptional(`${PI_SOMA_HOME}/communication.md`)");
  expect(extension?.content).toContain("${communication}");

  // sage #636 r1: the contract is static for a session, so it must NOT add a
  // synchronous file read to the message path — the per-prompt handler calls
  // the cached accessor, and session_start warms it.
  const messagePath = (extension?.content ?? "").slice(
    (extension?.content ?? "").indexOf('pi.on("before_agent_start"'),
    (extension?.content ?? "").indexOf("const somaPrompt"),
  );
  expect(messagePath).toContain("const communication = communicationContract();");
  // The message path calls the cached accessor rather than reading directly.
  // sage #636 r9: this is a string check on a slice, not proof no read happens —
  // a cold cache still reads once inside the accessor. The guarantee is one read
  // per session, not zero, and the comment above the generated code says so.
  expect(messagePath).not.toContain("readOptional(`${PI_SOMA_HOME}/communication.md`)");
  // `undefined` is the empty sentinel, not "": a home with no contract yields
  // "", and an `||` fallback would re-read the missing file every turn.
  expect(extension?.content).toContain("let cachedCommunication: string | undefined;");
  // sage #636 r2: the cache is SESSION-scoped, which only holds if session_start
  // clears it. A module cache that merely warmed would never see a reproject.
  expect(extension?.content).toContain("cachedCommunication = undefined;");

  // learning-pi-dev-generated-code-guards: this adapter emits TypeScript as
  // string literals, so a toContain assertion passes on syntactically broken
  // output. Transpiling proves the emitted source PARSES — which is exactly the
  // failure that shipped twice (soma#402, PR #476). It says nothing about
  // imports resolving or the pi API being used correctly; only a live Pi
  // session shows that, and this suite cannot run one.
  new Bun.Transpiler({ loader: "ts" }).transformSync(extension?.content ?? "");
});

test("C and P stay reserved for the Algorithm's own code space", () => {
  expect(Object.keys(RESERVED_REFERENCE_LETTERS).sort()).toEqual(["C", "P"]);
  expect(isReservedReferenceLetter("C")).toBe(true);
  expect(isReservedReferenceLetter("p")).toBe(true);
  expect(isReservedReferenceLetter("F")).toBe(false);
});

test("a reserved letter in the contract cannot break loading the home", async () => {
  // sage #636 r3: an earlier revision parsed and validated the contract, so a
  // principal typing `- C: criteria` into a prose file threw out of
  // loadSomaHome and failed EVERY command that loads the home — install,
  // reproject, hooks. The contract projects verbatim; nothing is parsed, so a
  // content typo cannot brick the load path.
  const root = await mkdtemp(join(tmpdir(), "soma-reserved-"));
  try {
    const somaHome = join(root, ".soma");
    await bootstrapSomaHome({ somaHome });
    await writeFile(
      join(somaHome, "profile", "communication.md"),
      "# Communication Contract\n\n## Reference codes\n\n- C: criteria\n",
      "utf8",
    );

    const loaded = await loadSomaHome(somaHome);
    expect(loaded.profile.communication?.content).toContain("- C: criteria");
    // ...and it still reaches the substrate verbatim, reserved letter and all.
    expect(
      projectClaudeCodeHome(loaded).files.find((file) => file.path === "rules/soma/COMMUNICATION.md")?.content,
    ).toContain("- C: criteria");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  // The rule is enforced where a collision can actually occur: the write path.
  expect(DECISION_REFERENCE_LETTER).toBe("D");
});

test("reference codes split into letter and ordinal, and reject non-codes", () => {
  expect(parseReferenceCode("F1")).toEqual({ letter: "F", ordinal: 1 });
  expect(parseReferenceCode(" d12 ")).toEqual({ letter: "D", ordinal: 12 });
  expect(parseReferenceCode("F0")).toBeUndefined();
  expect(parseReferenceCode("FF1")).toBeUndefined();
  expect(parseReferenceCode("1F")).toBeUndefined();
  expect(parseReferenceCode("F")).toBeUndefined();
});

test("soma init ships a starter that declares the code families and names the reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "soma-contract-"));
  try {
    const somaHome = join(root, ".soma");
    await bootstrapSomaHome({ somaHome });

    const starter = await readFile(join(somaHome, "profile", "communication.md"), "utf8");

    for (const letter of ["F", "O", "R", "Q", "A", "D"]) {
      expect(starter).toContain(`- ${letter}: `);
    }
    expect(starter).toContain("- scr: Simplify, compress, and repeat your response.");
    // The starter is a public template (AGENTS.md public/private boundary): no
    // principal-specific voice in it.
    expect(starter).not.toContain("Jens");
    // sage #636 r3 blocker: this text projects verbatim to ten surfaces, so a
    // claim in it about Soma's own parsing reaches every principal and model.
    // Soma parses nothing out of the contract — the text must not say it does.
    expect(starter).not.toContain("parses only");
    expect(starter).toContain("Soma parses nothing out");
    // sage #636 r4: attribution belongs in the SHIPPED artifact. A JSDoc comment
    // and a CHANGELOG entry do not travel with the projected file, so anyone
    // reading the contract on a substrate would have no way to recover it.
    expect(starter).toContain("Structure adapted from disler/fixing-smartass-opus-5 (MIT).");
    // sage #636 r6: the old name claimed this test covered the C/P reservation
    // while nothing read that paragraph. The starter must tell the principal
    // which letters are taken and why, since Soma refuses them at the write
    // path and the refusal would otherwise arrive as a surprise.
    expect(starter).toContain("`C` and `P` are reserved by the Algorithm");
    // sage #636 r7 blocker: the starter used to assert that a chat-typed
    // `keep D1` records a decision. Nothing binds it — `ref`/`resolve` both
    // require an explicit --id and there is no active-run resolution — and this
    // text reaches every model on every turn, so it must not promise a
    // mechanism that does not exist.
    expect(starter).not.toContain("keep D1` records a decision");
    expect(starter).toContain("There is no implicit active run");
    expect(starter).toContain("soma algorithm ref --id");
    for (const reserved of Object.keys(RESERVED_REFERENCE_LETTERS)) {
      expect(starter).not.toContain(`- ${reserved}: `);
    }

    const loaded = await loadSomaHome(somaHome);
    expect(loaded.profile.communication?.content).toBe(starter);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every substrate is told to read the contract, not just handed the file", () => {
  // sage #636 r7: the contract projected to ten surfaces while the files that
  // tell each substrate what to read never mentioned it. On surfaces that are
  // not auto-discovered that reproduces the unwired-file failure this whole
  // change exists to fix — a projected file nothing is instructed to open.
  const instructionSurfaces: { name: string; text: string }[] = [
    { name: "claude-code (CLAUDE.md)", text: text(projectClaudeCode(withContract), "CLAUDE.md") },
    { name: "claude-code (rules README)", text: text(projectClaudeCodeHome(withContract), "rules/soma/README.md") },
    { name: "cursor (.cursorrules)", text: text(projectCursor(withContract), ".cursorrules") },
    { name: "cursor (rules README)", text: text(projectCursor(withContract), ".cursor/rules/soma/README.md") },
    { name: "anthropic-cowork (SOMA.md)", text: text(projectAnthropicCoworkHome(withContract), "SOMA.md") },
    { name: "anthropic-cowork (README)", text: text(projectAnthropicCoworkHome(withContract), "soma/README.md") },
    { name: "codex (home SKILL.md)", text: text(projectCodexHome(withContract, "/tmp/soma-home"), "skills/soma/SKILL.md") },
    { name: "grok (home SKILL.md)", text: text(projectGrokHome(withContract, "/tmp/soma-home"), "skills/soma/SKILL.md") },
    { name: "grok (rules README)", text: text(projectGrok(withContract), ".grok/rules/soma/README.md") },
    // Workspace overlays have no extension or auto-discovery to fall back on,
    // so an unnamed file there is exactly the unwired-file case. r8 added
    // pi-dev; r9 caught that codex and grok workspaces were still missing.
    { name: "pi-dev (workspace context)", text: text(projectPiDev(withContract), ".pi/extensions/soma-core/context.md") },
    { name: "codex (workspace context)", text: text(projectCodex(withContract), ".codex/soma/context.md") },
    { name: "grok (workspace context)", text: text(projectGrok(withContract), ".grok/rules/soma/context.md") },
    { name: "dsh (home SKILL.md)", text: text(projectDshHome(withContract, "/tmp/soma-home"), "skills/soma/SKILL.md") },
    { name: "dsh (workspace context)", text: text(projectDsh(withContract), ".dsh/soma/context.md") },
  ];

  // Every surface that PROJECTS the contract must appear above. Enumerating the
  // guard by hand is what let pi-dev, then codex and grok, slip through it —
  // the list is now derived from the projection itself, so a new surface fails
  // here until someone tells its substrate to read the file.
  const projecting = contractFiles(withContract)
    .filter((entry) => entry.file !== undefined)
    .map((entry) => entry.name.replace(/ \(.*/, ""));
  for (const substrate of new Set(projecting)) {
    expect(
      instructionSurfaces.some((surface) => surface.name.startsWith(substrate)),
      `${substrate} projects the contract but no instruction surface is checked for it`,
    ).toBe(true);
  }

  for (const { name, text: content } of instructionSurfaces) {
    expect(content, `${name} projected no instruction file`).not.toBe("");
    expect(content.toLowerCase(), `${name} never names the communication contract`).toContain("communication");
  }

  // pi-dev's HOME projection needs no instruction: the generated extension puts
  // the contract in the system prompt itself, which is stronger than telling a
  // reader to open a file. Asserted here so the omission stays deliberate.
  const extension = text(projectPiDevHome(withContract, "/tmp/soma-home"), "agent/extensions/soma.ts");
  expect(extension).toContain("const communication = communicationContract();");
});

function text(projection: Projection, path: string): string {
  return projection.files.find((file) => file.path === path)?.content ?? "";
}
