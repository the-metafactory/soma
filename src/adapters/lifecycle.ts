// Lifecycle wiring the CLI composes, kept in the adapter layer so the CLI never
// deep-imports substrate internals (eslint.config.js adapter boundary).
//
// Importing this module registers the Claude Code and Codex SessionEnd
// transcript-digest handlers with core lifecycle (dependency inversion — core
// never imports the adapters). It is deliberately NOT re-exported from the
// `./adapters` barrel: registration happens only where this module is imported.
import "./claude-code/session-digest";
import "./codex/session-digest";

export { resolveInstalledLifecycleHomeDir } from "./shared/lifecycle-home-binding";
