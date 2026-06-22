import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SomaAdapter, Projection, ProjectionInput, SomaTask } from "../../types";
import { activeIsaBundleFile } from "../../adapter-active-isa";
import { resolveBunExecutable } from "../../bun-probe";
import { defaultInboundContentSecurityConfig } from "../../inbound-security";
import { somaPolicyPrivateMarkers } from "../../policy";
import { somaMemoryPrivateRoots, somaProjectionPrivateRoots } from "../../projection-private-roots";
import {
  GROK_AGENT_MARKER,
  GROK_PERSONA_MARKER,
  GROK_ROLE_MARKER,
  GROK_SOMA_REPO_POINTER_PATH,
  GROK_STARTUP_CONTEXT_PATH,
} from "./projection-constants";
import { defaultSomaRepoPath } from "../../repo-path";
import { rewriteSubstrateProjectionContent } from "../../substrate-projection-rewrites";
import { renderFeedbackHookModule } from "../shared/feedback-helper";
import {
  projectableSkills,
  renderAlgorithmRenderingContract,
  renderAssistantCore,
  renderMemoryLayout,
  renderPolicyProjection,
  renderSkills,
  renderSubstrateInstructions,
} from "../shared";
import { readGrokHookAsset } from "./hooks/assets";
import { GROK_PRE_TOOL_USE_VERB } from "./hooks/grok-hook-verbs.mjs";

/**
 * Resolve the user-level Grok home (`~/.grok`). `detect()` probes this
 * directory's existence: unlike Codex (`CODEX_HOME`) or Cursor
 * (`CURSOR_TRACE_ID`), Grok exposes no reliable marker env var, so the
 * installed `~/.grok/` tree is the signal. The `homeDir` override keeps
 * `detect()` testable against a temporary home.
 */
export function grokHomeDir(homeDir?: string): string {
  // Resolve the home dir from live env (matching `homedir()`'s own platform
  // rules: USERPROFILE on win32, HOME on POSIX) rather than calling
  // `homedir()` directly. Some runtimes cache `homedir()` at startup, so a
  // test (or caller) that sets HOME/USERPROFILE wouldn't be reflected; reading
  // the env at call time keeps `detect()` honest and testable.
  const base =
    homeDir ??
    (process.platform === "win32"
      ? process.env.USERPROFILE ?? homedir()
      : process.env.HOME ?? homedir());
  return resolve(base, ".grok");
}

/**
 * PostToolUse matcher for the algorithm-updated refresh. Grok matchers
 * are ANCHORED full-match regexes over the runtime tool names, and the
 * runtime names are Claude-style PascalCase — both verified live on
 * 2026-06-10 (grok 0.2.38 enumeration probe: Shell, Read, Write,
 * StrReplace, Grep, Glob). The docs' snake_case alias table
 * (`search_replace` etc.) does NOT reflect the runtime and would never
 * match. Mirrors codex's edit-tool intent (Edit|Write|apply_patch); the
 * absence of an `apply_patch` analogue is intentional — Grok exposes no
 * patch-style edit tool (the enumeration probe found only Write/StrReplace),
 * so there is nothing to match.
 */
export const GROK_ALGORITHM_UPDATED_MATCHER = "Write|StrReplace";

/**
 * PreToolUse matcher for the fail-closed policy chain: the verified
 * read/write/shell tool names from the same enumeration table. Grep and
 * Glob are deliberately absent (read-only search surfaces with no policy
 * leg); unverified tools (web_search, subagents, MCP) must be enumerated
 * live before they are matched — the version pin guards renames.
 */
export const GROK_PRE_TOOL_USE_MATCHER = "Shell|Read|Write|StrReplace";

interface GrokHomeProjectionOptions {
  homeDir?: string;
  somaRepoPath?: string;
  grokHome?: string;
}

/**
 * Runtime config read by soma-lifecycle.mjs from its colocated
 * soma-lifecycle.config.json (same shape as codexLifecycleConfig, plus
 * the absolute `grokHome`/`startupContextPath` pair — the hook must not
 * derive paths from `process.env.HOME`, which is unset on stock
 * Windows). bunPath stays explicit for detached-survival of the
 * feedback child (soma#73/#75).
 */
