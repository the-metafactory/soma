import { homedir } from "node:os";
import { resolve } from "node:path";
import { installSpecFor } from "../../install-spec-registry";
import { registerProjectionRepairProvider } from "../../lifecycle";
import { SOMA_CLAUDE_STATUSLINE_RELATIVE_PATH, renderClaudeCodeStatusLineScript } from "./hooks";
import type { ProjectedArtifact } from "../../projection-self-repair";

/**
 * Claude Code's projection self-repair surface (soma#460): the projected
 * artifacts worth a session-start repair sweep.
 *
 * Only the statusline qualifies today. It is the ONE claude-code projection the
 * substrate execs DIRECTLY via its shebang (`settings.json` `statusLine.command`
 * = the script path), so a lost exec bit silently collapses the status line —
 * exactly the fragility class this feature targets. It is also a pure function
 * of `somaHome` (the value is baked in at projection time with no timestamp), so
 * a fresh render is a sound checksum oracle for drift.
 *
 * The other soma hooks are bun-invoked (`bunPath <script>`), so their exec bit
 * is irrelevant, and they carry machine-specific config (bunPath), making them
 * poor drift oracles — out of scope for this slice.
 */
export function claudeCodeProjectionRepairArtifacts(input: {
  substrateHome: string;
  somaHome: string;
}): ProjectedArtifact[] {
  return [
    {
      path: resolve(input.substrateHome, SOMA_CLAUDE_STATUSLINE_RELATIVE_PATH),
      directExec: true,
      expected: renderClaudeCodeStatusLineScript(input.somaHome),
    },
  ];
}

/**
 * Register claude-code's projection self-repair provider (soma#460). The core
 * SessionStart step looks this up by substrate, so core imports no adapter (the
 * same dependency inversion as the SessionEnd transcript handler). Loaded for
 * its side effect via `src/cli/lifecycle.ts`.
 */
registerProjectionRepairProvider("claude-code", ({ homeDir, somaHome }) => {
  const substrateHome = resolve(homeDir ?? homedir(), installSpecFor("claude-code").defaultHome);
  return { substrateHome, artifacts: claudeCodeProjectionRepairArtifacts({ substrateHome, somaHome }) };
});
