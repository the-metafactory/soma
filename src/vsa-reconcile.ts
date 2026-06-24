import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  SECTION_NAME_MAP,
  getChangelog,
  getCriteria,
  getDecisions,
  getVerification,
  renderCriteriaMarkdown,
  renderLogEntries,
  setSection,
} from "./vsa-accessors";
import { readVsa, resolveSomaHome, writeVsa, type VsaLibraryOptions } from "./vsa";
import { appendSomaMemoryEvent } from "./memory";
import { parseVsa } from "./vsa-parse";
import type { AlgorithmLogEntry, VerificationStateArtifact, Checkpoint, VsaSection, SubstrateId } from "./types";

export type VsaConflictPolicy = "error" | "prefer-master" | "prefer-feature";

export type VsaReconcileConflictKind =
  | "criterion-duplicate"
  | "criterion-text"
  | "criterion-evidence"
  | "criterion-status-regression"
  | "criterion-tombstone"
  | "section-content"
  | "section-rename"
  | "log-entry";

export interface VsaReconcileConflict {
  kind: VsaReconcileConflictKind;
  target: string;
  policy: VsaConflictPolicy;
  resolution: "error" | "master" | "feature" | "merged";
  detail: string;
}

export interface VsaReconcileReport {
  policy: VsaConflictPolicy;
  changed: boolean;
  conflicts: VsaReconcileConflict[];
  mergedCriteria: string[];
  mergedSections: string[];
  mergedLogs: string[];
}

export interface VsaReconcileResult {
  isa: VerificationStateArtifact;
  report: VsaReconcileReport;
  path?: string;
}

export interface ReconcileVsaOptions extends VsaLibraryOptions {
  onConflict?: VsaConflictPolicy;
  timestamp?: string;
  substrate?: SubstrateId;
}

type FeatureVsaInput = VerificationStateArtifact | string;

const VALID_POLICIES: readonly VsaConflictPolicy[] = ["error", "prefer-master", "prefer-feature"];
const LOG_SECTIONS = new Set<string>([SECTION_NAME_MAP.decisions, SECTION_NAME_MAP.changelog, SECTION_NAME_MAP.verification]);

export async function reconcileVsa(
  slug: string,
  feature: FeatureVsaInput,
  options: ReconcileVsaOptions = {},
): Promise<VsaReconcileResult> {
  const somaHome = resolveSomaHome(options);
  const policyPromise = options.onConflict ? Promise.resolve(options.onConflict) : readDefaultConflictPolicy(somaHome);
  const [policy, master, featureVsa] = await Promise.all([policyPromise, readVsa(slug, options), loadFeatureVsa(feature)]);
  assertValidPolicy(policy);
  const result = reconcileVsaArtifacts(master, featureVsa, { onConflict: policy, timestamp: options.timestamp });

  if (result.report.conflicts.some((conflict) => conflict.resolution === "error")) {
    await emitReconcileEvent(somaHome, options, slug, result.report, undefined);
    throw new Error(formatConflictError(result.report));
  }

  const write = await writeVsa(slug, result.isa, options);
  result.report.changed = write.changed;
  await emitReconcileEvent(somaHome, options, slug, result.report, write.path);
  return { ...result, path: write.path };
}

export function reconcileVsaArtifacts(
  master: VerificationStateArtifact,
  feature: VerificationStateArtifact,
  options: Pick<ReconcileVsaOptions, "onConflict" | "timestamp"> = {},
): VsaReconcileResult {
  const policy = options.onConflict ?? "error";
  assertValidPolicy(policy);
  const report: VsaReconcileReport = {
    policy,
    changed: false,
    conflicts: [],
    mergedCriteria: [],
    mergedSections: [],
    mergedLogs: [],
  };
  assertUniqueCriterionLines(master, policy, report);
  assertUniqueCriterionLines(feature, policy, report);

  let next: VerificationStateArtifact = {
    ...master,
    sections: master.sections.map((section) => ({ ...section })),
    frontmatter: { ...master.frontmatter },
  };

  next = mergeCriteria(next, feature, policy, report);
  next = mergeLogSection(next, feature, { sectionName: SECTION_NAME_MAP.decisions, readEntries: getDecisions, policy, report });
  next = mergeLogSection(next, feature, { sectionName: SECTION_NAME_MAP.changelog, readEntries: getChangelog, policy, report });
  next = mergeLogSection(next, feature, { sectionName: SECTION_NAME_MAP.verification, readEntries: getVerification, policy, report });
  next = mergeOtherSections(next, feature, policy, report);
  if (hasErrorConflict(report)) {
    report.changed = false;
    report.mergedCriteria = [];
    report.mergedSections = [];
    report.mergedLogs = [];
    return { isa: master, report };
  }
  report.changed = hasStructuralChange(master, next);
  if (report.changed && options.timestamp) {
    next = { ...next, frontmatter: { ...next.frontmatter, updated: options.timestamp } };
  }

  return { isa: next, report };
}

