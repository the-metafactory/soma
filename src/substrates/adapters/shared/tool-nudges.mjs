import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function absent(error) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function installed(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}

// A routing lexer, not a shell evaluator. Quotes keep arguments together;
// heredoc bodies and comments are never executable command candidates.
export function shellCommands(source) {
  const text = source.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n[\t ]*\1\b/g, " __heredoc__\n");
  const commands = [];
  let words = [];
  let word = "";
  let quoted = false;
  let quote = "";
  const finishWord = () => {
    if (word || quoted) words.push({ value: word, quoted });
    word = "";
    quoted = false;
  };
  const finishCommand = () => {
    finishWord();
    while (words[0] && /^(?:[A-Za-z_][\w]*=|then$|do$|if$|elif$|!$)/.test(words[0].value)) words.shift();
    if (words[0]?.value === "rtk") {
      words.shift();
      if (words[0]?.value === "proxy") words.shift();
    }
    if (words[0] && !words[0].quoted) commands.push(words.map(({ value }) => value.replace(/\s/g, "_")).join(" "));
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"') word += text[++i] ?? "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quoted = true;
      quote = char;
    } else if (char === "\\") {
      const next = text[++i];
      if (next !== "\n") word += next ?? "";
    } else if (char === "#" && !word) {
      while (i < text.length && text[i] !== "\n") i++;
      finishCommand();
    } else if (char === "$" && text[i + 1] === "(") {
      finishCommand();
      i++;
    } else if (/[;&|(){}\n]/.test(char)) {
      finishCommand();
    } else if (/\s/.test(char)) {
      finishWord();
    } else {
      word += char;
    }
  }
  finishCommand();
  return commands;
}

function canonicalTool(tool, input) {
  const name = tool.split(/[.:]/).pop().toLowerCase();
  if (/^(bash|shell|shell_command|exec_command)$/.test(name)) return "Bash";
  if (/^(agent|task|subagent|wait_agent)$/.test(name)) return "Agent";
  if (name === "wait" && isRecord(input) && Array.isArray(input.ids) && input.ids.every((id) => typeof id === "string")) return "Agent";
  return tool;
}

function commandText(input) {
  if (!isRecord(input)) return "";
  if (typeof input.cmd === "string") return input.cmd;
  if (typeof input.command === "string") return input.command;
  if (Array.isArray(input.command) && input.command.every((part) => typeof part === "string")) {
    const [shell, flag, command] = input.command;
    if (/(?:^|\/)(?:ba|z|da)?sh$/.test(shell ?? "") && /^-[a-z]*c[a-z]*$/.test(flag ?? "")) return command ?? "";
  }
  return "";
}

export function toolNudgeLines(somaHome, tool, input) {
  if (typeof somaHome !== "string" || typeof tool !== "string") return [];
  let rules;
  try {
    rules = JSON.parse(readFileSync(join(somaHome, "runtime/tool-nudges.json"), "utf8"));
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
  if (!Array.isArray(rules)) throw new Error("Soma tool nudge rules must be an array");
  const name = canonicalTool(tool, input);
  const commands = shellCommands(commandText(input));
  return rules.flatMap((rule) => {
    if (!isRecord(rule) || typeof rule.tool !== "string" || typeof rule.file !== "string" || typeof rule.text !== "string" ||
        (rule.command !== undefined && typeof rule.command !== "string")) throw new Error("Invalid Soma tool nudge rule");
    if (!new RegExp(rule.tool).test(name)) return [];
    if (rule.command !== undefined && !commands.some((command) => new RegExp(rule.command).exec(command)?.index === 0)) return [];
    const path = resolve(somaHome, rule.file);
    const rel = relative(resolve(somaHome), path);
    if (isAbsolute(rule.file) || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Nudge target escapes Soma home");
    return installed(path) ? [rule.text.replaceAll("{path}", path)] : [];
  });
}