function grokLifecycleConfig(
  somaHome: string,
  grokHome: string,
  homeDir?: string,
  somaRepoPath = defaultSomaRepoPath(),
): {
  somaHome: string;
  trustedSomaRepo: string;
  bunPath: string;
  grokHome: string;
  startupContextPath: string;
  privateRoots: string[];
  policyMarkers: string[];
  inboundSecurity: {
    untrustedRoots: string[];
    traceRoot: string;
  };
} {
  const privateRoots = [
    ...somaProjectionPrivateRoots({ homeDir, substrate: "grok" }),
    ...somaMemoryPrivateRoots({ homeDir, substrate: "grok" }),
  ].map((path) => resolve(path));
  const policyMarkers = somaPolicyPrivateMarkers(somaHome, homeDir, privateRoots);
  return {
    somaHome,
    trustedSomaRepo: somaRepoPath,
    bunPath: resolveBunExecutable(),
    grokHome,
    startupContextPath: GROK_STARTUP_CONTEXT_PATH,
    privateRoots,
    policyMarkers,
    inboundSecurity: defaultInboundContentSecurityConfig({ somaHome }),
  };
}

/**
 * Every hook command must stay on Grok's direct-exec fast path. Anything
 * containing a shell metacharacter is routed through `sh -c` — a Git Bash
 * dependency on Windows — and a leading `~` never expands in a bare-exec
 * spawn. Only a token-initial tilde is rejected: Windows 8.3 short names
 * (`KYLELI~1`) carry interior tildes that are perfectly valid bare-exec
 * path bytes. Verified live: the bare `<bunPath> <abs>.mjs <verb>` shape
 * spawns directly on Windows.
 */
function assertGrokSafeHookCommand(command: string): string {
  if (command.split(" ").some((token) => token.startsWith("~")) || /[|&;$<>[\]]/.test(command)) {
    throw new Error(`Grok hook command must be bare-exec safe (no shell metacharacters, no tilde paths): ${command}`);
  }
  return command;
}

// Grok spawns the hook bare-exec as a
// SPACE-JOINED argv (`<bunPath> <module>.mjs <verb>`). A space inside the
// bun path (`C:\Program Files\...\bun.exe`) or the grok home
// (`C:\Users\Some User\.grok\...`) splits into bogus argv tokens, the hook
// fails to LAUNCH, and Grok's platform fails OPEN — silently disabling
// Soma's only Windows enforcement layer. assertGrokSafeHookCommand
// can't catch this: it sees the joined string, where spaces are ambiguous
// token separators. So validate the individual spaceful components here.
//
// An argv-array `command` ([bunPath, module, verb]) would sidestep the
// space-split entirely — but it is UNSUPPORTED on Grok's hook schema.
// Probed against grok 0.2.39 (2026-06-10, read-only): the shipped schema
// (docs/user-guide/10-hooks.md:149 — bundled inside grok.exe) types
// `command` as a STRING ("path to executable ... or inline shell command"),
// every documented/bundled example is a string, and the field carries
// $VAR/$(...) expansion that only a string supports. A non-string `command`
// would fail to deserialize, the hook would never load, and Grok fails OPEN
// (10-hooks.md:150) — silently disabling Soma's only Windows gate. So a
// spaced path cannot be passed as-is. Revisit the argv form only if a future
// grok version documents an array `command`.
//
// Rather than hard-fail every spaced path, try
// a Windows 8.3 short name first — `C:\Program Files\…\bun.exe` →
// `C:\PROGRA~1\…\bun.exe`, `C:\Users\Some User\.grok\…` →
// `C:\Users\SOMEUS~1\.grok\…`. The short form is a space-free bare-exec-safe
// alias to the same file, so install/export succeed for the common
// Program-Files / spaced-profile cases instead of failing. The loud reject
// remains the fail-closed fallback when no whitespace-free short name exists
// (8.3 generation disabled on the volume, or the spaced segment doesn't exist
// yet) — never a silently-broken, fail-open command.

