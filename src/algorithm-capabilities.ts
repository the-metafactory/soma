import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  AlgorithmCapabilityContract,
  AlgorithmCapabilityDefinition,
  AlgorithmCapabilitySelection,
  AlgorithmCapabilitySelectionStatus,
  AlgorithmCapabilityInvocation,
  AlgorithmCapabilityKind,
  AlgorithmPhase,
  AlgorithmRun,
  SomaSkillManifest,
  SubstrateId,
} from "./types";
import { getRunPhase } from "./algorithm-lifecycle";
import { appendAlgorithmProvenance } from "./algorithm-provenance";

const CORE_PHASES: AlgorithmPhase[] = ["observe", "think", "plan", "build", "execute", "verify", "learn"];
const CAPABILITY_INVOKE_KINDS = ["skill", "inline", "agent", "command", "adapter", "contract"] as const;

const DEFAULT_CAPABILITY_REGISTRY: AlgorithmCapabilityDefinition[] = [
  {
    name: "ReReadCheck",
    kind: "inline",
    phases: ["verify", "learn"],
    triggerSignals: ["review", "regression", "instruction drift", "before final"],
    invoke: { contract: "inline", target: "Re-read task, issue, diff, tests, and final answer for drift." },
  },
  {
    name: "sequential-analysis",
    kind: "inline",
    phases: ["think", "plan"],
    triggerSignals: ["sequence", "phase gates", "ordered work"],
    invoke: { contract: "inline", target: "Analyze the work as an ordered sequence before planning." },
  },
];

export interface SomaHomeAlgorithmCapabilityOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
}

export interface SomaHomeAlgorithmCapabilityRegistry {
  definitions: AlgorithmCapabilityDefinition[];
  unsupported: string[];
}

export interface SelectAlgorithmCapabilityInput {
  name: string;
  phase?: AlgorithmPhase;
  reason?: string;
}

export interface RecordAlgorithmCapabilityInvocationInput {
  name: string;
  substrate?: SubstrateId;
  evidence: string;
}

export interface RemoveAlgorithmCapabilityInput {
  name: string;
  reason: string;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Algorithm ${field} must not be empty.`);
  }
}

function dedupeCapabilities(capabilities: string[], name: string): string[] {
  return Array.from(new Set([...capabilities, name]));
}

function findSelectionIndex(selections: AlgorithmCapabilitySelection[], name: string): number {
  const unresolvedIndex = selections.findIndex(
    (selection) => selection.name === name && (selection.status === "selected" || selection.status === "failed"),
  );

  if (unresolvedIndex !== -1) {
    return unresolvedIndex;
  }

  return selections.findIndex((selection) => selection.name === name && selection.status === "invoked");
}

function capabilityStatusText(status: AlgorithmCapabilitySelectionStatus): string {
  return status === "selected" ? "selected but not invoked" : status;
}

function cloneCapabilityDefinition(definition: AlgorithmCapabilityDefinition): AlgorithmCapabilityDefinition {
  return {
    ...definition,
    phases: [...definition.phases],
    triggerSignals: [...definition.triggerSignals],
    invoke: { ...definition.invoke },
  };
}

function resolveSomaHome(options: SomaHomeAlgorithmCapabilityOptions = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  return options.somaHome ? resolve(home, options.somaHome) : join(home, ".soma");
}

function normalizeCapabilityKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripMarkdownEmphasis(value: string): string {
  return value
    .replaceAll("**", "")
    .replaceAll("*", "")
    .replaceAll("`", "")
    .trim();
}

function stripCapabilityLabel(value: string): string {
  const label = stripMarkdownEmphasis(value).replace(/\s*\([^)]*\)\s*$/, "").trim();
  return label === "VSA Skill" ? "VSA" : label;
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function hasOwnField(value: unknown, field: string): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function frontmatterValue(content: string, key: string, fallback: string): string {
  const pattern = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = content.match(pattern);
  if (!match) return fallback;
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : fallback;
}

function sectionBullets(content: string, heading: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return [];

  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = /^\s*[-*]\s+(.+)$/.exec(line);
    if (match) bullets.push(stripMarkdownEmphasis(match[1]));
  }

  return bullets;
}

