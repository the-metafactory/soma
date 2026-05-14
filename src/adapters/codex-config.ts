import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function configureCodexInstall(codexHome: string, somaHome: string): Promise<string> {
  const path = join(codexHome, "config.toml");
  const existing = await readFile(path, "utf8").catch(() => "");
  let next = enableCodexHooksFeature(existing);
  next = upsertCodexWritableRoot(next, somaHome);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next.trimEnd() + "\n", "utf8");

  return path;
}

function enableCodexHooksFeature(config: string): string {
  const section = findTomlSection(config, "features");

  if (section === undefined) {
    return `${config.trimEnd()}\n\n[features]\nhooks = true\n`;
  }

  let next = config;
  let current = findTomlSection(next, "features");
  if (current === undefined) return next;

  const body = next.slice(current.bodyStart, current.bodyEnd);
  const hooks = findTomlKey(body, "hooks");
  const deprecatedHooks = findTomlKey(body, "codex_hooks");

  if (hooks !== undefined) {
    next = replaceSectionKey(next, current, hooks, "hooks = true");
  } else if (deprecatedHooks !== undefined) {
    next = replaceSectionKey(next, current, deprecatedHooks, "hooks = true");
  } else {
    next = insertSectionKey(next, current, "hooks = true");
  }

  current = findTomlSection(next, "features");
  if (current === undefined) return next;

  const nextBody = next.slice(current.bodyStart, current.bodyEnd);
  const staleDeprecatedHooks = findTomlKey(nextBody, "codex_hooks");
  return staleDeprecatedHooks === undefined ? next : removeSectionKey(next, current, staleDeprecatedHooks);
}

function upsertCodexWritableRoot(config: string, somaHome: string): string {
  const section = findTomlSection(config, "sandbox_workspace_write");

  if (section === undefined) {
    return `${config.trimEnd()}\n\n[sandbox_workspace_write]\nwritable_roots = [${quoteTomlString(somaHome)}]\n`;
  }

  const body = config.slice(section.bodyStart, section.bodyEnd);
  const key = findTomlKey(body, "writable_roots");

  if (key === undefined) {
    return insertSectionKey(config, section, `writable_roots = [${quoteTomlString(somaHome)}]`);
  }

  const roots = parseTomlStringArray(key.value);
  if (!roots.includes(somaHome)) {
    roots.push(somaHome);
  }

  return replaceSectionKey(config, section, key, `writable_roots = [${roots.map(quoteTomlString).join(", ")}]`);
}

function replaceSectionKey(config: string, section: TomlSection, key: TomlKey, replacement: string): string {
  const start = section.bodyStart + key.start;
  const end = section.bodyStart + key.end;
  return `${config.slice(0, start)}${replacement}${config.slice(end)}`;
}

function removeSectionKey(config: string, section: TomlSection, key: TomlKey): string {
  const start = section.bodyStart + key.start;
  let end = section.bodyStart + key.end;
  if (config[end] === "\n") end += 1;
  return `${config.slice(0, start)}${config.slice(end)}`;
}

function insertSectionKey(config: string, section: TomlSection, line: string): string {
  const needsHeaderNewline = section.headerEnd === 0 || config[section.headerEnd - 1] !== "\n";
  const prefix = `${config.slice(0, section.headerEnd)}${needsHeaderNewline ? "\n" : ""}`;
  return `${prefix}${line}\n${config.slice(section.headerEnd)}`;
}

interface TomlSection {
  bodyStart: number;
  bodyEnd: number;
  headerEnd: number;
}

interface TomlKey {
  start: number;
  end: number;
  value: string;
}

function findTomlSection(config: string, name: string): TomlSection | undefined {
  const headerPattern = new RegExp(`^\\[${escapeRegExp(name)}\\]\\s*$`, "m");
  const header = headerPattern.exec(config);

  if (header === null) {
    return undefined;
  }

  const headerEnd = header.index + header[0].length + (config[header.index + header[0].length] === "\n" ? 1 : 0);
  const rest = config.slice(headerEnd);
  const nextHeader = /^(?:\[[^\]\n]+\]|\[\[[^\]\n]+\]\])\s*$/m.exec(rest);
  const bodyEnd = nextHeader?.index === undefined ? config.length : headerEnd + nextHeader.index;

  return {
    bodyStart: headerEnd,
    bodyEnd,
    headerEnd,
  };
}

function findTomlKey(config: string, key: string): TomlKey | undefined {
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*`, "m");
  const match = keyPattern.exec(config);

  if (match === null) {
    return undefined;
  }

  const valueStart = match.index + match[0].length;
  const end = config[valueStart] === "[" ? findTomlArrayEnd(config, valueStart) : findTomlLineEnd(config, valueStart);

  return {
    start: match.index,
    end,
    value: config.slice(valueStart, end).trim(),
  };
}

function findTomlArrayEnd(config: string, start: number): number {
  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = start; index < config.length; index += 1) {
    const char = config[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return findTomlLineEnd(config, start);
}

function findTomlLineEnd(config: string, start: number): number {
  const newline = config.indexOf("\n", start);
  return newline === -1 ? config.length : newline;
}

function parseTomlStringArray(value: string): string[] {
  const roots: string[] = [];
  const stringPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;

  while ((match = stringPattern.exec(value)) !== null) {
    const root = match[0].startsWith("'") ? match[2] : match[1];
    roots.push(root.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }

  return roots;
}

function quoteTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