// GetShortPathName only resolves paths that exist, so walk to the longest
// existing ancestor, shorten it via `cmd … %~sI`, and rejoin the
// not-yet-created remainder. Returns undefined off-Windows, when nothing on
// the path exists, when 8.3 is disabled (the name comes back still-spaced),
// or on any spawn error — callers then fail closed.
const grokShortPathCache = new Map<string, string | undefined>();

function windowsShortPath(target: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const resolved = resolve(target);
  if (grokShortPathCache.has(resolved)) return grokShortPathCache.get(resolved);

  let existing = resolved;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      grokShortPathCache.set(resolved, undefined);
      return undefined;
    }
    tail.unshift(basename(existing));
    existing = parent;
  }

  let result: string | undefined;
  try {
    // execSync (not execFileSync): it routes through `cmd /d /s /c "…"`, which
    // preserves the inner quotes around the path; execFileSync's per-arg
    // escaping mangles them. `%~sI` strips the quotes and returns the 8.3
    // short name (or the path unchanged if 8.3 is disabled on the volume,
    // which still-spaced -> the caller rejects).
    const shortAncestor = execSync(`for %I in ("${existing}") do @echo %~sI`, {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    result = shortAncestor ? (tail.length ? join(shortAncestor, ...tail) : shortAncestor) : undefined;
  } catch {
    result = undefined;
  }
  grokShortPathCache.set(resolved, result);
  return result;
}

function bareExecSafeHookToken(label: string, token: string): string {
  if (!/\s/.test(token)) return token;
  const shortened = windowsShortPath(token);
  if (shortened && !/\s/.test(shortened)) return shortened;
  throw new Error(
    `Grok hook command cannot contain whitespace in the ${label} ("${token}") and no whitespace-free Windows 8.3 short name was available. Grok spawns the hook bare-exec as a space-joined argv, so a spaced path splits into bogus tokens, the hook fails to launch, and Grok's fail-open platform silently disables Soma's policy gate. Install Soma and bun under a whitespace-free path (or enable 8.3 short-name generation on the volume), then re-run \`soma install grok\`.`,
  );
}

function grokHookCommand(grokHome: string, bunPath: string, verb: string): string {
  const modulePath = join(grokHome, "hooks", "soma-lifecycle.mjs");
  const safeBunPath = bareExecSafeHookToken("bun path", bunPath);
  const safeModulePath = bareExecSafeHookToken("grok hooks path", modulePath);
  return assertGrokSafeHookCommand([safeBunPath, safeModulePath, verb].join(" "));
}

// Grok's default hook timeout is 5s — too tight for the `bun run soma`
// lifecycle shell-outs, so every hook pins its own.
const GROK_HOOK_TIMEOUT_SECONDS = 30;

/**
 * The hook registration file (`~/.grok/hooks/soma-lifecycle.json`).
 * Grok-verified constraints (shipped hooks doc):
 *   - lifecycle events (SessionStart, UserPromptSubmit, Stop,
 *     SessionEnd) REJECT a `matcher`; only tool events take one.
 *   - SessionEnd never fired in probes (headless exit, ACP
 *     disconnect); it is registered best-effort alongside Stop, and
 *     nothing load-bearing hangs on either.
 *   - PreToolUse registers the fail-closed policy hook over the
 *     verified tool matcher Shell|Read|Write|StrReplace.
 */
function renderGrokHooksJson(grokHome: string, bunPath: string): string {
  const hook = (verb: string) => ({
    type: "command",
    command: grokHookCommand(grokHome, bunPath, verb),
    timeout: GROK_HOOK_TIMEOUT_SECONDS,
  });

  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [hook("session-start")] }],
        UserPromptSubmit: [{ hooks: [hook("prompt-submit")] }],
        // Fail-closed policy enforcement — the only blocking event grok
        // has. Deny shape {"decision":"deny"} on stdout is honored
        // regardless of exit code; --yolo does not bypass it.
        PreToolUse: [{ matcher: GROK_PRE_TOOL_USE_MATCHER, hooks: [hook(GROK_PRE_TOOL_USE_VERB)] }],
        PostToolUse: [{ matcher: GROK_ALGORITHM_UPDATED_MATCHER, hooks: [hook("algorithm-updated")] }],
        // Compaction refresh — persist Algorithm state before the context
        // cut, re-point the model at the projected startup context after
        // it. Matcher-less like the other lifecycle events
        // (PreCompact/PostCompact are binary-verified event names in
        // grok 0.2.38).
        PreCompact: [{ hooks: [hook("pre-compact")] }],
        PostCompact: [{ hooks: [hook("post-compact")] }],
        Stop: [{ hooks: [hook("session-end")] }],
        SessionEnd: [{ hooks: [hook("session-end")] }],
      },
    },
    null,
    2,
  )}\n`;
}

function renderGrokFeedbackHook(): string {
  return renderFeedbackHookModule({
    functionName: "runSomaFeedbackCapture",
    leadingParameters: ["config"],
    promptParameter: "prompt",
    // soma#73: spawn with the explicit resolved bun binary, never
    // process.execPath — the detached feedback child must survive the
    // hook parent's process.exit().
    bunPathExpression: "config.bunPath",
    cwdExpression: "config.trustedSomaRepo",
    somaHomeExpression: "config.somaHome",
    substrate: "grok",
    source: "prompt-submit",
    failureComment: "Feedback capture is best-effort and must never break prompt classification.",
  });
}

interface GrokHookEntryExtension {
  importLine: string;
  fallbackStartMarker: string;
  fallbackEndMarker: string;
}

function applyGrokHookEntryExtensions(source: string, extensions: GrokHookEntryExtension[]): string {
  const importMarker = "// __SOMA_HOOK_MODULE_IMPORTS__";
  if (!source.includes(importMarker)) {
    throw new Error("Grok hook entry is missing the Soma hook module import marker.");
  }

  const imports = extensions.map((extension) => extension.importLine).join("\n");
  let rendered = source.replace(importMarker, imports);
  for (const extension of extensions) {
    const fallbackStart = rendered.indexOf(extension.fallbackStartMarker);
    const fallbackEnd = rendered.indexOf(extension.fallbackEndMarker);
    if (fallbackStart === -1 || fallbackEnd === -1 || fallbackEnd < fallbackStart) {
      throw new Error("Grok hook entry is missing a Soma hook extension fallback marker.");
    }
    rendered = `${rendered.slice(0, fallbackStart)}${rendered.slice(fallbackEnd + extension.fallbackEndMarker.length)}`;
  }
  return rendered;
}

function renderGrokHookEntry(): string {
  return applyGrokHookEntryExtensions(readGrokHookAsset("grok-hook-entry.mjs"), [
    {
      importLine: 'import { runSomaFeedbackCapture } from "./soma-feedback-capture.mjs";',
      fallbackStartMarker: "// __SOMA_PROMPT_SUBMIT_EXTENSION_START__",
      fallbackEndMarker: "// __SOMA_PROMPT_SUBMIT_EXTENSION_END__",
    },
  ]);
}

function renderInstructions(input: ProjectionInput): string {
  return renderSubstrateInstructions({ substrate: "Grok", runtimeLabel: "the Grok CLI" }, input);
}

function renderGrokPolicy(): string {
  return renderPolicyProjection(
    "grok",
    ["Filesystem and tool-call policy when Grok hooks enforce it"],
    [
      "Assistant behavior instructions",
      "Verification reporting",
      "Private context handling",
    ],
  );
}

/**
 * Native Grok subagent surfaces. Grok's `spawn_subagent` reads three
 * user-scope surfaces with no codex/claude analog: `personas/*.toml`
 * (a reusable voice/instruction block), `roles/*.toml` (a capability +
 * reasoning preset), and `agents/*.md` (a full subagent definition). Soma
 * projects one of each so the assistant is reachable from Grok's native
 * subagent system. These files live in SHARED dirs (alongside any user
 * personas/roles/agents), so uninstall removes the individual marker-
 * guarded Soma files, never the directory.
 *
 * Schema fields are limited to ones verified in `~/.grok/bundled/`
 * (2026-06-10-003 cohort): persona = `description`/`instructions` +
 * optional `model`/`reasoning_effort`; role = `description`/
 * `default_capability_mode`/`reasoning_effort`; agent frontmatter =
 * `name`/`description`/`prompt_mode`/`permission_mode`/`agents_md`/`model`.
 * The unconfirmed `skills:` agent key is deliberately NOT emitted. Each
 * file carries a leading Soma marker the uninstall guard keys on. All
 * three are static (no ProjectionInput): identity and the memory tree are
 * read at run time from the colocated `skills/soma/` projection, keeping
 * the principal's context out of these reusable surfaces and the files
 * trivially byte-stable.
 */
