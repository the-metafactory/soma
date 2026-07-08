import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveBunExecutable } from "../../bun-probe";
import { isEnoent } from "../../fs-errors";
import { isClaudeCodeInstallOptions } from "./install-options";

/**
 * soma#369: adapter-owned session hooks (mode classifier, policy guard) are
 * default-on. Enabled unless a caller explicitly passes `<hook>: false`, so an
 * absent option or non-options value (internal reproject paths) still installs
 * them. Shared by the hook installer and the install spec's optionalHomeFiles
 * so the projected file list and what actually gets written stay in lockstep.
 */
export function claudeCodeHookEnabled(
  options: unknown,
  hook: "modeClassifier" | "policyGuard" | "preCompact" | "statusLine",
): boolean {
  if (!isClaudeCodeInstallOptions(options)) return true;
  return options[hook] !== false;
}

export const SOMA_CLAUDE_HOOK_RELATIVE_PATH = "hooks/soma/soma-claude-code-hook.mjs";
export const SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH = "hooks/soma/soma-claude-code-hook.config.json";
export const SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH = "hooks/soma/soma-mode-classifier.mjs";
export const SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH = "hooks/soma/soma-mode-classifier.config.json";
export const SOMA_CLAUDE_POLICY_GUARD_RELATIVE_PATH = "hooks/soma/soma-policy-guard.mjs";
export const SOMA_CLAUDE_POLICY_GUARD_CONFIG_RELATIVE_PATH = "hooks/soma/soma-policy-guard.config.json";
export const SOMA_CLAUDE_PRECOMPACT_RELATIVE_PATH = "hooks/soma/soma-precompact.mjs";
export const SOMA_CLAUDE_PRECOMPACT_CONFIG_RELATIVE_PATH = "hooks/soma/soma-precompact.config.json";
// soma statusline: self-contained bundled script (SOMA_HOME baked in at
// projection time) — no bunPath, no argv dispatch, no companion config.json.
export const SOMA_CLAUDE_STATUSLINE_RELATIVE_PATH = "hooks/soma/soma-statusline.sh";
// PreToolUse matcher for the fail-closed enforcement guard: every tool whose
// input can carry a dangerous command, an outbound exfiltration, or a
// credential-path read/write that the runtime policy must inspect.
const SOMA_CLAUDE_POLICY_GUARD_MATCHER = "Bash|Read|Edit|Write|MultiEdit|NotebookEdit";
const SOMA_CLAUDE_SETTINGS_RELATIVE_PATH = "settings.json";
const SOMA_DVSABLED_HOOKS_KEY = "somaDisabledHooks";
const PAI_MODE_CLASSIFIER_KEY = "paiModeClassifier";

const SOMA_CLAUDE_HOOK_EVENTS = [
  {
    event: "SessionStart",
    commandEvent: "session-start",
    summary: "Start Soma lifecycle session",
    runner: { kind: "lifecycle", lifecycleEvent: "session-start" },
  },
  {
    event: "SessionEnd",
    commandEvent: "session-end",
    summary: "End Soma lifecycle session",
    runner: { kind: "lifecycle", lifecycleEvent: "session-end" },
  },
  {
    event: "PostToolUse",
    commandEvent: "writeback-tool",
    matcher: "Write|Edit|MultiEdit|NotebookEdit",
    summary: "Write Soma tool metadata",
    runner: {
      kind: "writeback",
      eventKind: "writeback.claude_code.tool",
      eventSummary: "Claude Code tool activity metadata captured.",
      source: "PostToolUse",
    },
  },
  {
    event: "SubagentStart",
    commandEvent: "writeback-subagent-start",
    summary: "Write Soma subagent start metadata",
    runner: {
      kind: "writeback",
      eventKind: "writeback.claude_code.subagent_start",
      eventSummary: "Claude Code subagent start metadata captured.",
      source: "SubagentStart",
    },
  },
  {
    event: "SubagentStop",
    commandEvent: "writeback-subagent-stop",
    summary: "Write Soma subagent stop metadata",
    runner: {
      kind: "writeback",
      eventKind: "writeback.claude_code.subagent_stop",
      eventSummary: "Claude Code subagent stop metadata captured.",
      source: "SubagentStop",
    },
  },
] as const;

type JsonObject = Record<string, unknown>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function legacySomaClaudeHookCommand(substrateHome: string, commandEvent: string): string {
  return `${shellQuote(resolve(substrateHome, SOMA_CLAUDE_HOOK_RELATIVE_PATH))} ${commandEvent}`;
}

