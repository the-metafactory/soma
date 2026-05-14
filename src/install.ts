import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { installCodexHomeProjection, installPiDevHomeProjection } from "./home-projection";
import { buildSomaStartupContext, runSomaLifecycleAlgorithmUpdated } from "./lifecycle";
import { bootstrapSomaHome } from "./soma-home";
import type { SomaInstallOptions, SomaInstallPlan, SomaInstallResult } from "./types";

const SOMA_BOOTSTRAP_FILES = [
  "profile/assistant.md",
  "profile/principal.md",
  "profile/telos.md",
  "policy/README.md",
  "skills/README.md",
  "projections/README.md",
] as const;

const SOMA_BOOTSTRAP_DIRECTORIES = [
  "memory/WORK",
  "memory/KNOWLEDGE",
  "memory/LEARNING",
  "memory/RELATIONSHIP",
  "memory/STATE",
  "projections/codex",
  "projections/pi-dev",
  "projections/claude-code",
] as const;

const CODEX_HOME_FILES = [
  "rules/soma.rules",
  "hooks.json",
  "hooks/soma-lifecycle.mjs",
  "skills/soma/SKILL.md",
  "memories/soma/profile.md",
  "memories/soma/startup-context.md",
  "memories/soma/lifecycle.md",
  "memories/soma/memory-layout.md",
  "memories/soma/pai-imports.md",
  "memories/soma/skills.md",
  "memories/soma/policy.md",
] as const;

const PI_DEV_HOME_FILES = [
  "agent/extensions/soma.ts",
  "agent/soma/context.md",
  "agent/soma/profile.md",
  "agent/soma/startup-context.md",
  "agent/soma/memory-layout.md",
  "agent/soma/pai-imports.md",
  "agent/soma/tools.md",
  "agent/soma/skills.md",
  "agent/soma/policy.md",
  "agent/skills/soma/SKILL.md",
] as const;

function resolveInstallHomes(substrate: "codex" | "pi-dev", options: SomaInstallOptions): { somaHome: string; substrateHome: string } {
  const homeDir = options.homeDir;
  const defaultSubstrateHome = substrate === "codex" ? ".codex" : ".pi";
  const somaHome = options.somaHome ?? `${homeDir ?? "~"}/.soma`;
  const substrateHome = options.substrateHome ?? `${homeDir ?? "~"}/${defaultSubstrateHome}`;

  return {
    somaHome,
    substrateHome,
  };
}

function planSomaInstall(
  substrate: "codex" | "pi-dev",
  substrateFiles: readonly string[],
  options: SomaInstallOptions = {},
): SomaInstallPlan {
  const homes = resolveInstallHomes(substrate, options);

  return {
    substrate,
    apply: false,
    somaHome: homes.somaHome,
    substrateHome: homes.substrateHome,
    somaDirectories: SOMA_BOOTSTRAP_DIRECTORIES.map((path) => `${homes.somaHome}/${path}`),
    somaFiles: SOMA_BOOTSTRAP_FILES.map((path) => `${homes.somaHome}/${path}`),
    substrateFiles: substrateFiles.map((path) => `${homes.substrateHome}/${path}`),
  };
}

export function planSomaForCodexInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  return planSomaInstall("codex", CODEX_HOME_FILES, options);
}

export function planSomaForPiDevInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  return planSomaInstall("pi-dev", PI_DEV_HOME_FILES, options);
}

async function installSomaForSubstrate(
  substrate: "codex" | "pi-dev",
  options: SomaInstallOptions = {},
): Promise<SomaInstallResult> {
  const somaHome = await bootstrapSomaHome(options);
  const projectionOptions = {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrateHome: options.substrateHome,
  };
  const substrateHome =
    substrate === "codex"
      ? await installCodexHomeProjection(somaHome.context, projectionOptions)
      : await installPiDevHomeProjection(somaHome.context, projectionOptions);
  const configFiles = substrate === "codex" ? [await configureCodexInstall(substrateHome.rootDir, somaHome.somaHome)] : [];
  const lifecycleFiles = await installLifecycleProjection(substrate, substrateHome.rootDir, {
    homeDir: options.homeDir,
    somaHome: somaHome.somaHome,
    substrate,
  });

  return {
    substrate,
    somaHome,
    substrateHome: {
      ...substrateHome,
      files: [...substrateHome.files, ...configFiles, ...lifecycleFiles],
    },
  };
}

async function configureCodexInstall(codexHome: string, somaHome: string): Promise<string> {
  const path = join(codexHome, "config.toml");
  const existing = await readFile(path, "utf8").catch(() => "");
  let next = enableCodexHooksFeature(existing);
  next = enableCodexWorkspaceWrite(next, somaHome);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next.trimEnd() + "\n", "utf8");

  return path;
}

