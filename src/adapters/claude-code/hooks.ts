import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveBunExecutable } from "../../bun-probe";
import { isEnoent } from "../../fs-errors";
import { isClaudeCodeInstallOptions } from "./install-options";

export const SOMA_CLAUDE_HOOK_RELATIVE_PATH = "hooks/soma/soma-claude-code-hook.mjs";
export const SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH = "hooks/soma/soma-claude-code-hook.config.json";
export const SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH = "hooks/soma/soma-mode-classifier.mjs";
export const SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH = "hooks/soma/soma-mode-classifier.config.json";
const SOMA_CLAUDE_SETTINGS_RELATIVE_PATH = "settings.json";
const SOMA_DISABLED_HOOKS_KEY = "somaDisabledHooks";
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
  if (!isObject(settings[SOMA_DISABLED_HOOKS_KEY])) return [];
  const stored = settings[SOMA_DISABLED_HOOKS_KEY][PAI_MODE_CLASSIFIER_KEY];
  return Array.isArray(stored) ? stored : [];
}

function setDisabledPaiModeClassifierGroups(settings: JsonObject, groups: unknown[]): void {
  const disabled = isObject(settings[SOMA_DISABLED_HOOKS_KEY]) ? settings[SOMA_DISABLED_HOOKS_KEY] : {};
  if (groups.length === 0) {
    Reflect.deleteProperty(disabled, PAI_MODE_CLASSIFIER_KEY);
  } else {
    disabled[PAI_MODE_CLASSIFIER_KEY] = groups;
  }
  if (Object.keys(disabled).length === 0) {
    Reflect.deleteProperty(settings, SOMA_DISABLED_HOOKS_KEY);
  } else {
    settings[SOMA_DISABLED_HOOKS_KEY] = disabled;
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
  const modeClassifierFiles = isClaudeCodeInstallOptions(context.options) && context.options.modeClassifier === true
    ? await installClaudeCodeModeClassifierHook(context, config, bunPath)
    : [];
  return Array.from(new Set([hookPath, configPath, ...settingsFiles, ...modeClassifierFiles]));
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
  for (const relativePath of [
    SOMA_CLAUDE_HOOK_RELATIVE_PATH,
    SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
    SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH,
    SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH,
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
  return Array.from(new Set(removed));
}

async function readInstalledClaudeCodeHookBunPath(substrateHome: string): Promise<string | undefined> {
  return readInstalledClaudeCodeHookConfigBunPath(substrateHome, SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH);
}

async function readInstalledClaudeCodeModeClassifierBunPath(substrateHome: string): Promise<string | undefined> {
  return readInstalledClaudeCodeHookConfigBunPath(substrateHome, SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH);
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