function somaClaudeHookCommand(substrateHome: string, bunPath: string, commandEvent: string): string {
  return `${shellQuote(bunPath)} ${shellQuote(resolve(substrateHome, SOMA_CLAUDE_HOOK_RELATIVE_PATH))} ${commandEvent}`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(content: string, path: string): JsonObject {
  if (content.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(content);
  if (!isObject(parsed)) {
    throw new Error(`Claude Code settings must be a JSON object: ${path}`);
  }
  return parsed;
}

async function readSettingsWithRaw(path: string): Promise<{ before: string; settings: JsonObject }> {
  const before = await readFile(path, "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return "";
    throw error;
  });
  return { before, settings: parseJsonObject(before, path) };
}

function somaHookCommands(substrateHome: string, bunPath: string): Set<string> {
  return new Set(
    SOMA_CLAUDE_HOOK_EVENTS.flatMap((event) => [
      somaClaudeHookCommand(substrateHome, bunPath, event.commandEvent),
      legacySomaClaudeHookCommand(substrateHome, event.commandEvent),
    ]),
  );
}

function somaHookEntry(substrateHome: string, bunPath: string, commandEvent: string): JsonObject {
  return {
    type: "command",
    command: somaClaudeHookCommand(substrateHome, bunPath, commandEvent),
    timeout: 30,
  };
}

function legacySomaModeClassifierCommand(substrateHome: string): string {
  return shellQuote(resolve(substrateHome, SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH));
}

function somaModeClassifierCommand(substrateHome: string, bunPath: string): string {
  return `${shellQuote(bunPath)} ${shellQuote(resolve(substrateHome, SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH))}`;
}

function somaModeClassifierCommands(substrateHome: string, bunPath: string): Set<string> {
  return new Set([
    somaModeClassifierCommand(substrateHome, bunPath),
    legacySomaModeClassifierCommand(substrateHome),
  ]);
}

function somaModeClassifierEntry(substrateHome: string, bunPath: string): JsonObject {
  return {
    type: "command",
    command: somaModeClassifierCommand(substrateHome, bunPath),
    timeout: 10,
  };
}

function legacySomaPolicyGuardCommand(substrateHome: string): string {
  return shellQuote(resolve(substrateHome, SOMA_CLAUDE_POLICY_GUARD_RELATIVE_PATH));
}

function somaPolicyGuardCommand(substrateHome: string, bunPath: string): string {
  return `${shellQuote(bunPath)} ${shellQuote(resolve(substrateHome, SOMA_CLAUDE_POLICY_GUARD_RELATIVE_PATH))}`;
}

function somaPolicyGuardCommands(substrateHome: string, bunPath: string): Set<string> {
  return new Set([
    somaPolicyGuardCommand(substrateHome, bunPath),
    legacySomaPolicyGuardCommand(substrateHome),
  ]);
}

function somaPolicyGuardEntry(substrateHome: string, bunPath: string): JsonObject {
  return {
    type: "command",
    command: somaPolicyGuardCommand(substrateHome, bunPath),
    timeout: 30,
  };
}

// The fail-closed enforcement guard wires the same binary into two events:
// PreToolUse (tool_call surface, matcher-scoped) and UserPromptSubmit (prompt
// surface). Both share one command set for idempotent append + clean removal.
function appendSomaPolicyGuardHookGroups(settings: JsonObject, substrateHome: string, bunPath: string): boolean {
  const knownCommands = somaPolicyGuardCommands(substrateHome, bunPath);
  const preTool = appendCommandHookGroup(settings, {
    event: "PreToolUse",
    description: "Soma: Enforce runtime policy on tool calls (fail-closed)",
    matcher: SOMA_CLAUDE_POLICY_GUARD_MATCHER,
    entry: somaPolicyGuardEntry(substrateHome, bunPath),
    knownCommands,
  });
  const prompt = appendCommandHookGroup(settings, {
    event: "UserPromptSubmit",
    description: "Soma: Enforce runtime policy on prompts (fail-closed)",
    entry: somaPolicyGuardEntry(substrateHome, bunPath),
    knownCommands,
  });
  return preTool || prompt;
}

// Collect every command in the guard's two events that references the guard
// hook script, regardless of the bun path it was written with. This makes
// uninstall robust to a settings entry recorded with a different bun path than
// the one in the installed config (otherwise the files are removed but a stale
// command keeps invoking a now-missing hook).
function installedPolicyGuardCommands(settings: JsonObject, substrateHome: string): Set<string> {
  const scriptPath = resolve(substrateHome, SOMA_CLAUDE_POLICY_GUARD_RELATIVE_PATH);
  const found = new Set<string>();
  if (!isObject(settings.hooks)) return found;
  for (const event of ["PreToolUse", "UserPromptSubmit"]) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const command of groupCommands(group)) {
        if (command.includes(scriptPath)) found.add(command);
      }
    }
  }
  return found;
}

