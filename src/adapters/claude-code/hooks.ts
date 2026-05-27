import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveBunExecutable } from "../../bun-probe";
import { isEnoent } from "../../fs-errors";

export const SOMA_CLAUDE_HOOK_RELATIVE_PATH = "hooks/soma/soma-claude-code-hook.mjs";
export const SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH = "hooks/soma/soma-claude-code-hook.config.json";
const SOMA_CLAUDE_SETTINGS_RELATIVE_PATH = "settings.json";

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

function appendSomaHookGroup(settings: JsonObject, input: (typeof SOMA_CLAUDE_HOOK_EVENTS)[number], substrateHome: string, bunPath: string): boolean {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const eventGroups = Array.isArray(hooks[input.event]) ? hooks[input.event] as unknown[] : [];
  const knownCommands = somaHookCommands(substrateHome, bunPath);

  for (const group of eventGroups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    if (group.hooks.some((hook) => isObject(hook) && typeof hook.command === "string" && knownCommands.has(hook.command))) {
      settings.hooks = hooks;
      return false;
    }
  }

  eventGroups.push({
    description: `Soma: ${input.summary}`,
    ...("matcher" in input ? { matcher: input.matcher } : {}),
    hooks: [somaHookEntry(substrateHome, bunPath, input.commandEvent)],
  });
  hooks[input.event] = eventGroups;
  settings.hooks = hooks;
  return true;
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

export async function unpatchClaudeCodeSomaHookSettings(substrateHome: string, bunPath = resolveBunExecutable()): Promise<string[]> {
  const settingsPath = resolve(substrateHome, SOMA_CLAUDE_SETTINGS_RELATIVE_PATH);
  const { before, settings } = await readSettingsWithRaw(settingsPath);
  if (before.trim().length === 0) return [];
  if (!removeSomaHooksFromSettings(settings, substrateHome, bunPath)) return [];
  return writeJsonIfChanged(settingsPath, settings, before);
}

export async function installClaudeCodeSomaHooks(context: {
  somaHome: string;
  somaRepoPath: string;
  substrateHome: string;
}): Promise<string[]> {
  const hookPath = resolve(context.substrateHome, SOMA_CLAUDE_HOOK_RELATIVE_PATH);
  const configPath = resolve(context.substrateHome, SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH);
  const bunPath = resolveBunExecutable();
  const config = {
    somaHome: context.somaHome,
    trustedSomaRepo: context.somaRepoPath,
    bunPath,
  };

  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, renderClaudeCodeSomaHook(), { encoding: "utf8", mode: 0o755 });
  await chmod(hookPath, 0o755);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const settingsFiles = await patchClaudeCodeSomaHookSettings(context.substrateHome, bunPath);
  return [hookPath, configPath, ...settingsFiles];
}

export async function removeClaudeCodeSomaHookFiles(substrateHome: string): Promise<string[]> {
  const removed: string[] = [];
  const installedBunPath = await readInstalledClaudeCodeHookBunPath(substrateHome);
  for (const relativePath of [SOMA_CLAUDE_HOOK_RELATIVE_PATH, SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH]) {
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
  return removed;
}

async function readInstalledClaudeCodeHookBunPath(substrateHome: string): Promise<string | undefined> {
  const configPath = resolve(substrateHome, SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH);
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