interface AvailableSkill {
  dirName: string;
  name: string;
  description: string;
  triggers: string[];
  manifest?: SomaSkillManifest;
}

async function readSomaSkillManifest(skillRoot: string): Promise<SomaSkillManifest | undefined> {
  const raw = await readFile(join(skillRoot, "soma-skill.json"), "utf8").catch(() => undefined);
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as Partial<SomaSkillManifest>;
    if (
      parsed.schema !== "soma.skill.v1"
      || typeof parsed.name !== "string"
    ) {
      return undefined;
    }

    return parsed as SomaSkillManifest;
  } catch {
    return undefined;
  }
}

async function loadAvailableSkills(somaHome: string): Promise<{ skills: AvailableSkill[]; byKey: Map<string, AvailableSkill> }> {
  const skillsRoot = join(somaHome, "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const byKey = new Map<string, AvailableSkill>();

  const skillCandidates: (AvailableSkill | undefined)[] = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<AvailableSkill | undefined> => {
        const skillRoot = join(skillsRoot, entry.name);
        const skillMd = await readFile(join(skillRoot, "SKILL.md"), "utf8").catch(() => undefined);
        if (!skillMd) return undefined;

        const manifest = await readSomaSkillManifest(skillRoot);
        const manifestName = typeof manifest?.name === "string" && manifest.name.trim().length > 0
          ? manifest.name
          : undefined;
        const name = manifestName ?? frontmatterValue(skillMd, "name", entry.name);
        const description = typeof manifest?.description === "string"
          ? manifest.description
          : frontmatterValue(skillMd, "description", "");
        const manifestTriggers = nonEmptyStrings(manifest?.triggers);
        const triggers = manifestTriggers.length > 0 ? manifestTriggers : sectionBullets(skillMd, "Triggers");

        return { dirName: entry.name, name, description, triggers, manifest };
      }),
  );
  const skills = skillCandidates.filter((skill): skill is AvailableSkill => skill !== undefined);

  for (const skill of skills) {
    byKey.set(normalizeCapabilityKey(skill.name), skill);
    byKey.set(normalizeCapabilityKey(skill.dirName), skill);
    byKey.set(normalizeCapabilityKey(basename(skill.dirName)), skill);
  }

  return { skills, byKey };
}

function parsePhaseCell(value: string, fallback: AlgorithmPhase[] = ["think"]): AlgorithmPhase[] {
  const normalized = stripMarkdownEmphasis(value).toLowerCase();
  if (normalized === "any") {
    return [...CORE_PHASES];
  }

  const phases = new Set<AlgorithmPhase>();
  const phaseNames: AlgorithmPhase[] = [...CORE_PHASES, "complete"];
  for (const phase of phaseNames) {
    if (normalized.includes(phase)) {
      phases.add(phase);
    }
  }

  return phases.size > 0 ? Array.from(phases) : [...fallback];
}

function parseMarkdownTableRows(markdown: string): string[][] {
  const rows: string[][] = [];
  let inCapabilityTable = false;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) {
      inCapabilityTable = false;
      continue;
    }

    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    const first = cells[0]?.toLowerCase() ?? "";
    if (first === "capability") {
      inCapabilityTable = true;
      continue;
    }

    if (!inCapabilityTable) {
      continue;
    }

    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      continue;
    }

    if (cells.length >= 3) {
      rows.push(cells);
    }
  }

  return rows;
}

function skillInvocationTarget(value: string): string | undefined {
  return /Skill\("([^"]+)"/.exec(value)?.[1];
}

function agentInvocationTarget(value: string, capabilityName: string): string | undefined {
  const subtype = /subagent_type\s*=\s*"([^"]+)"/.exec(value)?.[1];
  return subtype ?? (value.includes("Agent(") ? capabilityName : undefined);
}

function commandInvocationTarget(value: string): string | undefined {
  const stripped = stripMarkdownEmphasis(value);
  if (stripped.includes("Bash(")) return stripped;
  if (stripped.startsWith("bun ")) return stripped;
  return undefined;
}