async function loadFeatureVsa(feature: FeatureVsaInput): Promise<VerificationStateArtifact> {
  if (typeof feature !== "string") return feature;
  return parseVsa(await readFile(feature, "utf8"), feature);
}

async function readDefaultConflictPolicy(somaHome: string): Promise<VsaConflictPolicy> {
  const configPath = defaultVsaReconcileConfigPath(somaHome);
  const raw = await readFile(configPath, "utf8").catch(() => "");
  if (raw.length === 0) return "error";
  try {
    const parsed = JSON.parse(raw) as { defaultConflictPolicy?: unknown };
    const value = parsed.defaultConflictPolicy;
    return typeof value === "string" && isValidPolicy(value) ? value : "error";
  } catch {
    return "error";
  }
}

function assertValidPolicy(policy: string): void {
  if (!isValidPolicy(policy)) {
    throw new Error(`Invalid VSA reconcile conflict policy: ${policy}`);
  }
}

function isValidPolicy(value: string): value is VsaConflictPolicy {
  return (VALID_POLICIES as readonly string[]).includes(value);
}

function assertUniqueCriterionLines(isa: VerificationStateArtifact, policy: VsaConflictPolicy, report: VsaReconcileReport): void {
  const seen = new Set<string>();
  for (const section of isa.sections) {
    for (const criterion of parseCriterionLines(section)) {
      if (seen.has(criterion.id)) {
        addConflict(report, policy, {
          kind: "criterion-duplicate",
          target: criterion.id,
          detail: `Criterion ${criterion.id} appears more than once in ${isa.slug}.`,
          forcedResolution: "error",
        });
      }
      seen.add(criterion.id);
    }
  }
}

function parseCriterionLines(section: VsaSection): Checkpoint[] {
  const synthetic: VerificationStateArtifact = {
    slug: "section",
    frontmatter: {
      task: "section",
      effort: "E1",
      phase: "observe",
      progress: "0/0",
      verified: false,
      updated: "1970-01-01T00:00:00.000Z",
    },
    sections: [{ name: SECTION_NAME_MAP.criteria, content: section.content }],
  };
  return getCriteria(synthetic);
}

function mergeCriteria(
  master: VerificationStateArtifact,
  feature: VerificationStateArtifact,
  policy: VsaConflictPolicy,
  report: VsaReconcileReport,
): VerificationStateArtifact {
  const masterCriteria = getCriteria(master);
  const featureCriteria = getCriteria(feature);
  if (featureCriteria.length === 0) return master;

  const byId = new Map(masterCriteria.map((criterion) => [criterion.id, { ...criterion }]));
  const order = masterCriteria.map((criterion) => criterion.id);

  for (const featureCriterion of featureCriteria) {
    const current = byId.get(featureCriterion.id);
    if (!current) {
      byId.set(featureCriterion.id, { ...featureCriterion });
      order.push(featureCriterion.id);
      report.mergedCriteria.push(featureCriterion.id);
      continue;
    }
    const merged = mergeCriterion(current, featureCriterion, policy, report);
    byId.set(featureCriterion.id, merged);
    if (JSON.stringify(merged) !== JSON.stringify(current)) report.mergedCriteria.push(featureCriterion.id);
  }

  return setSection(master, SECTION_NAME_MAP.criteria, renderCriteriaMarkdown(order.map((id) => byId.get(id)).filter((criterion): criterion is Checkpoint => !!criterion)));
}