function enableCodexHooksFeature(config: string): string {
  let next = config;

  if (!/^\[features\]$/m.test(next)) {
    next = `${next.trimEnd()}\n\n[features]\nhooks = true\n`;
  } else if (/^codex_hooks\s*=/m.test(next)) {
    next = next.replace(/^codex_hooks\s*=.*$/m, "hooks = true");
  } else if (!/^hooks\s*=/m.test(next)) {
    next = next.replace(/^\[features\]$/m, "[features]\nhooks = true");
  } else {
    next = next.replace(/^hooks\s*=.*$/m, "hooks = true");
  }

  return next;
}

function enableCodexWorkspaceWrite(config: string, somaHome: string): string {
  let next = ensureTopLevelCodexSandboxMode(config);
  next = upsertCodexWritableRoot(next, somaHome);

  return next;
}

function ensureTopLevelCodexSandboxMode(config: string): string {
  if (/^sandbox_mode\s*=/m.test(config)) {
    return config;
  }

  const trimmed = config.trimStart();
  const leading = config.slice(0, config.length - trimmed.length);
  return `${leading}sandbox_mode = "workspace-write"\n\n${trimmed}`;
}

function upsertCodexWritableRoot(config: string, somaHome: string): string {
  const section = findTomlSection(config, "sandbox_workspace_write");

  if (section === undefined) {
    return `${config.trimEnd()}\n\n[sandbox_workspace_write]\nwritable_roots = [${quoteTomlString(somaHome)}]\n`;
  }

  const body = config.slice(section.bodyStart, section.bodyEnd);
  const match = /^writable_roots\s*=\s*(\[.*\])\s*$/m.exec(body);

  if (match === null) {
    const insertAt = section.headerEnd;
    return `${config.slice(0, insertAt)}writable_roots = [${quoteTomlString(somaHome)}]\n${config.slice(insertAt)}`;
  }

  const roots = parseTomlStringArray(match[1]);
  if (!roots.includes(somaHome)) {
    roots.push(somaHome);
  }

  const replacement = `writable_roots = [${roots.map(quoteTomlString).join(", ")}]`;
  const start = section.bodyStart + match.index;
  const end = start + match[0].length;
  return `${config.slice(0, start)}${replacement}${config.slice(end)}`;
}

function findTomlSection(config: string, name: string): { bodyStart: number; bodyEnd: number; headerEnd: number } | undefined {
  const headerPattern = new RegExp(`^\\[${escapeRegExp(name)}\\]\\s*$`, "m");
  const header = headerPattern.exec(config);

  if (header === null) {
    return undefined;
  }

  const headerEnd = header.index + header[0].length + (config[header.index + header[0].length] === "\n" ? 1 : 0);
  const rest = config.slice(headerEnd);
  const nextHeader = /^\[[^\]]+\]\s*$/m.exec(rest);
  const bodyEnd = nextHeader?.index === undefined ? config.length : headerEnd + nextHeader.index;

  return {
    bodyStart: headerEnd,
    bodyEnd,
    headerEnd,
  };
}

function parseTomlStringArray(value: string): string[] {
  const roots: string[] = [];
  const stringPattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;

  while ((match = stringPattern.exec(value)) !== null) {
    roots.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }

  return roots;
}

function quoteTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeProjectionFile(root: string, relativePath: string, content: string): Promise<string> {
  const path = join(root, relativePath);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${content.trimEnd()}\n`, "utf8");

  return path;
}

async function installLifecycleProjection(
  substrate: "codex" | "pi-dev",
  substrateHome: string,
  options: { homeDir?: string; somaHome: string; substrate: "codex" | "pi-dev" },
): Promise<string[]> {
  await runSomaLifecycleAlgorithmUpdated(options);
  const startup = await buildSomaStartupContext(options);
  const relativePath = substrate === "codex" ? "memories/soma/startup-context.md" : "agent/soma/startup-context.md";
  const files = [await writeProjectionFile(substrateHome, relativePath, startup.context)];

  if (substrate === "codex") {
    files.push(await writeProjectionFile(substrateHome, "memories/soma/soma-repo.txt", process.cwd()));
  }

  if (substrate === "pi-dev") {
    files.push(await writeProjectionFile(substrateHome, "agent/soma/soma-repo.txt", process.cwd()));
  }

  return files;
}

export async function installSomaForCodex(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("codex", options);
}

export async function installSomaForPiDev(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("pi-dev", options);
}