function inlineInvocationTarget(value: string): string | undefined {
  const stripped = stripMarkdownEmphasis(value);
  if (stripped.includes("inline doctrine") || stripped.includes("no external tool")) {
    return stripped;
  }
  return undefined;
}

/**
 * `Contract("<what must be achieved>")` — a capability declared by its contract
 * rather than by a concrete invocation, for work no single substrate expresses
 * portably: a second opinion, a coder from another model family, a cross-family
 * audit (soma#574).
 *
 * NAMING (Sage review): the row syntax is `Contract(…)`, never `Adapter(…)`.
 * CONTEXT.md §adapter locks `adapter` to the actor that performs a projection,
 * one per substrate, and puts optional invocation on `SubstrateExecutor`
 * "never to an adapter". A public row syntax spelled `Adapter(` would overload
 * that term with a second meaning at exactly the boundary the glossary exists
 * to keep clear. The stored `kind` is still `"adapter"` — that member predates
 * this change and lives in the exported `AlgorithmCapabilityKind` union, so
 * renaming it is a public-API change, tracked separately rather than smuggled
 * in here.
 *
 * A contract capability is DECLARED in the shipped table and BOUND by whoever
 * can satisfy it — a same-named row in `capabilities.local.md`, which is read
 * first and wins. Unbound, it stays selectable and still counts toward a tier
 * floor, deliberately: `assertAlgorithmCapabilitiesSatisfied` refuses COMPLETE
 * for any selected capability never invoked, so it fails the run loudly at the
 * gate instead of quietly padding a floor as a phantom.
 */
function adapterInvocationTarget(value: string): string | undefined {
  // `??` cannot stand in for the emptiness check: a whitespace-only contract
  // trims to "", which is not nullish but is not a contract either.
  const contract = /Contract\("([^"]+)"/.exec(value)?.[1]?.trim();
  return contract !== undefined && contract.length > 0 ? contract : undefined;
}

function buildCapabilityDefinition(
  name: string,
  kind: AlgorithmCapabilityDefinition["kind"],
  phases: AlgorithmPhase[],
  triggerSignals: string[],
  target: string,
  contract: AlgorithmCapabilityContract = kind,
): AlgorithmCapabilityDefinition {
  return {
    name,
    kind,
    phases,
    triggerSignals,
    invoke: { contract, target },
  };
}

function isSubstrateSupported(manifest: SomaSkillManifest | undefined, substrate: SubstrateId | undefined): boolean {
  if (!manifest || !substrate) return true;
  if (!Array.isArray(manifest.substrates)) return false;
  return manifest.substrates.includes(substrate);
}

function isCapabilityInvokeKind(value: unknown): value is AlgorithmCapabilityContract & AlgorithmCapabilityKind {
  return typeof value === "string" && CAPABILITY_INVOKE_KINDS.includes(value as (typeof CAPABILITY_INVOKE_KINDS)[number]);
}

function isCapabilityKind(value: unknown): value is AlgorithmCapabilityKind {
  return isCapabilityInvokeKind(value);
}

function isAlgorithmPhase(value: unknown): value is AlgorithmPhase {
  return value === "observe" || value === "think" || value === "plan" || value === "build" || value === "execute" || value === "verify" || value === "learn" || value === "complete";
}

function fallbackTriggerSignals(skill: AvailableSkill): string[] {
  const triggers = skill.triggers.map((trigger) => trigger.trim()).filter((trigger) => trigger.length > 0);
  if (triggers.length > 0) return triggers;

  const description = skill.description.trim();
  return description.length > 0 ? [description] : [skill.name];
}

function skillManifestCapabilityDefinition(skill: AvailableSkill): AlgorithmCapabilityDefinition | undefined {
  const metadata = isRecord(skill.manifest?.algorithmCapability)
    ? skill.manifest.algorithmCapability
    : undefined;
  const kind = isCapabilityKind(metadata?.kind) ? metadata.kind : "skill";
  const phases = Array.isArray(metadata?.phases)
    ? metadata.phases.filter(isAlgorithmPhase)
    : [];
  if (hasOwnField(metadata, "phases") && phases.length === 0) {
    return undefined;
  }
  const triggerSignals = nonEmptyStrings(metadata?.triggerSignals);

  return buildCapabilityDefinition(
    skill.name,
    kind,
    phases.length > 0 ? phases : [...CORE_PHASES],
    triggerSignals.length > 0 ? triggerSignals : fallbackTriggerSignals(skill),
    skill.name,
    kind,
  );
}