function renderGrokSomaPersona(): string {
  return [
    `# ${GROK_PERSONA_MARKER} — do not edit by hand; author in the Soma home and rerun \`soma install grok --apply\`.`,
    "",
    'description = "Soma\'s portable assistant voice: treat Soma as the source of truth for identity, telos, memory, and ISA verification, and keep the principal\'s private context out of public output."',
    'instructions = """',
    "You are operating as the Soma assistant. Soma is the portable personal-assistant",
    "core that carries identity, principal context, telos, memory layout, skills,",
    "policy, and ISA semantics across substrates.",
    "",
    "Operating rules:",
    "- Treat Soma as the source of truth for assistant identity, telos, memory layout, skills, policy, and active ISA context. Read `~/.grok/skills/soma/` for the current projection before asserting personal facts.",
    "- Use the active ISA as the verification contract when one is present.",
    "- Read persistent memory from the declared layout (`~/.grok/skills/soma/memory-layout.md`) before inventing durable facts.",
    "- Keep the principal's personal context out of public templates, code, or shared output unless explicitly asked.",
    "- Report the verification you performed and any substrate limitation you hit.",
    "- Run work through the `the-algorithm` skill when a task warrants Soma Algorithm mode.",
    '"""',
    "",
    'reasoning_effort = "high"',
    "",
  ].join("\n");
}

