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
} from "./isa-accessors";
import { readIsa, resolveSomaHome, writeIsa, type IsaLibraryOptions } from "./isa";
import { appendSomaMemoryEvent } from "./memory";
import { parseIsa } from "./isa-parse";
import type { AlgorithmLogEntry, IdealStateArtifact, IdealStateCriterion, IsaSection, SubstrateId } from "./types";

export type IsaConflictPolicy = "error" | "prefer-master" | "prefer-feature";

export type IsaReconcileConflictKind =
  | "criterion-duplicate"
  | "criterion-text"
  | "criterion-evidence"
  | "criterion-status-regression"
  | "criterion-tombstone"
  | "section-content"
  | "section-rename"
  | "log-entry";

export interface IsaReconcileConflict {
  kind: IsaReconcileConflictKind;
  target: string;
  policy: IsaConflictPolicy;
  resolution: "error" | "master" | "feature" | "merged";
  detail: string;
}

export interface IsaReconcileReport {
  policy: IsaConflictPolicy;
  changed: boolean;
  conflicts: IsaReconcileConflict[];
  mergedCriteria: string[];
  mergedSections: string[];
  mergedLogs: string[];
}

export interface IsaReconcileResult {
  isa: IdealStateArtifact;
  report: IsaReconcileReport;
  path?: string;
}

export interface ReconcileIsaOptions extends IsaLibraryOptions {
  onConflict?: IsaConflictPolicy;
  timestamp?: string;
  substrate?: SubstrateId;
}

type FeatureIsaInput = IdealStateArtifact | string;

const VALID_POLICIES: readonly IsaConflictPolicy[] = ["error", "prefer-master", "prefer-feature"];
const LOG_SECTIONS = new Set<string>([SECTION_NAME_MAP.decisions, SECTION_NAME_MAP.changelog, SECTION_NAME_MAP.verification]);

export async function reconcileIsa(
  slug: string,
  feature: FeatureIsaInput,
  options: ReconcileIsaOptions = {},
): Promise<IsaReconcileResult> {
  const somaHome = resolveSomaHome(options);
  const policyPromise = options.onConflict ? Promise.resolve(options.onConflict) : readDefaultConflictPolicy(somaHome);
  const [policy, master, featureIsa] = await Promise.all([policyPromise, readIsa(slug, options), loadFeatureIsa(feature)]);
  assertValidPolicy(policy);
  const result = reconcileIsaArtifacts(master, featureIsa, { onConflict: policy, timestamp: options.timestamp });

  if (result.report.conflicts.some((conflict) => conflict.resolution === "error")) {
    await emitReconcileEvent(somaHome, options, slug, result.report, undefined);
    throw new Error(formatConflictError(result.report));
  }

  const write = await writeIsa(slug, result.isa, options);
  result.report.changed = write.changed;
  await emitReconcileEvent(somaHome, options, slug, result.report, write.path);
  return { ...result, path: write.path };
}

