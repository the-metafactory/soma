// Leaf module: constants shared by adapter.ts (renderers) and install.ts
// (install spec, uninstall markers). Importing them from adapter.ts gave
// install.ts a value-level import cycle through the install-spec registry
// (adapter -> projection-private-roots -> install-spec-registry -> install
// -> adapter), the suspected root of the registry TDZ that forces grok
// suites to run as a batch. Keep this module dependency-free.

/**
 * Where the session-start hook projects the generated startup context,
 * relative to the Grok home. Lives inside `skills/soma/` so Grok's skill
 * discovery surfaces it as a companion file and uninstall removes it with
 * the marker-guarded skill dir. Shared by the install spec
 * (`lifecycleProjection`) and the hook runtime config so the two can
 * never drift.
 */
export const GROK_STARTUP_CONTEXT_PATH = "skills/soma/startup-context.md";
export const GROK_SOMA_REPO_POINTER_PATH = "skills/soma/soma-repo.txt";

/**
 * Leading ownership markers for the native subagent surfaces
 * (`personas/soma.toml`, `roles/soma-algorithm.toml`, `agents/soma-explore.md`).
 * The renderers emit them on line one; the uninstall guard keys on them so
 * only Soma-projected files are ever removed from the shared dirs.
 */
export const GROK_PERSONA_MARKER = "Soma persona (projected by Soma)";
export const GROK_ROLE_MARKER = "Soma Algorithm role (projected by Soma)";
export const GROK_AGENT_MARKER = "Soma exploration agent (projected by Soma)";
