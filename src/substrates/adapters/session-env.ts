import { claudeCodeSessionId } from "./claude-code/session-env";
import type { SubstrateId } from "../../core/types";

type SessionEnv = Readonly<Record<string, string | undefined>>;

// Only substrates with a verified session environment primitive belong here.
// Codex and pi-dev currently provide none; never invent an ID for them.
const SESSION_RESOLVERS: Partial<Record<SubstrateId, (env: SessionEnv) => string | undefined>> = {
  "claude-code": claudeCodeSessionId,
};

/** Project a substrate session into the kernel's neutral environment contract. */
export function resolveSubstrateSessionEnv(env: SessionEnv): SessionEnv {
  if (env.SOMA_SESSION_ID) return env;
  for (const resolve of Object.values(SESSION_RESOLVERS)) {
    const sessionId = resolve(env);
    if (sessionId !== undefined) return { ...env, SOMA_SESSION_ID: sessionId };
  }
  return env;
}