function removeSomaPolicyGuardFromSettings(settings: JsonObject, substrateHome: string, bunPath: string): boolean {
  const commands = new Set([
    ...somaPolicyGuardCommands(substrateHome, bunPath),
    ...installedPolicyGuardCommands(settings, substrateHome),
  ]);
  const preTool = removeCommandsFromSettingsEvent(settings, "PreToolUse", commands);
  const prompt = removeCommandsFromSettingsEvent(settings, "UserPromptSubmit", commands);
  return preTool || prompt;
}

// PreCompact handover hook: ONE asset dispatched by argv into two events —
// `capture` on PreCompact (persist the handover) and `resurface` on
// UserPromptSubmit (re-inject it once after compaction). The action suffix is
// part of the command string so idempotent append + clean removal see both.
function legacySomaPreCompactCommand(substrateHome: string, action: string): string {
  return `${shellQuote(resolve(substrateHome, SOMA_CLAUDE_PRECOMPACT_RELATIVE_PATH))} ${action}`;
}

function somaPreCompactCommand(substrateHome: string, bunPath: string, action: string): string {
  return `${shellQuote(bunPath)} ${shellQuote(resolve(substrateHome, SOMA_CLAUDE_PRECOMPACT_RELATIVE_PATH))} ${action}`;
}

function somaPreCompactCommands(substrateHome: string, bunPath: string): Set<string> {
  return new Set(
    ["capture", "resurface"].flatMap((action) => [
      somaPreCompactCommand(substrateHome, bunPath, action),
      legacySomaPreCompactCommand(substrateHome, action),
    ]),
  );
}

function somaPreCompactEntry(substrateHome: string, bunPath: string, action: string, timeout: number): JsonObject {
  return {
    type: "command",
    command: somaPreCompactCommand(substrateHome, bunPath, action),
    timeout,
  };
}

function appendSomaPreCompactHookGroups(settings: JsonObject, substrateHome: string, bunPath: string): boolean {
  const knownCommands = somaPreCompactCommands(substrateHome, bunPath);
  const capture = appendCommandHookGroup(settings, {
    event: "PreCompact",
    description: "Soma: Capture a pre-compaction handover of active work-state",
    entry: somaPreCompactEntry(substrateHome, bunPath, "capture", 30),
    knownCommands,
  });
  const resurface = appendCommandHookGroup(settings, {
    event: "UserPromptSubmit",
    description: "Soma: Resurface the pre-compaction handover after compaction",
    entry: somaPreCompactEntry(substrateHome, bunPath, "resurface", 15),
    knownCommands,
  });
  return capture || resurface;
}

// Like installedPolicyGuardCommands: collect every command in the two events
// that references the handover script regardless of the bun path it was
// recorded with, so uninstall is robust to a drifted bun path.
function installedPreCompactCommands(settings: JsonObject, substrateHome: string): Set<string> {
  const scriptPath = resolve(substrateHome, SOMA_CLAUDE_PRECOMPACT_RELATIVE_PATH);
  const found = new Set<string>();
  if (!isObject(settings.hooks)) return found;
  for (const event of ["PreCompact", "UserPromptSubmit"]) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const command of groupCommands(group)) {
        if (command.includes(scriptPath)) found.add(command);
      }
    }
  }
  return found;
}

function removeSomaPreCompactFromSettings(settings: JsonObject, substrateHome: string, bunPath: string): boolean {
  const commands = new Set([
    ...somaPreCompactCommands(substrateHome, bunPath),
    ...installedPreCompactCommands(settings, substrateHome),
  ]);
  const preCompact = removeCommandsFromSettingsEvent(settings, "PreCompact", commands);
  const prompt = removeCommandsFromSettingsEvent(settings, "UserPromptSubmit", commands);
  return preCompact || prompt;
}

function appendCommandHookGroup(
  settings: JsonObject,
  input: { event: string; description: string; matcher?: string; entry: JsonObject; knownCommands: Set<string> },
): boolean {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const eventGroups = Array.isArray(hooks[input.event]) ? hooks[input.event] as unknown[] : [];

  for (const group of eventGroups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    if (group.hooks.some((hook) => isObject(hook) && typeof hook.command === "string" && input.knownCommands.has(hook.command))) {
      settings.hooks = hooks;
      return false;
    }
  }

  eventGroups.push({
    description: input.description,
    ...(input.matcher ? { matcher: input.matcher } : {}),
    hooks: [input.entry],
  });
  hooks[input.event] = eventGroups;
  settings.hooks = hooks;
  return true;
}