function renderGrokAlgorithmRole(): string {
  return [
    `# ${GROK_ROLE_MARKER} — do not edit by hand; author in the Soma home and rerun \`soma install grok --apply\`.`,
    "",
    'description = "Run work through Soma Algorithm mode: explicit phase discipline and ISA-criteria verification before a task is called done."',
    'default_capability_mode = "all"',
    'reasoning_effort = "high"',
    "",
  ].join("\n");
}

function renderGrokSomaExploreAgent(): string {
  return [
    "---",
    "name: soma-explore",
    "description: >",
    "  Soma-aware, read-only exploration agent. Use to investigate a codebase or the",
    "  Soma home with full awareness of the Soma memory layout, telos, and active ISA.",
    "  Read-only: finds files, searches content, reads known paths; never edits.",
    "prompt_mode: full",
    "permission_mode: plan",
    "agents_md: true",
    "---",
    "",
    `<!-- ${GROK_AGENT_MARKER} — do not edit by hand; author in the Soma home and rerun \`soma install grok --apply\`. -->`,
    "",
    "You are a Soma-aware, read-only exploration agent.",
    "",
    "Soma context:",
    "- Soma is the portable personal-assistant core. Its projection lives under `~/.grok/skills/soma/`.",
    "- Read `~/.grok/skills/soma/memory-layout.md` for the persistent memory tree before reasoning about durable facts.",
    "- Read `~/.grok/skills/soma/context.md` for assistant identity, principal, and telos.",
    "- Read `~/.grok/skills/soma/active-isa.md` for the active ISA verification contract when present.",
    "- Use the `the-algorithm` skill when exploration should run under Soma Algorithm mode.",
    "",
    "=== READ-ONLY MODE ===",
    "You have no file-editing tools. Do not create, modify, or delete files.",
    "Use execution only for read-only commands (ls, git status, git log, git diff, find, cat, head, tail).",
    "",
    "Guidelines:",
    "- Start broad and narrow down; try multiple search strategies and naming conventions.",
    "- Maximize parallel tool calls for speed — issue independent searches simultaneously.",
    "- Return absolute file paths and relevant snippets in your final response.",
    "- Default scope is the workspace; do not search outside it unless asked.",
    "",
  ].join("\n");
}

