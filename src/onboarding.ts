import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DOCTOR_UNSUPPORTED_DRIFT_MESSAGE, diagnoseProjectionDrift } from "./adapters/doctor";
import { installSomaForClaudeCode, installSomaForCodex, installSomaForCursor, installSomaForPiDev } from "./install";
import { migrateClaudeSkills } from "./claude-skills-migrator";
import { migratePai } from "./pai-migration";
import { isEnoent, pathExists, pathMtimeMs } from "./fs-utils";
import type {
  SomaDoctorDiagnosis,
  SomaDoctorFinding,
  SomaInitApplyResult,
  SomaInitPlan,
  SomaInitStep,
  SomaInitStepId,
  SomaOnboardingOptions,
  SubstrateId,
} from "./types";

type InitSubstrate = Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor">;

function resolveHomeDir(homeDir?: string): string {
  return resolve(homeDir ?? homedir());
}

function resolveSomaHome(options: SomaOnboardingOptions, homeDir: string): string {
  return resolve(options.somaHome ?? join(homeDir, ".soma"));
}

function initSubstrate(options: SomaOnboardingOptions): InitSubstrate {
  return options.substrate ?? "codex";
}

function installStepId(substrate: InitSubstrate): SomaInitStepId {
  return `install-${substrate}`;
}