function appendSomaHookGroup(settings: JsonObject, input: (typeof SOMA_CLAUDE_HOOK_EVENTS)[number], substrateHome: string, bunPath: string): boolean {
  return appendCommandHookGroup(settings, {
    event: input.event,
    description: `Soma: ${input.summary}`,
    ...("matcher" in input ? { matcher: input.matcher } : {}),
    entry: somaHookEntry(substrateHome, bunPath, input.commandEvent),
    knownCommands: somaHookCommands(substrateHome, bunPath),
  });
}

function appendSomaModeClassifierHookGroup(settings: JsonObject, substrateHome: string, bunPath: string): boolean {
  return appendCommandHookGroup(settings, {
    event: "UserPromptSubmit",
    description: "Soma: Classify prompts into MINIMAL, NATIVE, or ALGORITHM mode",
    entry: somaModeClassifierEntry(substrateHome, bunPath),
    knownCommands: somaModeClassifierCommands(substrateHome, bunPath),
  });
}

function removeSomaHooksFromSettings(settings: JsonObject, substrateHome: string, bunPath: string): boolean {
  if (!isObject(settings.hooks)) return false;
  const commands = somaHookCommands(substrateHome, bunPath);
  const nextHooksByEvent: JsonObject = {};
  let changed = false;

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      nextHooksByEvent[event] = groups;
      continue;
    }
    const nextGroups: unknown[] = [];
    for (const group of groups) {
      const result = removeSomaCommandsFromGroup(group, commands);
      changed = result.changed || changed;
      if (result.group) nextGroups.push(result.group);
    }
    if (nextGroups.length > 0) {
      nextHooksByEvent[event] = nextGroups;
    }
  }

  if (Object.keys(nextHooksByEvent).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = nextHooksByEvent;
  }
  return changed;
}

function removeSomaModeClassifierFromSettings(settings: JsonObject, substrateHome: string, bunPath: string): boolean {
  const changed = removeCommandsFromSettingsEvent(settings, "UserPromptSubmit", somaModeClassifierCommands(substrateHome, bunPath));
  return restorePaiModeClassifierHooks(settings) || changed;
}

function removeCommandsFromSettingsEvent(settings: JsonObject, event: string, commands: Set<string>): boolean {
  if (!isObject(settings.hooks)) return false;
  const hooks = settings.hooks;
  const groups = hooks[event];
  if (!Array.isArray(groups)) return false;

  const nextGroups: unknown[] = [];
  let changed = false;
  for (const group of groups) {
    const result = removeSomaCommandsFromGroup(group, commands);
    changed = result.changed || changed;
    if (result.group) nextGroups.push(result.group);
  }
  if (!changed) return false;

  const nextHooks = nextGroups.length > 0
    ? { ...hooks, [event]: nextGroups }
    : Object.fromEntries(Object.entries(hooks).filter(([key]) => key !== event));
  if (Object.keys(nextHooks).length === 0) delete settings.hooks;
  else settings.hooks = nextHooks;
  return true;
}

function removeSomaCommandsFromGroup(group: unknown, commands: Set<string>): { group?: unknown; changed: boolean } {
  if (!isObject(group) || !Array.isArray(group.hooks)) {
    return { group, changed: false };
  }
  const nextHooks = group.hooks.filter((hook) => !(isObject(hook) && typeof hook.command === "string" && commands.has(hook.command)));
  if (nextHooks.length === group.hooks.length) {
    return { group, changed: false };
  }
  if (nextHooks.length === 0) {
    return { changed: true };
  }
  return { group: { ...group, hooks: nextHooks }, changed: true };
}

