import { claudeCodeSessionId } from "./claude-code/session-env";
import type { SubstrateId } from "../../core/types";

type SessionEnv = Readonly<Record<string, string | undefined>>;

// Only substrates with a verified session environment primitive belong here.
// Codex and pi-dev currently provide none; never invent an ID for them.
const SESSION_RESOLVERS: Partial<Record<SubstrateId, (env: SessionEnv) => string | undefined>> = {
  "claude-code": claudeCodeSessionId,
};

/**
 * Project a substrate session into the kernel's neutral environment contract.
 * A known substrate reads only its own primitive, so a codex process that
 * inherits a Claude variable records no session. The scan over every resolver
 * is the fallback for an unknown substrate.
 */
export function resolveSubstrateSessionEnv(env: SessionEnv, substrate?: SubstrateId): SessionEnv {
  if (env.SOMA_SESSION_ID) return env;
  const resolvers = substrate === undefined ? Object.values(SESSION_RESOLVERS) : [SESSION_RESOLVERS[substrate]];
  for (const resolve of resolvers) {
    const sessionId = resolve?.(env);
    if (sessionId !== undefined) return { ...env, SOMA_SESSION_ID: sessionId };
  }
  return env;
}