function maybeRegisterSkillCapability(
  definitions: Map<string, AlgorithmCapabilityDefinition>,
  unsupported: Set<string>,
  skill: AvailableSkill,
  substrate: SubstrateId | undefined,
  options: { requireManifestCapability: boolean },
): void {
  if (definitions.has(skill.name) || unsupported.has(skill.name)) {
    return;
  }
  if (!isSubstrateSupported(skill.manifest, substrate)) {
    unsupported.add(skill.name);
    return;
  }
  if (options.requireManifestCapability && !isRecord(skill.manifest?.algorithmCapability)) {
    return;
  }

  const definition = skillManifestCapabilityDefinition(skill);
  if (!definition) {
    unsupported.add(skill.name);
    return;
  }
  definitions.set(definition.name, definition);
}

/** The bundled capability table — overwritten byte-for-byte on every install. */
const CAPABILITY_REFERENCE_FILE = "capabilities.md";

/**
 * The adopter's capability table (soma#574). `installBundledSkillsIntoHome`
 * rewrites every bundled file on each run but leaves principal-added files under
 * a skill dir alone, so this sibling is the ONLY place in the skill dir where a
 * principal's own rows survive an install. Read after the bundled table and, on
 * a name collision, kept — so an adopter can narrow or retarget a shipped
 * capability without editing a file that will be replaced under them.
 */
const CAPABILITY_LOCAL_REFERENCE_FILE = "capabilities.local.md";

function registerCapabilityTableRows(
  markdown: string,
  definitions: Map<string, AlgorithmCapabilityDefinition>,
  unsupported: Set<string>,
  availableSkills: Awaited<ReturnType<typeof loadAvailableSkills>>,
  substrate: SubstrateId | undefined,
): void {
  for (const row of markdown ? parseMarkdownTableRows(markdown) : []) {
    const name = stripCapabilityLabel(row[0] ?? "");
    const phaseCell = row[1] ?? "";
    const triggerCell = row.length >= 5 ? row[2] ?? "" : row[1] ?? "";
    const invokeCell = row.length >= 5 ? row[3] ?? "" : row[2] ?? "";

    if (!name) continue;
    if (definitions.has(name) || unsupported.has(name)) continue;

    const phases = parsePhaseCell(phaseCell, row.length >= 5 ? ["think"] : ["plan"]);
    const triggerSignals = [stripMarkdownEmphasis(triggerCell)].filter((signal) => signal.length > 0);
    const skillTarget = skillInvocationTarget(invokeCell);
    const agentTarget = agentInvocationTarget(invokeCell, name);
    const commandTarget = commandInvocationTarget(invokeCell);
    const inlineTarget = inlineInvocationTarget(invokeCell);
    // Checked before `agent`: `Contract("spawn a sub-agent …")` must not be read
    // as an Agent( row by the substring match below.
    const adapterTarget = adapterInvocationTarget(invokeCell);

    if (adapterTarget) {
      definitions.set(name, buildCapabilityDefinition(name, "contract", phases, triggerSignals, adapterTarget));
      continue;
    }

    if (skillTarget) {
      const targetSkill = availableSkills.byKey.get(normalizeCapabilityKey(skillTarget));
      if (!targetSkill) {
        unsupported.add(name);
        continue;
      }
      if (!isSubstrateSupported(targetSkill.manifest, substrate)) {
        unsupported.add(name);
        continue;
      }

      definitions.set(name, buildCapabilityDefinition(name, "skill", phases, triggerSignals, targetSkill.name));
      continue;
    }

    if (agentTarget) {
      definitions.set(name, buildCapabilityDefinition(name, "agent", phases, triggerSignals, agentTarget));
      continue;
    }

    if (inlineTarget) {
      definitions.set(name, buildCapabilityDefinition(name, "inline", phases, triggerSignals, inlineTarget));
      continue;
    }

    if (commandTarget) {
      definitions.set(name, buildCapabilityDefinition(name, "command", phases, triggerSignals, commandTarget));
      continue;
    }

    unsupported.add(name);
  }
}