function isPaiModeClassifierCommand(command: string): boolean {
  return /(?:^|[/\\])ModeClassifier\.hook\.(?:ts|js|mjs)(?:[\s"']|$)/.test(command) || command.includes("ModeClassifier.hook.ts");
}

function groupCommands(group: unknown): string[] {
  if (!isObject(group) || !Array.isArray(group.hooks)) return [];
  return group.hooks.flatMap((hook) => isObject(hook) && typeof hook.command === "string" ? [hook.command] : []);
}

function disabledPaiModeClassifierGroups(settings: JsonObject): unknown[] {
  if (!isObject(settings[SOMA_DVSABLED_HOOKS_KEY])) return [];
  const stored = settings[SOMA_DVSABLED_HOOKS_KEY][PAI_MODE_CLASSIFIER_KEY];
  return Array.isArray(stored) ? stored : [];
}

function setDisabledPaiModeClassifierGroups(settings: JsonObject, groups: unknown[]): void {
  const disabled = isObject(settings[SOMA_DVSABLED_HOOKS_KEY]) ? settings[SOMA_DVSABLED_HOOKS_KEY] : {};
  if (groups.length === 0) {
    Reflect.deleteProperty(disabled, PAI_MODE_CLASSIFIER_KEY);
  } else {
    disabled[PAI_MODE_CLASSIFIER_KEY] = groups;
  }
  if (Object.keys(disabled).length === 0) {
    Reflect.deleteProperty(settings, SOMA_DVSABLED_HOOKS_KEY);
  } else {
    settings[SOMA_DVSABLED_HOOKS_KEY] = disabled;
  }
}

function disablePaiModeClassifierHooks(settings: JsonObject): boolean {
  if (!isObject(settings.hooks)) return false;
  const groups = settings.hooks.UserPromptSubmit;
  if (!Array.isArray(groups)) return false;

  const disabled = [...disabledPaiModeClassifierGroups(settings)];
  const knownDisabledCommands = new Set(disabled.flatMap(groupCommands));
  const nextGroups: unknown[] = [];
  let changed = false;

  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      nextGroups.push(group);
      continue;
    }

    const removedHooks = group.hooks.filter((hook) =>
      isObject(hook) && typeof hook.command === "string" && isPaiModeClassifierCommand(hook.command),
    );
    if (removedHooks.length === 0) {
      nextGroups.push(group);
      continue;
    }

    const keptHooks = group.hooks.filter((hook) => !removedHooks.includes(hook));
    if (removedHooks.some((hook) => isObject(hook) && typeof hook.command === "string" && !knownDisabledCommands.has(hook.command))) {
      disabled.push({ ...group, hooks: removedHooks });
    }
    if (keptHooks.length > 0) nextGroups.push({ ...group, hooks: keptHooks });
    changed = true;
  }

  if (!changed) return false;
  if (nextGroups.length > 0) {
    settings.hooks.UserPromptSubmit = nextGroups;
  } else {
    delete settings.hooks.UserPromptSubmit;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  setDisabledPaiModeClassifierGroups(settings, disabled);
  return true;
}

function restorePaiModeClassifierHooks(settings: JsonObject): boolean {
  const disabled = disabledPaiModeClassifierGroups(settings);
  if (disabled.length === 0) return false;

  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const groups = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit as unknown[] : [];
  const existingCommands = new Set(groups.flatMap(groupCommands));
  let restored = false;
  for (const group of disabled) {
    const missingGroup = groupWithMissingCommands(group, existingCommands);
    const commands = groupCommands(missingGroup);
    if (commands.length === 0) continue;
    groups.push(missingGroup);
    restored = true;
    for (const command of commands) existingCommands.add(command);
  }
  if (restored) {
    hooks.UserPromptSubmit = groups;
    settings.hooks = hooks;
  }
  setDisabledPaiModeClassifierGroups(settings, []);
  return true;
}

function groupWithMissingCommands(group: unknown, existingCommands: Set<string>): unknown {
  if (!isObject(group) || !Array.isArray(group.hooks)) return group;
  const hooks = group.hooks.filter((hook) =>
    isObject(hook) && typeof hook.command === "string" && !existingCommands.has(hook.command),
  );
  return { ...group, hooks };
}

async function writeJsonIfChanged(path: string, value: JsonObject, before?: string): Promise<string[]> {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (before === next) return [];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return [path];
}

export async function patchClaudeCodeSomaHookSettings(substrateHome: string, bunPath = resolveBunExecutable()): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  let changed = false;
  for (const event of SOMA_CLAUDE_HOOK_EVENTS) {
    changed = appendSomaHookGroup(settings, event, substrateHome, bunPath) || changed;
  }
  if (!changed && before.trim().length > 0) return [];
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function patchClaudeCodeModeClassifierSettings(substrateHome: string, bunPath = resolveBunExecutable()): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  const disabledPai = disablePaiModeClassifierHooks(settings);
  const appendedSoma = appendSomaModeClassifierHookGroup(settings, substrateHome, bunPath);
  const changed = disabledPai || appendedSoma;
  if (!changed && before.trim().length > 0) return [];
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function patchClaudeCodePolicyGuardSettings(substrateHome: string, bunPath = resolveBunExecutable()): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  const changed = appendSomaPolicyGuardHookGroups(settings, substrateHome, bunPath);
  if (!changed && before.trim().length > 0) return [];
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function unpatchClaudeCodePolicyGuardSettings(substrateHome: string, bunPath = resolveBunExecutable()): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  if (before.trim().length === 0) return [];
  if (!removeSomaPolicyGuardFromSettings(settings, substrateHome, bunPath)) return [];
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function patchClaudeCodePreCompactSettings(substrateHome: string, bunPath = resolveBunExecutable()): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  const changed = appendSomaPreCompactHookGroups(settings, substrateHome, bunPath);
  if (!changed && before.trim().length > 0) return [];
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function unpatchClaudeCodePreCompactSettings(substrateHome: string, bunPath = resolveBunExecutable()): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  if (before.trim().length === 0) return [];
  if (!removeSomaPreCompactFromSettings(settings, substrateHome, bunPath)) return [];
  return writeJsonIfChanged(settingsPath, settings, before);
}

