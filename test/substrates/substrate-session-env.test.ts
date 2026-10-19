import { expect, test } from "bun:test";
import { resolveSubstrateSessionEnv } from "../../src/substrates/adapters/session-env";

test("session resolution projects Claude Code without mutating the injected environment", () => {
  const env = { CLAUDE_CODE_SESSION_ID: "S1", MF_CORRELATION_ID: "explicit" };
  expect(resolveSubstrateSessionEnv(env)).toEqual({ ...env, SOMA_SESSION_ID: "S1" });
  expect(env).not.toHaveProperty("SOMA_SESSION_ID");
});

test("neutral session wins and unsupported or empty primitives invent no session", () => {
  const neutral = { SOMA_SESSION_ID: "neutral", CLAUDE_CODE_SESSION_ID: "native" };
  expect(resolveSubstrateSessionEnv(neutral)).toBe(neutral);
  for (const env of [{}, { SOMA_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" }, { CODEX_SESSION_ID: "unknown" }]) {
    expect(resolveSubstrateSessionEnv(env)).toBe(env);
  }
  expect(resolveSubstrateSessionEnv({ SOMA_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "S1" }).SOMA_SESSION_ID).toBe("S1");
});

test("a known substrate reads only its own primitive", () => {
  const env = { CLAUDE_CODE_SESSION_ID: "S1" };
  expect(resolveSubstrateSessionEnv(env, "claude-code")).toEqual({ ...env, SOMA_SESSION_ID: "S1" });
  for (const substrate of ["codex", "pi-dev"] as const) {
    expect(resolveSubstrateSessionEnv(env, substrate)).toBe(env);
  }
});