export async function loadSomaHomeAlgorithmCapabilityRegistry(
  options: SomaHomeAlgorithmCapabilityOptions = {},
): Promise<SomaHomeAlgorithmCapabilityRegistry> {
  const somaHome = resolveSomaHome(options);
  const referenceDir = join(somaHome, "skills", "the-algorithm", "references");
  const [localMarkdown, markdown] = await Promise.all([
    readFile(join(referenceDir, CAPABILITY_LOCAL_REFERENCE_FILE), "utf8").catch(() => ""),
    readFile(join(referenceDir, CAPABILITY_REFERENCE_FILE), "utf8").catch(() => ""),
  ]);
  const availableSkills = await loadAvailableSkills(somaHome);
  const definitions = new Map<string, AlgorithmCapabilityDefinition>();
  const unsupported = new Set<string>();

  // Resolution order, first definition of a name winning. Every pass skips a
  // name already registered or already marked unsupported.
  //
  // 1. The ADOPTER's table, read BEFORE the bundled table and winning on any
  //    name collision. First, so "a local row of the same name wins" is true
  //    without qualification (Sage review). It previously sat behind the
  //    manifest pass, which meant a manifest-declared capability could not be
  //    retargeted locally and silently stayed active — an override that does not
  //    always override is worse than none, because it is trusted.
  //    A local row that cannot resolve lands in `unsupported`, which also blocks
  //    the bundled row of the same name: an adopter who retargets a capability
  //    at a skill they do not have has disabled it, and should see that rather
  //    than silently fall back to the shipped definition.
  registerCapabilityTableRows(localMarkdown, definitions, unsupported, availableSkills, options.substrate);

  // 2. Skills declaring `algorithmCapability` in their manifest — the skill
  //    author's own phase/trigger metadata, preferred over the bundled table.
  for (const skill of availableSkills.skills) {
    maybeRegisterSkillCapability(definitions, unsupported, skill, options.substrate, { requireManifestCapability: true });
  }

  // 3. The shipped table.
  registerCapabilityTableRows(markdown, definitions, unsupported, availableSkills, options.substrate);

  // 4. Every remaining skill, under its own name, admissible in all phases.
  for (const skill of availableSkills.skills) {
    maybeRegisterSkillCapability(definitions, unsupported, skill, options.substrate, { requireManifestCapability: false });
  }

  return {
    definitions: Array.from(definitions.values()).map(cloneCapabilityDefinition),
    unsupported: Array.from(unsupported).sort(),
  };
}

export async function registerSomaHomeAlgorithmCapabilities(
  run: AlgorithmRun,
  options: SomaHomeAlgorithmCapabilityOptions = {},
  timestamp = run.updatedAt,
): Promise<AlgorithmRun> {
  const { definitions, unsupported } = await loadSomaHomeAlgorithmCapabilityRegistry(options);
  if (definitions.length === 0 && unsupported.length === 0) {
    return run;
  }

  // A refresh REPLACES the home-derived set rather than merging into it. Adding
  // and overriding by name left two ways for a run to keep a capability the home
  // no longer offers (both Sage review): a row retargeted at something absent
  // (reported `unsupported`) and a row simply deleted (reported nowhere at all).
  // Either way the persisted definition stayed selectable while
  // `capabilities --list` no longer showed it — a closed vocabulary with a
  // second, invisible half.
  //
  // Scoped by `origin` rather than clearing everything (Sage review): a blanket
  // clear also destroyed definitions a public caller had registered directly
  // through `registerAlgorithmCapabilityDefinition`, which no home refresh has
  // any business owning. Only what a previous refresh put there is replaced.
  // Compiled-in defaults are unaffected — never persisted, and
  // `definitionsForRun` supplies them regardless.
  //
  // An ABSENT origin is treated as home-derived, not foreign (Sage review): runs
  // persisted before this field existed carry no origin, and the home path was
  // the only producer of run definitions then. Reading absence as foreign would
  // make a legacy row undeletable — exactly the staleness this replace exists to
  // end. Only `caller` is preserved, and that is stamped from now on.
  const homeDefinitions = definitions.map((definition) => ({ ...definition, origin: "soma-home" as const }));
  const keptForeign = (run.capabilityDefinitions ?? []).filter((definition) => definition.origin === "caller");
  const withoutHomeDefinitions = { ...run, capabilityDefinitions: keptForeign };

  return homeDefinitions.length === 0
    ? withoutHomeDefinitions
    : registerAlgorithmCapabilityDefinitions(withoutHomeDefinitions, homeDefinitions, timestamp);
}

