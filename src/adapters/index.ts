export { projectClaudeCode, projectClaudeCodeHome, claudeCodeAdapter } from "./claude-code";
export { projectCodex, projectCodexHome, codexAdapter } from "./codex";
export { projectPiDev, projectPiDevHome, piDevAdapter } from "./pi-dev";
// NOTE: #43 Algorithm renderer pure-logic helpers (phase parser,
// widget helpers, extension-source renderer) are intentionally NOT
// re-exported at this level. They live behind `./pi-dev`'s barrel so
// the experimental surface stays scoped to the substrate adapter until
// AC-7..AC-12 settle the runtime shape in the follow-up PR (Sage
// Architecture important).
