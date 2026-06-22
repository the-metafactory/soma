import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isEnoent, pathExists } from "../../fs-utils";
import type { SomaDoctorFinding } from "../../types";
import { GROK_AGENTS_BLOCK_BEGIN } from "./config-patch";
import { GROK_HOOK_FILE_MARKERS, GROK_PROJECTED_SKILL_NAMES } from "./install";

const execFileAsync = promisify(execFile);

/**
 * Grok doctor: instead of the mtime heuristic the codex doctor
 * uses, ask Grok's own discovery oracle — `grok inspect --json` — whether
 * the Soma projection is actually loaded: the projected skills appear in
 * `skills[]`, the patched `~/.grok/AGENTS.md` appears in
 * `projectInstructions[]` (and still carries the Soma pointer block), and
 * the Soma lifecycle hook appears in `hooks[]`. Tests inject fixture JSON
 * via `runInspect`; nothing here requires a live `grok` binary.
 */

// The skills the projection installs under `~/.grok/skills/`, derived from
// the install spec's static file list so the doctor can never drift from
// what install actually writes.
const REQUIRED_SKILL_NAMES = GROK_PROJECTED_SKILL_NAMES;

// The Soma lifecycle hook ships as `~/.grok/hooks/soma-lifecycle.json`
// whose commands invoke `soma-lifecycle.mjs`, so this substring in a hook
// entry's target is the "Soma hook is registered" signal.
export const SOMA_GROK_HOOK_TARGET_MARKER = "soma-lifecycle";

const GROK_INSPECT_TIMEOUT_MS = 30_000;
const GROK_INSPECT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Returns `grok inspect --json` stdout, or null when no Grok binary is
 * installed. May throw when the binary exists but the probe fails.
 */
export type GrokInspectRunner = (homeDir: string) => Promise<string | null>;