export function listAlgorithmCapabilityDefinitions(): AlgorithmCapabilityDefinition[] {
  return DEFAULT_CAPABILITY_REGISTRY.map(cloneCapabilityDefinition);
}

/**
 * Everything a run may select: the compiled-in defaults, overridden by name by
 * whatever the soma home resolved. One helper so the `--list` view and run
 * resolution cannot drift apart on precedence (Sage review) — the same
 * defaults-then-override order `definitionsForRun` applies.
 *
 * The two compiled-in capabilities (`ReReadCheck`, `sequential-analysis`) are
 * always present and are NOT suppressed by an unresolvable local row of the
 * same name. Both are `inline` — they name a discipline and need no tool, so
 * there is nothing an installation can lack — and `ReReadCheck` is doctrine-
 * mandatory at every tier. Letting a mistyped local row silently disable it
 * would remove a floor by accident, which is the opposite of what the
 * local-row-disables rule is for. That rule governs table-declared
 * capabilities, whose targets can genuinely be absent.
 */
/** Compiled-in defaults, overridden by name. The single precedence rule. */
function mergeCapabilityDefinitions(overrides: readonly AlgorithmCapabilityDefinition[]): AlgorithmCapabilityDefinition[] {
  const byName = new Map(DEFAULT_CAPABILITY_REGISTRY.map((definition) => [definition.name, definition]));
  for (const definition of overrides) byName.set(definition.name, definition);
  return [...byName.values()];
}

export function mergedAlgorithmCapabilityRegistry(
  resolved: SomaHomeAlgorithmCapabilityRegistry,
): SomaHomeAlgorithmCapabilityRegistry {
  const byName = new Map(mergeCapabilityDefinitions(resolved.definitions).map((definition) => [definition.name, definition]));
  return {
    definitions: [...byName.values()],
    // Disjoint by construction (Sage review): a name that ended up resolvable —
    // because a compiled-in default backs it — is available, full stop. Leaving
    // it in both arrays would give consumers two contradictory answers to "can I
    // select this?", and the honest one is the definition.
    unsupported: resolved.unsupported.filter((name) => !byName.has(name)),
  };
}

function definitionsForRun(run: Pick<AlgorithmRun, "capabilityDefinitions">): AlgorithmCapabilityDefinition[] {
  const byName = new Map(
    mergeCapabilityDefinitions(run.capabilityDefinitions ?? []).map((definition) => [definition.name, definition]),
  );

  return Array.from(byName.values()).map(cloneCapabilityDefinition);
}

function validateCapabilityDefinition(definition: AlgorithmCapabilityDefinition): void {
  assertNonEmpty(definition.name, "capability name");
  assertNonEmpty(definition.invoke.target, "capability invocation target");

  if (definition.phases.length === 0) {
    throw new Error(`Algorithm capability must declare at least one phase: ${definition.name}`);
  }

  if (!Array.isArray(definition.triggerSignals)) {
    throw new Error(`Algorithm capability must declare triggerSignals: ${definition.name}`);
  }
}

export function registerAlgorithmCapabilityDefinition(
  run: AlgorithmRun,
  definition: AlgorithmCapabilityDefinition,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  return registerAlgorithmCapabilityDefinitions(run, [definition], timestamp);
}

