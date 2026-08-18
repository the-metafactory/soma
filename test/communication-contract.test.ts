import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  ReservedReferenceLetterError,
  isReservedReferenceLetter,
  parseCommunicationContract,
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
  profile: { ...portableProjectionInput.profile, communication: parseCommunicationContract(CONTRACT) },
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

  // learning-pi-dev-generated-code-guards: this adapter emits TypeScript as
  // string literals, so a toContain assertion passes on syntactically broken
  // output. Transpiling is the only check that proves the extension loads.
  new Bun.Transpiler({ loader: "ts" }).transformSync(extension?.content ?? "");
});

test("C and P stay reserved for the Algorithm's own code space", () => {
  expect(Object.keys(RESERVED_REFERENCE_LETTERS).sort()).toEqual(["C", "P"]);
  expect(isReservedReferenceLetter("C")).toBe(true);
  expect(isReservedReferenceLetter("p")).toBe(true);
  expect(isReservedReferenceLetter("F")).toBe(false);

  // A reserved letter throws rather than being skipped: silently dropping it
  // would leave the principal believing `C` was adopted.
  expect(() => parseCommunicationContract("## Reference codes\n\n- C: criteria\n")).toThrow(
    ReservedReferenceLetterError,
  );
  expect(() => parseCommunicationContract("## Reference codes\n\n- P: phases\n")).toThrow(
    ReservedReferenceLetterError,
  );
});

test("reference codes and aliases parse out of the authored markdown", () => {
  const parsed = parseCommunicationContract(CONTRACT);

  expect(parsed.referenceCodes.map((code) => code.letter)).toEqual(["F", "O", "D"]);
  expect(parsed.referenceCodes[0].label).toBe("findings");
  expect(parsed.aliases.map((alias) => alias.token)).toEqual(["scr", "foc"]);
  expect(parsed.aliases[0].expansion).toBe("Simplify, compress, and repeat your response.");
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
    const parsed = parseCommunicationContract(starter);

    expect(parsed.referenceCodes.map((code) => code.letter)).toEqual(["F", "O", "R", "Q", "A", "D"]);
    expect(parsed.aliases.map((alias) => alias.token)).toEqual(["scr", "eli", "foc", "ref"]);
    // The starter is a public template: no principal-specific voice in it.
    expect(starter).not.toContain("Jens-Christian");

    const loaded = await loadSomaHome(somaHome);
    expect(loaded.profile.communication?.content).toBe(starter);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