// The status line is a top-level `statusLine` key, not a hooks[] entry — it
// has no matcher, no argv action, and (unlike every other soma-owned hook) no
// bunPath, since Claude Code execs the bundled script directly via its
// shebang. Soma always writes its own entry on install (last writer wins, as
// with every other soma-owned settings key); uninstall only removes it when
// the recorded `command` still points at OUR projected script path, so a
// user's unrelated statusLine is never clobbered.
export async function patchClaudeCodeStatusLineSettings(substrateHome: string, scriptPath: string): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  settings.statusLine = { type: "command", command: scriptPath };
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function unpatchClaudeCodeStatusLineSettings(substrateHome: string, scriptPath: string): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  if (before.trim().length === 0) return [];
  const statusLine = settings.statusLine;
  if (!isObject(statusLine) || statusLine.command !== scriptPath) return [];
  delete settings.statusLine;
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function unpatchClaudeCodeSomaHookSettings(substrateHome: string, bunPath = resolveBunExecutable()): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  if (before.trim().length === 0) return [];
  if (!removeSomaHooksFromSettings(settings, substrateHome, bunPath)) return [];
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function unpatchClaudeCodeModeClassifierSettings(substrateHome: string, bunPath = resolveBunExecutable()): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  if (before.trim().length === 0) return [];
  if (!removeSomaModeClassifierFromSettings(settings, substrateHome, bunPath)) return [];
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function installClaudeCodeSomaHooks(context: {
  somaHome: string;
  somaRepoPath: string;
  substrateHome: string;
  options?: unknown;
}): Promise<string[]> {
  const hookPath = resolve(context.substrateHome, SOMA_CLAUDE_HOOK_RELATIVE_PATH);
  const configPath = resolve(context.substrateHome, SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH);
  const bunPath = resolveBunExecutable();
  const config = {
    somaHome: context.somaHome,
    trustedSomaRepo: context.somaRepoPath,
    bunPath,
  };

  await installClaudeCodeHookAsset({
    hookPath,
    configPath,
    source: renderClaudeCodeSomaHook(),
    config,
  });
  const settingsFiles = await patchClaudeCodeSomaHookSettings(context.substrateHome, bunPath);
  // soma#369: the adapter owns the session fleet. Mode classifier and policy
  // guard are default-on; a caller opts out with `modeClassifier: false` /
  // `policyGuard: false` (CLI `--no-mode-classifier` / `--no-policy-guard`).
  // Undefined options (internal reproject paths) keep the default-on behavior.
  const modeClassifierFiles = claudeCodeHookEnabled(context.options, "modeClassifier")
    ? await installClaudeCodeModeClassifierHook(context, config, bunPath)
    : [];
  const policyGuardFiles = claudeCodeHookEnabled(context.options, "policyGuard")
    ? await installClaudeCodePolicyGuardHook(context, config, bunPath)
    : [];
  const preCompactFiles = claudeCodeHookEnabled(context.options, "preCompact")
    ? await installClaudeCodePreCompactHook(context, config, bunPath)
    : [];
  // Status line is also default-on; opt out with `statusLine: false`.
  const statusLineFiles = claudeCodeHookEnabled(context.options, "statusLine")
    ? await installClaudeCodeStatusLine(context)
    : [];
  return Array.from(new Set([hookPath, configPath, ...settingsFiles, ...modeClassifierFiles, ...policyGuardFiles, ...preCompactFiles, ...statusLineFiles]));
}

async function installClaudeCodeStatusLine(
  context: { somaHome: string; somaRepoPath: string; substrateHome: string },
): Promise<string[]> {
  const scriptPath = resolve(context.substrateHome, SOMA_CLAUDE_STATUSLINE_RELATIVE_PATH);

  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, renderClaudeCodeStatusLineScript(context.somaHome), { encoding: "utf8", mode: 0o755 });
  await chmod(scriptPath, 0o755);

  const settingsFiles = await patchClaudeCodeStatusLineSettings(context.substrateHome, scriptPath);
  return [scriptPath, ...settingsFiles];
}