/**
 * The-algorithm SKILL.md for Grok = the shared seven-phase banner contract
 * PLUS a Grok-native verification-gate section. Grok has no Soma widget
 * surface: the Algorithm renders as text banners plus Grok's native todo
 * list, made enforceable by the verified session flags `--todo-gate` (the
 * runtime turn-end TodoGate — a turn cannot end while any todo is open)
 * and `--check` (appends a headless self-verification loop), with the
 * active ISA's open criteria as the todo seed. The Grok-specific gate
 * guidance lives HERE, not in the shared renderer, so no Grok flag or
 * tool name leaks into Codex's projection (DD-4). `todo_write` is the
 * documented native todo tool (user-guide tool table); this is
 * model-facing prose, not a hook matcher, so the documented name is what
 * the agent acts on.
 */
function renderGrokAlgorithmSkill(input: ProjectionInput): string {
  const isaSeedLine = input.activeIsa
    ? `An active ISA (\`${input.activeIsa.slug}\`) is set: seed the todo list from its open criteria in \`~/.grok/skills/soma/active-isa.md\` before BUILD — one todo per criterion.`
    : "No active ISA is set: seed the todo list from the PLAN steps instead — one todo per step.";
  return [
    renderAlgorithmRenderingContract("Grok"),
    "",
    "## Grok Verification Gates",
    "",
    "Grok renders the Algorithm as the text banners above plus its native todo list. There is no Soma widget surface on Grok — text and the todo list are the whole rendering. Do not claim Pi-style widgets.",
    "",
    "Map the phases onto Grok's native verification surfaces:",
    "- PLAN: mirror each plan step and each active-ISA criterion into the native todo list with `todo_write`. Keep the criterion id in the todo text so VERIFY can map evidence back to it.",
    "- VERIFY: do not mark a todo complete until its criterion has evidence; report each criterion's status as in the Algorithm VERIFY phase.",
    "- For verification-heavy or unattended work, run headless with `--todo-gate` (session turn cannot end while any todo is open) and `--check` (appends Grok's self-verification loop to the prompt). Both are headless/session-scoped flags.",
    "",
    "### ISA -> todo seed",
    "",
    isaSeedLine,
    "Read `~/.grok/skills/soma/active-isa.md` for the current criteria: an open criterion becomes an open todo, a passed criterion a completed one. The active ISA is the checklist seed; `todo_write` + `--todo-gate` make it the turn-end gate.",
  ].join("\n");
}

/**
 * Entry skill for the home projection. `~/.grok/skills/<name>/SKILL.md` is
 * one of the two verified auto-loaded home surfaces, so this
 * file carries the discovery frontmatter plus the use rules; the bulk
 * context lives in the colocated companion files it points at.
 */
