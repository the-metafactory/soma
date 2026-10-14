/** Claude Code's session primitive, resolved only at the adapter boundary. */
export function claudeCodeSessionId(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  return sessionId === "" ? undefined : sessionId;
}