async function installClaudeCodePolicyGuardHook(
  context: { somaHome: string; somaRepoPath: string; substrateHome: string },
  config: { somaHome: string; trustedSomaRepo: string; bunPath: string },
  bunPath: string,
): Promise<string[]> {
  const hookPath = resolve(context.substrateHome, SOMA_CLAUDE_POLICY_GUARD_RELATIVE_PATH);
  const configPath = resolve(context.substrateHome, SOMA_CLAUDE_POLICY_GUARD_CONFIG_RELATIVE_PATH);

  await installClaudeCodeHookAsset({
    hookPath,
    configPath,
    source: renderClaudeCodePolicyGuardHook(),
    config,
  });
  const settingsFiles = await patchClaudeCodePolicyGuardSettings(context.substrateHome, bunPath);
  return [hookPath, configPath, ...settingsFiles];
}

async function installClaudeCodePreCompactHook(
  context: { somaHome: string; somaRepoPath: string; substrateHome: string },
  config: { somaHome: string; trustedSomaRepo: string; bunPath: string },
  bunPath: string,
): Promise<string[]> {
  const hookPath = resolve(context.substrateHome, SOMA_CLAUDE_PRECOMPACT_RELATIVE_PATH);
  const configPath = resolve(context.substrateHome, SOMA_CLAUDE_PRECOMPACT_CONFIG_RELATIVE_PATH);

  await installClaudeCodeHookAsset({
    hookPath,
    configPath,
    source: renderClaudeCodePreCompactHook(),
    config,
  });
  const settingsFiles = await patchClaudeCodePreCompactSettings(context.substrateHome, bunPath);
  return [hookPath, configPath, ...settingsFiles];
}

async function installClaudeCodeModeClassifierHook(
  context: { somaHome: string; somaRepoPath: string; substrateHome: string },
  config: { somaHome: string; trustedSomaRepo: string; bunPath: string },
  bunPath: string,
): Promise<string[]> {
  const hookPath = resolve(context.substrateHome, SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH);
  const configPath = resolve(context.substrateHome, SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH);

  await installClaudeCodeHookAsset({
    hookPath,
    configPath,
    source: renderClaudeCodeModeClassifierHook(),
    config,
  });
  const settingsFiles = await patchClaudeCodeModeClassifierSettings(context.substrateHome, bunPath);
  return [hookPath, configPath, ...settingsFiles];
}

async function installClaudeCodeHookAsset(input: {
  hookPath: string;
  configPath: string;
  source: string;
  config: unknown;
}): Promise<void> {
  await mkdir(dirname(input.hookPath), { recursive: true });
  await writeFile(input.hookPath, input.source, { encoding: "utf8", mode: 0o755 });
  await chmod(input.hookPath, 0o755);
  await writeFile(input.configPath, `${JSON.stringify(input.config, null, 2)}\n`, "utf8");
}

export async function removeClaudeCodeSomaHookFiles(substrateHome: string): Promise<string[]> {
  const removed: string[] = [];
  const installedBunPath = await readInstalledClaudeCodeHookBunPath(substrateHome);
  const installedModeClassifierBunPath = await readInstalledClaudeCodeModeClassifierBunPath(substrateHome);
  const installedPolicyGuardBunPath = await readInstalledClaudeCodePolicyGuardBunPath(substrateHome);
  const installedPreCompactBunPath = await readInstalledClaudeCodePreCompactBunPath(substrateHome);
  for (const relativePath of [
    SOMA_CLAUDE_HOOK_RELATIVE_PATH,
    SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
    SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH,
    SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH,
    SOMA_CLAUDE_POLICY_GUARD_RELATIVE_PATH,
    SOMA_CLAUDE_POLICY_GUARD_CONFIG_RELATIVE_PATH,
    SOMA_CLAUDE_PRECOMPACT_RELATIVE_PATH,
    SOMA_CLAUDE_PRECOMPACT_CONFIG_RELATIVE_PATH,
    SOMA_CLAUDE_STATUSLINE_RELATIVE_PATH,
  ]) {
    const target = resolve(substrateHome, relativePath);
    const exists = await stat(target).then(
      () => true,
      (error: unknown) => {
        if (isEnoent(error)) return false;
        throw error;
      },
    );
    if (!exists) continue;
    await rm(target, { force: true }).then(
      () => removed.push(target),
      (error: unknown) => {
        if (!isEnoent(error)) throw error;
      },
    );
  }
  removed.push(...(await unpatchClaudeCodeSomaHookSettings(substrateHome, installedBunPath)));
  removed.push(...(await unpatchClaudeCodeModeClassifierSettings(substrateHome, installedModeClassifierBunPath ?? installedBunPath)));
  removed.push(...(await unpatchClaudeCodePolicyGuardSettings(substrateHome, installedPolicyGuardBunPath ?? installedBunPath)));
  removed.push(...(await unpatchClaudeCodePreCompactSettings(substrateHome, installedPreCompactBunPath ?? installedBunPath)));
  // No bunPath drift concern here (the script is execed directly via its
  // shebang) — the target path is deterministic from substrateHome alone.
  removed.push(
    ...(await unpatchClaudeCodeStatusLineSettings(substrateHome, resolve(substrateHome, SOMA_CLAUDE_STATUSLINE_RELATIVE_PATH))),
  );
  return Array.from(new Set(removed));
}