function mergeCriterion(
  master: Checkpoint,
  feature: Checkpoint,
  policy: VsaConflictPolicy,
  report: VsaReconcileReport,
): Checkpoint {
  if (master.status === "dropped" && feature.status !== "dropped") {
    addConflict(report, policy, {
      kind: "criterion-tombstone",
      target: master.id,
      detail: `Feature attempted to resurrect dropped criterion ${master.id}.`,
      forcedResolution: "master",
    });
    return master;
  }

  let next = { ...master, status: mergeStatus(master, feature, policy, report) };

  if (feature.text !== master.text) {
    const resolution = addConflict(report, policy, {
      kind: "criterion-text",
      target: master.id,
      detail: `Criterion ${master.id} text differs between master and feature.`,
    });
    if (resolution === "feature") next = { ...next, text: feature.text };
  }

  if (!master.verification && feature.verification) {
    next = { ...next, verification: feature.verification };
  } else if ((feature.verification ?? "") !== (master.verification ?? "") && feature.verification) {
    const resolution = addConflict(report, policy, {
      kind: "criterion-evidence",
      target: master.id,
      detail: `Criterion ${master.id} evidence differs between master and feature.`,
    });
    if (resolution === "feature") next = { ...next, verification: feature.verification };
  }

  return next;
}

function mergeStatus(
  master: Checkpoint,
  feature: Checkpoint,
  policy: VsaConflictPolicy,
  report: VsaReconcileReport,
): Checkpoint["status"] {
  if (master.status === feature.status) return master.status;
  if (master.status === "dropped") return "dropped";
  if (feature.status === "dropped") {
    const resolution = addConflict(report, policy, {
      kind: "criterion-status-regression",
      target: master.id,
      detail: `Feature status dropped would tombstone master status ${master.status}.`,
      nonErrorResolution: policy === "prefer-feature" ? "feature" : "master",
    });
    return resolution === "feature" ? "dropped" : master.status;
  }
  if (statusRank(feature.status) < statusRank(master.status)) {
    const resolution = addConflict(report, policy, {
      kind: "criterion-status-regression",
      target: master.id,
      detail: `Feature status ${feature.status} would regress master status ${master.status}.`,
      nonErrorResolution: policy === "prefer-feature" ? "feature" : "master",
    });
    return resolution === "feature" ? feature.status : master.status;
  }
  return feature.status;
}

function statusRank(status: Checkpoint["status"]): number {
  switch (status) {
    case "open":
      return 0;
    case "failed":
      return 1;
    case "deferred-probe":
      return 2;
    case "passed":
      return 3;
    case "dropped":
      return 4;
  }
}

interface LogMergeSpec {
  sectionName: string;
  readEntries: (isa: VerificationStateArtifact) => AlgorithmLogEntry[];
  policy: VsaConflictPolicy;
  report: VsaReconcileReport;
}

function mergeLogSection(master: VerificationStateArtifact, feature: VerificationStateArtifact, spec: LogMergeSpec): VerificationStateArtifact {
  const { sectionName, readEntries, policy, report } = spec;
  const masterEntries = readEntries(master);
  const featureEntries = readEntries(feature);
  if (featureEntries.length === 0) return master;
  const existing = new Set(masterEntries.map(logIdentity));
  const masterTimestampPhase = new Map(masterEntries.map((entry) => [logTimestampPhase(entry), entry.text]));
  const acceptedFeatureTimestampPhase = new Map<string, string>();
  const next = [...masterEntries];
  let appended = false;

  for (const entry of featureEntries) {
    if (existing.has(logIdentity(entry))) continue;
    const key = logTimestampPhase(entry);
    const existingText = masterTimestampPhase.get(key);
    if (existingText !== undefined && existingText !== entry.text) {
      const resolution = addConflict(report, policy, {
        kind: "log-entry",
        target: `${sectionName}:${key}`,
        detail: `Conflicting ${sectionName} entries share timestamp and phase.`,
      });
      if (resolution !== "feature") continue;
    }
    const acceptedText = acceptedFeatureTimestampPhase.get(key);
    if (acceptedText !== undefined && acceptedText !== entry.text) {
      addConflict(report, policy, {
        kind: "log-entry",
        target: `${sectionName}:${key}`,
        detail: `Conflicting feature ${sectionName} entries share timestamp and phase.`,
        nonErrorResolution: "merged",
      });
      continue;
    }
    next.push(entry);
    existing.add(logIdentity(entry));
    acceptedFeatureTimestampPhase.set(key, entry.text);
    report.mergedLogs.push(`${sectionName}:${entry.timestamp}`);
    appended = true;
  }
  if (!appended) return master;
  return setSection(master, sectionName, renderLogEntries(next));
}

function logIdentity(entry: AlgorithmLogEntry): string {
  return `${entry.timestamp}\u0000${entry.phase}\u0000${entry.text}`;
}

function logTimestampPhase(entry: AlgorithmLogEntry): string {
  return `${entry.timestamp}\u0000${entry.phase}`;
}