function renderGrokHomeSkill(input: ProjectionInput, somaHome: string): string {
  return [
    "---",
    "name: soma",
    "description: Use when work depends on portable personal assistant context, Soma identity, telos, ISA criteria, memory layout, skills, policy, or default assistant behavior across substrates.",
    "metadata:",
    "  short-description: Portable personal assistant context",
    "---",
    "",
    "# Soma",
    "",
    "Soma is the portable personal assistant core. It keeps assistant identity, principal context, telos, memory, skills, policy, and ISA semantics outside any one substrate.",
    "",
    `Source of truth: ${somaHome}`,
    "",
    "## Use",
    "",
    "- Read `~/.grok/skills/soma/context.md` for the full projected assistant context.",
    "- Read `~/.grok/skills/soma/memory-layout.md` before using persistent memory.",
    "- Read `~/.grok/skills/soma/skills.md` for the declared Soma skills.",
    "- Read `~/.grok/skills/soma/policy.md` for the substrate policy projection.",
    "- Read `~/.grok/skills/soma/active-isa.md` for the active ISA verification contract when that file is present.",
    "- Read `~/.grok/skills/soma/startup-context.md` for lifecycle-generated active work and recent learning context when present; the Soma session-start hook refreshes it.",
    "- Use the `the-algorithm` skill when work should run through Soma Algorithm mode.",
    "- Treat project-local `.grok/rules/soma/` context as an overlay on this home projection.",
    "- Do not assume a global `soma` binary exists; run `bun run soma ...` from the Soma repo.",
    "",
    "This projection is generated from Soma. Author changes in the Soma home and rerun `soma install grok --apply`.",
    "",
    "## Current Projection",
    "",
    renderAssistantCore(input),
  ].join("\n");
}

function renderGrokRulesReadme(): string {
  return [
    "# Soma Grok Projection",
    "",
    "This directory is generated by Soma. The portable source of truth is the Soma home.",
    "",
    "Grok auto-discovers project rules under `.grok/rules/` (walked from the working directory to the repo root, regardless of project trust), so this overlay loads as project context. It is context-only by design: hooks and policy are installed at user scope (`~/.grok/`), never from a repo.",
    "",
    "## Files",
    "",
    "- `context.md` — assistant identity, principal, telos, and operating rules",
    "- `memory-layout.md` — pointers into the Soma memory tree",
    "- `skills.md` — discovered Soma skills",
    "- `policy.md` — substrate policy projection",
    "",
    "Do not edit these files by hand; rerun `soma install grok --apply` after changing Soma source context.",
  ].join("\n");
}

/**
 * Workspace projection (`soma project grok` / project overlays). Files
 * land under `<repo>/.grok/rules/soma/`, the project-scoped rules dir
 * Grok auto-discovers regardless of trust — unlike the home
 * `~/.grok/rules/` dir, which Grok never loads. Context-only: no hooks
 * or policy assets ever ship at project scope.
 */
export function projectGrok(input: ProjectionInput): Projection {
  const instructions = renderInstructions(input);

  return {
    substrate: "grok",
    instructions,
    files: [
      { path: ".grok/rules/soma/README.md", content: renderGrokRulesReadme() },
      { path: ".grok/rules/soma/context.md", content: instructions },
      { path: ".grok/rules/soma/memory-layout.md", content: renderMemoryLayout(input) },
      { path: ".grok/rules/soma/skills.md", content: renderSkills(input) },
      { path: ".grok/rules/soma/policy.md", content: renderGrokPolicy() },
    ],
  };
}

/**
 * Home projection (`soma install grok`). Files are relative to the Grok
 * home (`~/.grok`) and route through the two verified auto-loaded
 * discovery surfaces: the `skills/soma/` entry skill rendered
 * here, and the `AGENTS.md` pointer block patched post-projection by
 * `configureGrokAgentsPointer`.
 */