export function reconcileIsaArtifacts(
  master: IdealStateArtifact,
  feature: IdealStateArtifact,
  options: Pick<ReconcileIsaOptions, "onConflict" | "timestamp"> = {},
): IsaReconcileResult {
  const policy = options.onConflict ?? "error";
  assertValidPolicy(policy);
  const report: IsaReconcileReport = {
    policy,
    changed: false,
    conflicts: [],
    mergedCriteria: [],
    mergedSections: [],
    mergedLogs: [],
  };
  assertUniqueCriterionLines(master, policy, report);
  assertUniqueCriterionLines(feature, policy, report);

  let next: IdealStateArtifact = {
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

async function loadFeatureIsa(feature: FeatureIsaInput): Promise<IdealStateArtifact> {
  if (typeof feature !== "string") return feature;
  return parseIsa(await readFile(feature, "utf8"), feature);
}

async function readDefaultConflictPolicy(somaHome: string): Promise<IsaConflictPolicy> {
  const configPath = defaultIsaReconcileConfigPath(somaHome);
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
    throw new Error(`Invalid ISA reconcile conflict policy: ${policy}`);
  }
}

function isValidPolicy(value: string): value is IsaConflictPolicy {
  return (VALID_POLICIES as readonly string[]).includes(value);
}

function assertUniqueCriterionLines(isa: IdealStateArtifact, policy: IsaConflictPolicy, report: IsaReconcileReport): void {
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

function parseCriterionLines(section: IsaSection): IdealStateCriterion[] {
  const synthetic: IdealStateArtifact = {
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
  master: IdealStateArtifact,
  feature: IdealStateArtifact,
  policy: IsaConflictPolicy,
  report: IsaReconcileReport,
): IdealStateArtifact {
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

  return setSection(master, SECTION_NAME_MAP.criteria, renderCriteriaMarkdown(order.map((id) => byId.get(id)).filter((criterion): criterion is IdealStateCriterion => !!criterion)));
}

function mergeCriterion(
  master: IdealStateCriterion,
  feature: IdealStateCriterion,
  policy: IsaConflictPolicy,
  report: IsaReconcileReport,
): IdealStateCriterion {
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
  master: IdealStateCriterion,
  feature: IdealStateCriterion,
  policy: IsaConflictPolicy,
  report: IsaReconcileReport,
): IdealStateCriterion["status"] {
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

function statusRank(status: IdealStateCriterion["status"]): number {
  switch (status) {
    case "open":
      return 0;
    case "failed":
      return 1;
    case "passed":
      return 2;
    case "dropped":
      return 3;
  }
}

interface LogMergeSpec {
  sectionName: string;
  readEntries: (isa: IdealStateArtifact) => AlgorithmLogEntry[];
  policy: IsaConflictPolicy;
  report: IsaReconcileReport;
}

function mergeLogSection(master: IdealStateArtifact, feature: IdealStateArtifact, spec: LogMergeSpec): IdealStateArtifact {
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
  master: IdealStateArtifact,
  feature: IdealStateArtifact,
  policy: IsaConflictPolicy,
  report: IsaReconcileReport,
): IdealStateArtifact {
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

function findLikelyRenamedSection(masterSections: readonly IsaSection[], featureSection: IsaSection): IsaSection | undefined {
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
  report: IsaReconcileReport,
  policy: IsaConflictPolicy,
  input: {
    kind: IsaReconcileConflictKind;
    target: string;
    detail: string;
    forcedResolution?: "error" | "master" | "feature" | "merged";
    nonErrorResolution?: "master" | "feature" | "merged";
  },
): IsaReconcileConflict["resolution"] {
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

function hasErrorConflict(report: IsaReconcileReport): boolean {
  return report.conflicts.some((conflict) => conflict.resolution === "error");
}

function resolveConflict(
  policy: IsaConflictPolicy,
  input: {
    forcedResolution?: "error" | "master" | "feature" | "merged";
    nonErrorResolution?: "master" | "feature" | "merged";
  },
): IsaReconcileConflict["resolution"] {
  if (input.forcedResolution) return input.forcedResolution;
  if (policy === "error") return "error";
  if (input.nonErrorResolution) return input.nonErrorResolution;
  return policy === "prefer-feature" ? "feature" : "master";
}

function formatConflictError(report: IsaReconcileReport): string {
  const conflicts = report.conflicts.filter((conflict) => conflict.resolution === "error");
  return `ISA reconcile failed with ${conflicts.length} conflict(s): ${conflicts.map((conflict) => `${conflict.kind}:${conflict.target}`).join(", ")}`;
}

function hasStructuralChange(left: IdealStateArtifact, right: IdealStateArtifact): boolean {
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
  options: ReconcileIsaOptions,
  slug: string,
  report: IsaReconcileReport,
  path: string | undefined,
): Promise<void> {
  await appendSomaMemoryEvent(somaHome, {
    substrate: options.substrate ?? "custom",
    kind: "isa.reconcile",
    summary: `Reconciled ISA ${slug}`,
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

function defaultIsaReconcileConfigPath(somaHome: string): string {
  return join(somaHome, "isa", "config.json");
}
