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
  expect(messagePath).not.toContain("communication.md");
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

test("soma init ships a starter contract that parses and reserves C/P", async () => {
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

    const loaded = await loadSomaHome(somaHome);
    expect(loaded.profile.communication?.content).toBe(starter);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