async function readInstalledClaudeCodeHookBunPath(substrateHome: string): Promise<string | undefined> {
  return readInstalledClaudeCodeHookConfigBunPath(substrateHome, SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH);
}

async function readInstalledClaudeCodePolicyGuardBunPath(substrateHome: string): Promise<string | undefined> {
  return readInstalledClaudeCodeHookConfigBunPath(substrateHome, SOMA_CLAUDE_POLICY_GUARD_CONFIG_RELATIVE_PATH);
}

async function readInstalledClaudeCodeModeClassifierBunPath(substrateHome: string): Promise<string | undefined> {
  return readInstalledClaudeCodeHookConfigBunPath(substrateHome, SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH);
}

async function readInstalledClaudeCodePreCompactBunPath(substrateHome: string): Promise<string | undefined> {
  return readInstalledClaudeCodeHookConfigBunPath(substrateHome, SOMA_CLAUDE_PRECOMPACT_CONFIG_RELATIVE_PATH);
}

async function readInstalledClaudeCodeHookConfigBunPath(substrateHome: string, relativePath: string): Promise<string | undefined> {
  const configPath = resolve(substrateHome, relativePath);
  const content = await readFile(configPath, "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (content === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (isObject(parsed) && typeof parsed.bunPath === "string" && parsed.bunPath.trim().length > 0) {
      return parsed.bunPath;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function renderClaudeCodeSomaHook(): string {
  const runnerHandlers = Object.fromEntries(SOMA_CLAUDE_HOOK_EVENTS.map((event) => [event.commandEvent, event.runner]));
  const source = readFileSync(new URL("./hook-runner.mjs", import.meta.url), "utf8");
  const rendered = source.replace("__SOMA_CLAUDE_HOOK_EVENT_HANDLERS__", JSON.stringify(runnerHandlers, null, 2));
  if (rendered === source) throw new Error("Claude Code hook runner asset is missing the handler placeholder.");
  return rendered;
}

function renderClaudeCodeModeClassifierHook(): string {
  return readFileSync(new URL("./mode-classifier-hook.mjs", import.meta.url), "utf8");
}

function renderClaudeCodePolicyGuardHook(): string {
  return readFileSync(new URL("./policy-guard-hook.mjs", import.meta.url), "utf8");
}

function renderClaudeCodePreCompactHook(): string {
  return readFileSync(new URL("./precompact-hook.mjs", import.meta.url), "utf8");
}

// Bakes the resolved soma-home path into the bundled statusline asset so a
// custom `--soma-home` (or a substrate-home-only reproject) still finds the
// right STATE dir, while the script's own `SOMA_HOME` env override keeps
// working (the substituted value is only the *default*). Mirrors
// renderClaudeCodeSomaHook's placeholder-substitution + missing-placeholder
// guard.
//
// The placeholder sits inside a double-quoted shell string
// (`SOMA_HOME="${SOMA_HOME:-<value>}"`), so a path containing `\`, `"`, `$`,
// or a backtick would otherwise break out or inject. Backslash-escape all four
// (backslash FIRST so we don't double-escape the escapes we add) so the shell
// reads them literally. A function replacer also avoids `$`-pattern corruption
// from String.replace's special `$&`/`$1` handling on the replacement side.
function renderClaudeCodeStatusLineScript(somaHome: string): string {
  const source = readFileSync(new URL("./statusline.sh", import.meta.url), "utf8");
  const escaped = somaHome.replace(/[\\"$`]/g, "\\$&");
  const rendered = source.replace("__SOMA_HOME__", () => escaped);
  if (rendered === source) throw new Error("Claude Code status line asset is missing the SOMA_HOME placeholder.");
  return rendered;
}