function mergeOtherSections(
  master: VerificationStateArtifact,
  feature: VerificationStateArtifact,
  policy: VsaConflictPolicy,
  report: VsaReconcileReport,
): VerificationStateArtifact {
  let next = master;
  const masterNames = new Set(master.sections.map((section) => section.name));
  for (const featureSection of feature.sections) {
    if (featureSection.name === SECTION_NAME_MAP.criteria || LOG_SECTIONS.has(featureSection.name)) continue;
    const masterSection = next.sections.find((section) => section.name === featureSection.name);
    if (!masterSection) {
      const renamed = findLikelyRenamedSection(next.sections, featureSection);
      if (renamed) {
        const resolution = addConflict(report, policy, {
          kind: "section-rename",
          target: featureSection.name,
          detail: `Feature section ${featureSection.name} looks like renamed master section ${renamed.name}.`,
        });
        if (resolution !== "feature") continue;
      }
      next = setSection(next, featureSection.name, featureSection.content);
      report.mergedSections.push(featureSection.name);
      continue;
    }
    if (normalizeBlock(masterSection.content) === normalizeBlock(featureSection.content)) continue;
    if (!masterNames.has(featureSection.name)) continue;
    const resolution = addConflict(report, policy, {
      kind: "section-content",
      target: featureSection.name,
      detail: `Section ${featureSection.name} differs between master and feature.`,
    });
    if (resolution === "feature") {
      next = setSection(next, featureSection.name, featureSection.content);
      report.mergedSections.push(featureSection.name);
    }
  }
  return next;
}

function findLikelyRenamedSection(masterSections: readonly VsaSection[], featureSection: VsaSection): VsaSection | undefined {
  const featureContent = normalizeBlock(featureSection.content);
  if (featureContent.length < 4) return undefined;
  return masterSections.find((section) => section.name !== featureSection.name && normalizeBlock(section.content) === featureContent);
}

function normalizeBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function addConflict(
  report: VsaReconcileReport,
  policy: VsaConflictPolicy,
  input: {
    kind: VsaReconcileConflictKind;
    target: string;
    detail: string;
    forcedResolution?: "error" | "master" | "feature" | "merged";
    nonErrorResolution?: "master" | "feature" | "merged";
  },
): VsaReconcileConflict["resolution"] {
  const resolution = resolveConflict(policy, input);
  report.conflicts.push({
    kind: input.kind,
    target: input.target,
    policy,
    resolution,
    detail: input.detail,
  });
  return resolution;
}

function hasErrorConflict(report: VsaReconcileReport): boolean {
  return report.conflicts.some((conflict) => conflict.resolution === "error");
}

function resolveConflict(
  policy: VsaConflictPolicy,
  input: {
    forcedResolution?: "error" | "master" | "feature" | "merged";
    nonErrorResolution?: "master" | "feature" | "merged";
  },
): VsaReconcileConflict["resolution"] {
  if (input.forcedResolution) return input.forcedResolution;
  if (policy === "error") return "error";
  if (input.nonErrorResolution) return input.nonErrorResolution;
  return policy === "prefer-feature" ? "feature" : "master";
}

function formatConflictError(report: VsaReconcileReport): string {
  const conflicts = report.conflicts.filter((conflict) => conflict.resolution === "error");
  return `VSA reconcile failed with ${conflicts.length} conflict(s): ${conflicts.map((conflict) => `${conflict.kind}:${conflict.target}`).join(", ")}`;
}

function hasStructuralChange(left: VerificationStateArtifact, right: VerificationStateArtifact): boolean {
  return JSON.stringify({
    frontmatter: left.frontmatter,
    sections: left.sections,
  }) !== JSON.stringify({
    frontmatter: right.frontmatter,
    sections: right.sections,
  });
}

async function emitReconcileEvent(
  somaHome: string,
  options: ReconcileVsaOptions,
  slug: string,
  report: VsaReconcileReport,
  path: string | undefined,
): Promise<void> {
  await appendSomaMemoryEvent(somaHome, {
    substrate: options.substrate ?? "custom",
    kind: "isa.reconcile",
    summary: `Reconciled VSA ${slug}`,
    artifactPaths: path ? [resolve(path)] : undefined,
    metadata: {
      slug,
      policy: report.policy,
      changed: report.changed,
      conflictCount: report.conflicts.length,
      conflicts: report.conflicts,
      mergedCriteria: report.mergedCriteria,
      mergedSections: report.mergedSections,
      mergedLogs: report.mergedLogs,
    },
  });
}

function defaultVsaReconcileConfigPath(somaHome: string): string {
  return join(somaHome, "isa", "config.json");
}