function installCommand(substrate: InitSubstrate, apply: boolean): string {
  return `soma install ${substrate} ${apply ? "--apply" : "--dry-run"}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function sharedPathFlags(plan: { homeDir: string; somaHome: string }): string {
  return `--home-dir ${shellQuote(plan.homeDir)} --soma-home ${shellQuote(plan.somaHome)}`;
}

async function readOptionalTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return "";
    throw error;
  }
}

async function readOptionalDirEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function isStarterProfile(somaHome: string): Promise<boolean> {
  const principal = await readOptionalTextFile(join(somaHome, "profile/principal.md"));
  return principal.includes("status: starter-profile");
}

async function hasSkillDirs(somaHome: string): Promise<boolean> {
  const entries = await readOptionalDirEntries(join(somaHome, "skills"));
  return entries.some((entry) => entry.isDirectory());
}

async function hasAlgorithmSkill(somaHome: string): Promise<boolean> {
  return pathExists(join(somaHome, "skills/the-algorithm/SKILL.md"));
}

async function detectOnboarding(options: SomaOnboardingOptions): Promise<Omit<SomaInitPlan, "mode" | "steps">> {
  const homeDir = resolveHomeDir(options.homeDir);
  const somaHome = resolveSomaHome(options, homeDir);
  const substrate = initSubstrate(options);
  const paiInstall = join(homeDir, ".claude");
  const paiUserDir = join(paiInstall, "PAI/USER");
  const claudeSkillsDir = join(paiInstall, "skills");
  const coreUserDir = join(homeDir, ".config/pai/CORE_USER");
  const [
    paiPresent,
    paiUserPresent,
    claudeSkillsPresent,
    coreUserPresent,
    somaExists,
  ] = await Promise.all([
    pathExists(join(paiInstall, "PAI")),
    pathExists(paiUserDir),
    pathExists(claudeSkillsDir),
    pathExists(coreUserDir),
    pathExists(somaHome),
  ]);
  const [starterProfile, skillsPopulated, algorithmSkillPresent] = somaExists
    ? await Promise.all([
        isStarterProfile(somaHome),
        hasSkillDirs(somaHome),
        hasAlgorithmSkill(somaHome),
      ])
    : [false, false, false];

  return {
    homeDir,
    somaHome,
    substrate,
    detected: {
      paiInstall: paiPresent ? paiInstall : null,
      paiUserDir: paiUserPresent ? paiUserDir : null,
      claudeSkillsDir: claudeSkillsPresent ? claudeSkillsDir : null,
      coreUserDir: coreUserPresent ? coreUserDir : null,
    },
    soma: {
      exists: somaExists,
      starterProfile,
      skillsPopulated,
      algorithmSkillPresent,
    },
  };
}

export async function planSomaInit(options: SomaOnboardingOptions & { apply?: boolean } = {}): Promise<SomaInitPlan> {
  const detected = await detectOnboarding(options);
  const apply = options.apply === true;
  const modeFlag = apply ? "--apply" : "--dry-run";
  const steps: SomaInitStep[] = [];

  if (detected.detected.claudeSkillsDir) {
    steps.push({
      id: "migrate-claude-skills",
      command: `soma migrate claude-skills --from ${shellQuote(detected.detected.claudeSkillsDir)} ${modeFlag} ${sharedPathFlags(detected)}`,
      description: "Import portable Claude skills into the Soma skills tree.",
    });
  }

  if (detected.detected.paiInstall) {
    steps.push({
      id: "migrate-pai",
      command: `soma migrate pai --pai-install ${shellQuote(detected.detected.paiInstall)} ${modeFlag} ${sharedPathFlags(detected)}`,
      description: "Import PAI identity, Algorithm, memory, docs, and pack surfaces that are present.",
    });
  }

  steps.push({
    id: installStepId(detected.substrate),
    command: `${installCommand(detected.substrate, apply)} ${sharedPathFlags(detected)}`,
    description: "Project the Soma home into the selected host substrate.",
  });

  return {
    ...detected,
    mode: apply ? "apply" : "dry-run",
    steps,
  };
}

async function installForSubstrate(substrate: InitSubstrate, options: { homeDir: string; somaHome: string }) {
  switch (substrate) {
    case "codex":
      return installSomaForCodex(options);
    case "pi-dev":
      return installSomaForPiDev(options);
    case "claude-code":
      return installSomaForClaudeCode(options);
    case "cursor":
      return installSomaForCursor(options);
  }
}

export async function applySomaInit(options: SomaOnboardingOptions = {}): Promise<SomaInitApplyResult> {
  const plan = await planSomaInit({ ...options, apply: true });
  const steps: SomaInitApplyResult["steps"] = [];
  for (const step of plan.steps) {
    if (step.id === "migrate-claude-skills" && plan.detected.claudeSkillsDir) {
      const result = await migrateClaudeSkills({
        from: plan.detected.claudeSkillsDir,
        homeDir: plan.homeDir,
        somaHome: plan.somaHome,
      });
      if (result.refusedOtherCount > 0) {
        const detail = result.outcomes
          .filter((outcome) => outcome.disposition === "refused-other")
          .map((outcome) => `${outcome.sourceName}: ${outcome.refusalReason ?? outcome.reason}`)
          .join("; ");
        throw new Error(`soma init migrate-claude-skills failed: ${detail}`);
      }
      steps.push({ id: step.id, status: "applied", detail: `${result.writtenCount} written` });
    } else if (step.id === "migrate-pai" && plan.detected.paiInstall) {
      const result = await migratePai({
        homeDir: plan.homeDir,
        claudeHome: plan.detected.paiInstall,
        somaHome: plan.somaHome,
      });
      const refusedOther = result.packOutcomes.filter((outcome) => outcome.outcome === "refused-other");
      if (refusedOther.length > 0) {
        const detail = refusedOther
          .map((outcome) => `${outcome.skillName ?? outcome.paiPackDir}: ${outcome.reason ?? "(no detail)"}`)
          .join("; ");
        throw new Error(`soma init migrate-pai failed: ${detail}`);
      }
      steps.push({ id: step.id, status: "applied", detail: `${result.filesWritten.length} files written` });
    } else if (step.id.startsWith("install-")) {
      const result = await installForSubstrate(plan.substrate, {
        homeDir: plan.homeDir,
        somaHome: plan.somaHome,
      });
      steps.push({ id: step.id, status: "applied", detail: `${result.substrateHome.files.length} files` });
    }
  }
  return { plan, steps };
}

async function maxProfileMtime(somaHome: string): Promise<number | null> {
  const mtimes = await Promise.all([
    pathMtimeMs(join(somaHome, "profile/assistant.md")),
    pathMtimeMs(join(somaHome, "profile/principal.md")),
    pathMtimeMs(join(somaHome, "profile/telos.md")),
  ]);
  const present = mtimes.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

export async function diagnoseSomaDoctor(options: SomaOnboardingOptions = {}): Promise<SomaDoctorDiagnosis> {
  const detected = await detectOnboarding(options);
  const findings: SomaDoctorFinding[] = [];
  if (detected.substrate !== "codex" && detected.substrate !== "claude-code") {
    throw new Error(DOCTOR_UNSUPPORTED_DRIFT_MESSAGE);
  }

  if (detected.soma.starterProfile) {
    findings.push({
      id: "starter-profile",
      severity: "warning",
      message: "Soma profile still looks like the starter scaffold.",
      action: detected.detected.paiInstall
        ? `soma migrate pai --pai-install ${shellQuote(detected.detected.paiInstall)} --apply ${sharedPathFlags(detected)}`
        : "Replace the starter profile with principal-specific Soma profile files.",
    });
  }

  if (detected.detected.claudeSkillsDir && !(await pathExists(join(detected.somaHome, "imports/claude-skills/.manifest.json")))) {
    findings.push({
      id: "claude-skills-not-migrated",
      severity: "warning",
      message: "Claude skills source exists, but Soma has no Claude skills migration manifest.",
      action: `soma migrate claude-skills --from ${shellQuote(detected.detected.claudeSkillsDir)} --apply ${sharedPathFlags(detected)}`,
    });
  }

  if (detected.detected.paiInstall && !(await pathExists(join(detected.somaHome, "profile/imports/claude/MIGRATION.md")))) {
    findings.push({
      id: "pai-not-migrated",
      severity: "warning",
      message: "PAI source exists, but Soma has no PAI migration manifest.",
      action: `soma migrate pai --pai-install ${shellQuote(detected.detected.paiInstall)} --apply ${sharedPathFlags(detected)}`,
    });
  }

  findings.push(...await diagnoseProjectionDrift({
    substrate: detected.substrate,
    homeDir: detected.homeDir,
    profileMtime: await maxProfileMtime(detected.somaHome),
  }));

  return {
    status: findings.length === 0 ? "ok" : "drift",
    homeDir: detected.homeDir,
    somaHome: detected.somaHome,
    findings,
  };
}