export function projectGrokHome(input: ProjectionInput, somaHome: string, options: GrokHomeProjectionOptions = {}): Projection {
  const instructions = renderInstructions(input);
  // The hook surface needs install-time absolutes: bare-exec commands
  // carry no tilde, and the hook runtime derives nothing from env.
  // `grokHome` honors a substrateHome override when the caller
  // (buildGrokHomeProjection) resolves one.
  const grokHome = options.grokHome ?? grokHomeDir(options.homeDir);
  const somaRepoPath = options.somaRepoPath ?? defaultSomaRepoPath();
  const bunPath = resolveBunExecutable();
  // Portable Soma skills project through the default substrate rewrite
  // (Claude memory roots -> Soma memory, Claude-only lines stripped) —
  // grok deliberately takes the default-rewrite branch, same as codex.
  const portableSkillFiles = projectableSkills(input.profile.skills).flatMap((skill) =>
    (skill.files ?? []).map((file) => ({
      path: `skills/${skill.name}/${file.path}`,
      content: rewriteSubstrateProjectionContent({
        substrate: "grok",
        path: file.path,
        content: file.content,
      }),
    })),
  );

  return {
    substrate: "grok",
    instructions,
    files: [
      { path: "skills/soma/SKILL.md", content: renderGrokHomeSkill(input, somaHome) },
      { path: "skills/soma/context.md", content: instructions },
      { path: "skills/soma/memory-layout.md", content: renderMemoryLayout(input) },
      { path: "skills/soma/skills.md", content: renderSkills(input) },
      { path: "skills/soma/policy.md", content: renderGrokPolicy() },
      { path: "hooks/soma-lifecycle.json", content: renderGrokHooksJson(grokHome, bunPath) },
      // Shipped verbatim; the install-time facts live in the colocated
      // config (same split as codex, soma#73). executable:true is
      // harmless POSIX parity — Grok invokes via the explicit bunPath.
      { path: "hooks/soma-lifecycle.mjs", content: readGrokHookAsset("soma-lifecycle.mjs"), executable: true },
      {
        path: "hooks/soma-lifecycle.config.json",
        content: `${JSON.stringify(grokLifecycleConfig(somaHome, grokHome, options.homeDir, somaRepoPath), null, 2)}\n`,
      },
      { path: "hooks/grok-hook-entry.mjs", content: renderGrokHookEntry() },
      // The descriptor-parameterized shell-extraction core, projected
      // BEFORE its importer below so a reproject never lands
      // grok-policy-targets.mjs on disk without its import target.
      { path: "hooks/shell-policy-core.mjs", content: readGrokHookAsset("shell-policy-core.mjs") },
      // The policy-target extractor and its marker matcher ship verbatim
      // beside the dispatcher (same colocated-module model as codex's
      // policy assets).
      { path: "hooks/grok-policy-targets.mjs", content: readGrokHookAsset("grok-policy-targets.mjs") },
      // The shared verb constant imported by the dispatcher and the
      // lifecycle bootstrap so a PreToolUse rename stays atomic.
      { path: "hooks/grok-hook-verbs.mjs", content: readGrokHookAsset("grok-hook-verbs.mjs") },
      { path: "hooks/policy-marker.mjs", content: readGrokHookAsset("policy-marker.mjs") },
      { path: "hooks/soma-feedback-capture.mjs", content: renderGrokFeedbackHook() },
      // Native Grok subagent surfaces — a Soma persona, an Algorithm
      // role, and a Soma-aware read-only exploration agent. Static (no
      // input): the principal's context is read at run time from the
      // colocated skills/soma/ projection, not embedded here.
      { path: "personas/soma.toml", content: renderGrokSomaPersona() },
      { path: "roles/soma-algorithm.toml", content: renderGrokAlgorithmRole() },
      { path: "agents/soma-explore.md", content: renderGrokSomaExploreAgent() },
      ...portableSkillFiles,
      // After the portable skills on purpose: when `the-algorithm` is
      // imported as a portable skill, the static rendering contract
      // overwrites its SKILL.md while Workflows/references ship through
      // (same ordering contract as projectCodexHome).
      { path: "skills/the-algorithm/SKILL.md", content: renderGrokAlgorithmSkill(input) },
      // Active-ISA projection (#37). OMITTED when no active ISA — AC-2.
      ...activeIsaBundleFile("grok", input.activeIsa),
    ],
  };
}

export const grokAdapter: SomaAdapter = {
  name: "grok",
  detect() {
    return Promise.resolve(existsSync(grokHomeDir()));
  },
  project(input) {
    return Promise.resolve(projectGrok(input));
  },
  run(task: SomaTask) {
    return Promise.resolve({
      taskId: task.id,
      substrate: "grok",
      status: "failed",
      summary: "Grok execution is not implemented yet; use project() to generate the substrate bundle.",
    });
  },
};