export function registerAlgorithmCapabilityDefinitions(
  run: AlgorithmRun,
  definitions: AlgorithmCapabilityDefinition[],
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  if (definitions.length === 0) {
    throw new Error("Algorithm capability registration requires at least one definition.");
  }

  const nextDefinitions = new Map((run.capabilityDefinitions ?? []).map((existing) => [existing.name, existing]));
  for (const definition of definitions) {
    validateCapabilityDefinition(definition);
    // Default the provenance to `caller`: this is the public entry point, and a
    // home refresh pre-stamps `soma-home` before calling in, so only a direct
    // caller lands here unmarked. A refresh replaces its own rows and leaves
    // `caller` rows alone (soma#574).
    const clone = cloneCapabilityDefinition(definition);
    nextDefinitions.set(definition.name, { ...clone, origin: clone.origin ?? "caller" });
  }

  return {
    ...run,
    updatedAt: timestamp,
    capabilityDefinitions: Array.from(nextDefinitions.values()).map(cloneCapabilityDefinition),
  };
}

export function getAlgorithmCapabilityDefinition(
  name: string,
  run?: Pick<AlgorithmRun, "capabilityDefinitions">,
): AlgorithmCapabilityDefinition {
  assertNonEmpty(name, "capability");
  const definition = (run ? definitionsForRun(run) : listAlgorithmCapabilityDefinitions()).find((capability) => capability.name === name);

  if (!definition) {
    throw new Error(`Algorithm capability is not registered: ${name}`);
  }

  return cloneCapabilityDefinition(definition);
}

export function selectAlgorithmCapability(
  run: AlgorithmRun,
  input: SelectAlgorithmCapabilityInput,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const name = input.name.trim();
  const definition = getAlgorithmCapabilityDefinition(name, run);
  const phase = input.phase ?? getRunPhase(run);
  const trimmedReason = input.reason?.trim();
  const reason = trimmedReason && trimmedReason.length > 0 ? trimmedReason : `Selected ${definition.name} for ${phase}.`;
  const selections = run.capabilitySelections ?? [];
  const existingIndex = findSelectionIndex(selections, name);

  assertNonEmpty(reason, "capability selection reason");

  if (!definition.phases.includes(phase)) {
    throw new Error(`Algorithm capability ${name} cannot be selected for ${phase}; allowed phases: ${definition.phases.join(", ")}.`);
  }

  if (existingIndex !== -1) {
    const existing = selections[existingIndex];
    const changedSelection = existing.phase !== phase || existing.reason !== reason;

    if (existing.status === "invoked" && !changedSelection) {
      return {
        ...run,
        updatedAt: timestamp,
        capabilities: dedupeCapabilities(run.capabilities, name),
        capabilitySelections: selections,
      };
    }

    if ((existing.status === "invoked" || existing.status === "failed") && changedSelection) {
      return appendCapabilitySelection(run, selections, { name, phase, reason, timestamp });
    }

    const nextSelections = selections.map((selection, index) =>
      index === existingIndex
        ? {
            ...selection,
            phase,
            reason,
            status: "selected" as const,
            invocation: undefined,
            selectedAt: selection.selectedAt,
          }
        : selection,
    );

    return {
      ...run,
      updatedAt: timestamp,
      capabilities: dedupeCapabilities(run.capabilities, name),
      capabilitySelections: nextSelections,
    };
  }

  return appendCapabilitySelection(run, selections, { name, phase, reason, timestamp });
}

function appendCapabilitySelection(
  run: AlgorithmRun,
  selections: AlgorithmCapabilitySelection[],
  input: { name: string; phase: AlgorithmPhase; reason: string; timestamp: string },
): AlgorithmRun {
  return {
    ...run,
    updatedAt: input.timestamp,
    capabilities: dedupeCapabilities(run.capabilities, input.name),
    capabilitySelections: [
      ...selections,
      {
        name: input.name,
        phase: input.phase,
        reason: input.reason,
        status: "selected",
        selectedAt: input.timestamp,
      },
    ],
  };
}

