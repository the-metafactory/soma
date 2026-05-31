import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readAlgorithmRunById, writeAlgorithmRun } from "./algorithm-store";
import { appendAlgorithmProvenance } from "./algorithm-provenance";
import { appendSomaMemoryEvent } from "./memory";
import { getCriteria, getGoal } from "./isa-accessors";
import { getRunPhase } from "./algorithm-lifecycle";
import type { AlgorithmRun, SomaMemoryPromotionOptions, SomaMemoryPromotionResult } from "./types";

const PROMOTION_STORE_DIRS = {
  learning: "LEARNING",
  knowledge: "KNOWLEDGE",
  relationship: "RELATIONSHIP",
  work: "WORK",
} as const;

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Soma memory promotion ${field} must not be empty.`);
  }
}

function resolveSomaHome(options: Pick<SomaMemoryPromotionOptions, "homeDir" | "somaHome"> = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "memory"
  );
}

function checkedCriteria(run: AlgorithmRun): string[] {
  return getCriteria(run.isa).map((criterion) => {
    const mark = criterion.status === "passed" ? "x" : criterion.status === "dropped" ? "-" : " ";
    const verification = criterion.verification ? ` Evidence: ${criterion.verification}` : "";
    return `- [${mark}] ${criterion.id}: ${criterion.text}${verification}`;
  });
}

function promotionLesson(run: AlgorithmRun, explicitLesson?: string): string {
  if (explicitLesson?.trim()) return explicitLesson.trim();

  const learned = run.learning.at(-1)?.text;
  if (learned) return learned;

  const decision = run.decisions.at(-1)?.text;
  if (decision) return decision;

  return getGoal(run.isa) ?? "";
}

function hasPromotionVerification(run: AlgorithmRun): boolean {
  return run.verification.length > 0 || getCriteria(run.isa).some((criterion) => criterion.status === "passed");
}

function renderPromotionContent(input: {
  run: AlgorithmRun;
  runPath: string;
  title: string;
  store: SomaMemoryPromotionOptions["store"];
  lesson: string;
  appliesWhen?: string;
  timestamp: string;
}): string {
  return [
    `# ${input.title}`,
    "",
    `Promoted: ${input.timestamp}`,
    `Store: ${input.store}`,
    `Source run: ${input.run.id}`,
    `Source path: ${input.runPath}`,
    `Phase: ${getRunPhase(input.run)}`,
    `Effort: ${input.run.effort}`,
    "",
    "## Durable Lesson",
    "",
    input.lesson,
    "",
    "## Recall When",
    "",
    input.appliesWhen?.trim() ?? "Recall when similar work, decisions, or relationship context appears.",
    "",
    "## Source Goal",
    "",
    getGoal(input.run.isa) ?? "",
    "",
    "## Source Criteria",
    "",
    ...checkedCriteria(input.run),
    "",
    "## Source Decisions",
    "",
    ...(input.run.decisions.length > 0 ? input.run.decisions.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No decisions recorded."]),
    "",
    "## Source Verification",
    "",
    ...(input.run.verification.length > 0 ? input.run.verification.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No verification recorded."]),
  ].join("\n");
}

export async function promoteAlgorithmRunMemory(options: SomaMemoryPromotionOptions): Promise<SomaMemoryPromotionResult> {
  assertNonEmpty(options.fromRun, "source run");
  assertNonEmpty(options.title, "title");

  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const { path: sourceRunPath, run } = await readAlgorithmRunById(options.fromRun, { somaHome });
  const lesson = promotionLesson(run, options.lesson);

  if (!hasPromotionVerification(run)) {
    throw new Error(`Algorithm run ${run.id} has no verification evidence or passed criteria; refusing memory promotion.`);
  }

  const relativeStore = PROMOTION_STORE_DIRS[options.store];
  const path = join(somaHome, "memory", relativeStore, "PROMOTED", `${slugify(options.title)}-${slugify(run.id)}.md`);
  const content = `${renderPromotionContent({
    run,
    runPath: sourceRunPath,
    title: options.title,
    store: options.store,
    lesson,
    appliesWhen: options.appliesWhen,
    timestamp,
  })}\n`;

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw new Error(`Soma memory promotion already exists: ${path}`, { cause: error });
    }
    throw error;
  }

  const event = await appendSomaMemoryEvent(somaHome, {
    timestamp,
    substrate: options.substrate ?? run.substrate ?? "custom",
    kind: "memory.promotion",
    summary: `Promoted Algorithm run ${run.id} to ${options.store}: ${options.title}`,
    artifactPaths: [path, sourceRunPath],
    metadata: {
      runId: run.id,
      store: options.store,
    },
  }).catch(async (error: unknown) => {
    await unlink(path).catch(() => undefined);
    throw new Error(`Soma memory promotion event append failed; removed promotion note: ${path}`, { cause: error });
  });
  await writeAlgorithmRun(
    appendAlgorithmProvenance(run, {
      timestamp,
      operation: "memory.promote",
      substrate: options.substrate,
      detail: options.store,
    }),
    { somaHome },
  );

  return {
    somaHome,
    store: options.store,
    path,
    sourceRunPath,
    event,
  };
}