async function runGrokInspectBinary(homeDir: string): Promise<string | null> {
  const binary = join(homeDir, ".grok/bin", process.platform === "win32" ? "grok.exe" : "grok");
  if (!(await pathExists(binary))) return null;
  const { stdout } = await execFileAsync(binary, ["inspect", "--json"], {
    cwd: homeDir,
    encoding: "utf8",
    timeout: GROK_INSPECT_TIMEOUT_MS,
    maxBuffer: GROK_INSPECT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

interface GrokInspectReport {
  projectInstructions: { path: string; scope: string }[];
  skills: { name: string; sourcePath: string }[];
  hooks: { target: string }[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function parseInspectReport(raw: string): GrokInspectReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return {
    projectInstructions: asRecords(record.projectInstructions).map((entry) => ({
      path: asString(entry.path),
      scope: asString(entry.scope),
    })),
    skills: asRecords(record.skills).map((entry) => {
      const source = typeof entry.source === "object" && entry.source !== null
        ? (entry.source as Record<string, unknown>)
        : {};
      return { name: asString(entry.name), sourcePath: asString(source.path) };
    }),
    hooks: asRecords(record.hooks).map((entry) => ({ target: asString(entry.target) })),
  };
}

/**
 * Grok reports discovered paths in OS form — on Windows often with the
 * extended-length `\\?\` prefix and filesystem casing (`Agents.md`).
 * Normalize both sides before comparing: strip the prefix, forward-slash
 * the separators, lowercase.
 */
function normalizeInspectPath(value: string): string {
  return value.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Hook-file integrity (fail-open mitigation): the soma-lifecycle hook is a
 * static ESM import graph under `~/.grok/hooks/` — a missing or
 * foreign-owned sibling crashes module load before the entry's deny
 * backstop can run, and grok then fails OPEN (the tool call is allowed).
 * Whenever any Soma hook file is present on disk, the full set must be
 * present and carry its Soma ownership marker. A hooks directory with no
 * Soma files at all means "not installed" and stays silent — the
 * inspect-based drift checks own that case. Purely filesystem-based, so
 * it runs even when no grok binary is available.
 */
async function diagnoseGrokHookFileIntegrity(homeDir: string): Promise<SomaDoctorFinding[]> {
  const hooksDir = join(homeDir, ".grok/hooks");
  const entries = Object.entries(GROK_HOOK_FILE_MARKERS);
  const contents = await Promise.all(entries.map(([file]) => readFileOrNull(join(hooksDir, file))));

  if (contents.every((content) => content === null)) return [];

  const problems: string[] = [];
  entries.forEach(([file, marker], index) => {
    const content = contents[index];
    if (content === null) problems.push(`${file} is missing`);
    else if (!content.includes(marker)) problems.push(`${file} lacks its Soma ownership marker`);
  });
  if (problems.length === 0) return [];

  return [{
    id: "grok-hook-files-incomplete",
    severity: "warning",
    message: `Soma hook files under ~/.grok/hooks are incomplete or not Soma-owned: ${problems.join("; ")}. A missing or foreign hook sibling crashes the hook's import graph before its deny backstop runs, so grok FAILS OPEN (tool calls execute unchecked).`,
    action: "soma reproject grok",
  }];
}

/**
 * Hook-interpreter presence (fail-open drift detection):
 * the hook registration freezes an absolute interpreter path as the
 * first bare-exec token of every command (`<bunPath> <module> <verb>`).
 * Install-time validation and the post-install smoke prove it
 * at freeze time, but the binary can vanish LATER — a bun upgrade that
 * relays the scoop directory, an uninstall — and on grok's fail-open
 * platform the hooks then silently stop firing. Verify the first token
 * of each registered command still resolves on disk. A missing
 * registration file means "not installed" and stays silent. Purely
 * filesystem-based, so it runs on every doctor path.
 */
function registeredHookInterpreters(parsed: { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> }): Set<string> {
  const commands = Object.values(parsed.hooks ?? {})
    .filter((entries): entries is { hooks?: { command?: unknown }[] }[] => Array.isArray(entries))
    .flat()
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command)
    .filter((command): command is string => typeof command === "string");
  const interpreters = commands
    .map((command) => command.split(" ")[0])
    .filter((token): token is string => token !== undefined && token.length > 0);
  return new Set(interpreters);
}

async function diagnoseGrokHookInterpreters(homeDir: string): Promise<SomaDoctorFinding[]> {
  const registration = await readFileOrNull(join(homeDir, ".grok/hooks/soma-lifecycle.json"));
  if (registration === null) return [];

  let parsed: { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> };
  try {
    parsed = JSON.parse(registration) as typeof parsed;
  } catch {
    return []; // corrupt registration is the integrity check's finding, not ours
  }

  const missing: string[] = [];
  for (const interpreter of registeredHookInterpreters(parsed)) {
    if (!(await pathExists(interpreter))) missing.push(interpreter);
  }
  if (missing.length === 0) return [];

  return [{
    id: "grok-hook-interpreter-missing",
    severity: "warning",
    message: `The interpreter frozen into the registered grok hook commands no longer exists on disk: ${missing.join("; ")}. Grok's hook platform is fail-open — a command that cannot launch is silently allowed, so Soma's policy gate is currently DISABLED. Usually caused by a bun upgrade or relocation after install.`,
    action: "soma reproject grok",
  }];
}

export async function diagnoseGrokProjectionDrift(options: {
  homeDir: string;
  runInspect?: GrokInspectRunner;
}): Promise<SomaDoctorFinding[]> {
  const runInspect = options.runInspect ?? runGrokInspectBinary;
  const integrityFindings = [
    ...(await diagnoseGrokHookFileIntegrity(options.homeDir)),
    ...(await diagnoseGrokHookInterpreters(options.homeDir)),
  ];

  let raw: string | null;
  try {
    raw = await runInspect(options.homeDir);
  } catch (error) {
    return [...integrityFindings, {
      id: "grok-inspect-unavailable",
      severity: "warning",
      // The human repair guidance lives in `message`; `action` is an
      // executable `soma` command so an agent following the established
      // pattern re-runs the check instead of trying to exec prose.
      message: `\`grok inspect --json\` failed: ${error instanceof Error ? error.message : String(error)}. Run \`grok inspect --json\` manually and repair the Grok install, then re-run.`,
      action: "soma doctor --substrate grok",
    }];
  }
  if (raw === null) {
    return [...integrityFindings, {
      id: "grok-inspect-unavailable",
      severity: "info",
      message: "Grok binary not found — skipped `grok inspect` discovery checks. Install the Grok CLI to enable them.",
      action: "soma doctor --substrate grok",
    }];
  }

  const report = parseInspectReport(raw);
  if (report === null) {
    return [...integrityFindings, {
      id: "grok-inspect-unavailable",
      severity: "warning",
      message: "`grok inspect --json` returned unparseable output. Run `grok inspect --json` manually and repair the Grok install, then re-run.",
      action: "soma doctor --substrate grok",
    }];
  }

  const findings: SomaDoctorFinding[] = [];
  const problems: string[] = [];

  const skillsRoot = `${normalizeInspectPath(join(options.homeDir, ".grok/skills"))}/`;
  const discoveredSkills = new Set(
    report.skills
      .filter((skill) => normalizeInspectPath(skill.sourcePath).startsWith(skillsRoot))
      .map((skill) => skill.name.toLowerCase()),
  );
  const missingSkills = REQUIRED_SKILL_NAMES.filter((name) => !discoveredSkills.has(name.toLowerCase()));
  if (missingSkills.length > 0) {
    problems.push(`Grok does not discover the projected skill(s): ${missingSkills.join(", ")}.`);
  }

  const agentsPath = join(options.homeDir, ".grok/AGENTS.md");
  const normalizedAgentsPath = normalizeInspectPath(agentsPath);
  const agentsDiscovered = report.projectInstructions.some(
    (entry) => entry.scope === "global" && normalizeInspectPath(entry.path) === normalizedAgentsPath,
  );
  if (!agentsDiscovered) {
    problems.push("Grok does not list ~/.grok/AGENTS.md among its discovered instructions.");
  }

  const agentsContent = await readFileOrNull(agentsPath);
  if (!agentsContent?.includes(GROK_AGENTS_BLOCK_BEGIN)) {
    problems.push("~/.grok/AGENTS.md is missing the Soma pointer block.");
  }

  if (problems.length > 0) {
    findings.push({
      id: "grok-projection-stale",
      severity: "warning",
      message: problems.join(" "),
      action: "soma reproject grok",
    });
  }

  const hookRegistered = report.hooks.some((hook) => hook.target.includes(SOMA_GROK_HOOK_TARGET_MARKER));
  if (!hookRegistered) {
    findings.push({
      id: "grok-hook-missing",
      severity: "warning",
      message: "Grok does not register the Soma lifecycle hook.",
      action: "soma install grok --apply",
    });
  }

  return [...integrityFindings, ...findings];
}