export function recordAlgorithmCapabilityInvocation(
  run: AlgorithmRun,
  input: RecordAlgorithmCapabilityInvocationInput,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const name = input.name.trim();
  const evidence = input.evidence.trim();
  const definition = getAlgorithmCapabilityDefinition(name, run);
  const selections = run.capabilitySelections ?? [];
  const selectionIndex = findSelectionIndex(selections, name);

  assertNonEmpty(evidence, "capability invocation evidence");

  if (selectionIndex === -1) {
    throw new Error(`Algorithm capability must be selected before invocation: ${name}`);
  }

  // A `contract` kind means DECLARED by contract, never BOUND. Binding happens
  // by overriding the name in `capabilities.local.md`, and the binding row
  // resolves to skill/agent/command/inline instead — so `contract` at invoke
  // time is precisely "nothing on this machine can run this".
  //
  // `contract` is its own kind rather than a flag on `adapter` (Sage review).
  // CONTEXT.md §adapter reserves that word for the actor that performs a
  // projection and puts invocation on SubstrateExecutor, "never to an adapter";
  // persisting a declared contract as an adapter pushed that collision into
  // public capability state. `adapter` remains a valid kind a skill manifest may
  // declare, and such a definition targets a real skill and stays invocable.
  //
  // Without this refusal the doctrine's claim was false (Sage review, soma#574):
  // invocation asks only for non-empty evidence, so a run could select
  // CrossFamilyAudit, perform no audit, record "audited" as evidence, and
  // COMPLETE — a fabricated second opinion passing as a real one. That is the
  // hollow pass the VerificationGate refuses for criteria; capabilities need the
  // same floor, or the contract row becomes a way to buy tier-floor credit for
  // work nobody did.
  if (definition.kind === "contract") {
    throw new Error(
      `Algorithm capability "${name}" is a contract with no binding on this machine, so it cannot be invoked. `
        + `Bind it by adding a row of the same name to <soma-home>/skills/the-algorithm/references/capabilities.local.md `
        + `with a concrete Skill("…"), Agent(…), or Bash(…) cell — or remove the selection and record the gap in ## Decisions.`,
    );
  }

  const invocation: AlgorithmCapabilityInvocation = {
    timestamp,
    substrate: input.substrate ?? run.substrate ?? "custom",
    contract: definition.invoke.contract,
    target: definition.invoke.target,
    evidence,
  };

  const next = {
    ...run,
    updatedAt: timestamp,
    capabilities: dedupeCapabilities(run.capabilities, name),
    capabilitySelections: selections.map((selection, index) =>
      index === selectionIndex
        ? {
            ...selection,
            status: "invoked" as const,
            invocation,
          }
        : selection,
    ),
  };
  return appendAlgorithmProvenance(next, {
    timestamp,
    phase: getRunPhase(run),
    operation: "capability.invoke",
    substrate: invocation.substrate,
    detail: name,
  });
}

export function removeAlgorithmCapabilitySelection(
  run: AlgorithmRun,
  input: RemoveAlgorithmCapabilityInput,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const name = input.name.trim();
  const reason = input.reason.trim();
  assertNonEmpty(reason, "capability removal reason");

  const selections = run.capabilitySelections ?? [];
  const selectionIndex = findSelectionIndex(selections, name);

  if (selectionIndex === -1) {
    throw new Error(`Algorithm capability selection not found: ${name}`);
  }

  return {
    ...run,
    updatedAt: timestamp,
    capabilitySelections: selections.map((selection, index) =>
      index === selectionIndex
        ? {
            ...selection,
            status: "removed",
            removalReason: reason,
            removedAt: timestamp,
          }
        : selection,
    ),
  };
}

export function unresolvedAlgorithmCapabilitySelections(run: AlgorithmRun): AlgorithmCapabilitySelection[] {
  return (run.capabilitySelections ?? []).filter(
    (selection) => selection.status === "selected" || selection.status === "failed",
  );
}

export function assertAlgorithmCapabilitiesSatisfied(run: AlgorithmRun): void {
  const unresolved = unresolvedAlgorithmCapabilitySelections(run);

  if (unresolved.length > 0) {
    const summary = unresolved.map((selection) => `${selection.name} (${capabilityStatusText(selection.status)})`).join(", ");
    throw new Error(`Algorithm cannot COMPLETE with selected capabilities that were not invoked or removed: ${summary}`);
  }
}
