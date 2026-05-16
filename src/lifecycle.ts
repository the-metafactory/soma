import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAlgorithmRunSummaries, listAlgorithmRuns } from "./algorithm-store";
import { appendSomaMemoryEvent } from "./memory";
import { loadSomaHome } from "./soma-home";
import { getCriteria, getGoal } from "./isa-accessors";
import { getRunPhase } from "./algorithm-lifecycle";
import type {
  AlgorithmRun,
  AlgorithmRunSummary,
  AlgorithmWorkIndex,
  SomaLifecycleOptions,
  SomaLifecycleResult,
  SomaStartupContext,
  SubstrateId,
} from "./types";

function resolveSomaHome(options: SomaLifecycleOptions = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  return resolve(options.somaHome ?? join(home, ".soma"));
}

function substrate(options: SomaLifecycleOptions): SubstrateId {
  return options.substrate ?? "custom";
}

async function readRecentMarkdown(root: string, limit: number): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => {
        const path = join(root, entry.name);
        const content = await readFile(path, "utf8");
        const title = content
          .split("\n")
          .find((line) => line.startsWith("# "))
          ?.slice(2)
          .trim();

        return {
          path,
          title: title === "" || title === undefined ? entry.name : title,
        };
      }),
  );

  return files
    .sort((a, b) => b.path.localeCompare(a.path))
    .slice(0, limit)
    .map((file) => `${file.title} (${file.path})`);
}

function renderRunSummary(summary: AlgorithmRunSummary): string {
  return `- ${summary.id}: ${summary.phase.toUpperCase()} ${summary.progress} ${summary.effort} - ${summary.goal}`;
}

function renderStartupContext(input: {
  assistantName: string;
  principalName: string;
  mission?: string;
  activeRuns: AlgorithmRunSummary[];
  recentLearnings: string[];
  relationshipNotes: string[];
}): string {
  return [
    "# Soma Startup Context",
    "",
    `Assistant: ${input.assistantName}`,
    `Principal: ${input.principalName}`,
    input.mission ? `Mission: ${input.mission}` : undefined,
    "",
    "## Active Algorithm Runs",
    input.activeRuns.length > 0 ? input.activeRuns.map(renderRunSummary).join("\n") : "No active Algorithm runs.",
    "",
    "## Recent Learning",
    input.recentLearnings.length > 0 ? input.recentLearnings.map((item) => `- ${item}`).join("\n") : "No recent learning artifacts.",
    "",
    "## Relationship Notes",
    input.relationshipNotes.length > 0 ? input.relationshipNotes.map((item) => `- ${item}`).join("\n") : "No recent relationship notes.",
    "",
    "## Operating Contract",
    "- Use active Algorithm runs as the work-state source of truth.",
    "- Create or update Algorithm runs for substantial work.",
    "- Preserve verification evidence before declaring criteria complete.",
    "- Write durable observations through Soma memory, not substrate-local scratch files.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function buildSomaStartupContext(options: SomaLifecycleOptions = {}): Promise<SomaStartupContext> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const profile = await loadSomaHome(somaHome);
  const summaries = await listAlgorithmRunSummaries({ somaHome });
  const activeRuns = summaries.filter((run) => run.phase !== "complete").slice(0, 8);
  const recentLearnings = await readRecentMarkdown(join(somaHome, "memory/LEARNING"), 8);
  const relationshipNotes = await readRecentMarkdown(join(somaHome, "memory/RELATIONSHIP"), 8);
  const context = renderStartupContext({
    assistantName: profile.profile.assistant.displayName ?? profile.profile.assistant.name,
    principalName: profile.profile.principal.preferredName ?? profile.profile.principal.name,
    mission: profile.profile.telos.mission,
    activeRuns,
    recentLearnings,
    relationshipNotes,
  });

  return {
    somaHome,
    timestamp,
    substrate: substrate(options),
    sessionId: options.sessionId,
    context,
    activeRuns,
    recentLearnings,
    relationshipNotes,
  };
}

export async function writeAlgorithmWorkIndex(options: SomaLifecycleOptions = {}): Promise<{ path: string; index: AlgorithmWorkIndex }> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const index: AlgorithmWorkIndex = {
    updatedAt: timestamp,
    runs: await listAlgorithmRunSummaries({ somaHome }),
  };
  const path = join(somaHome, "memory/STATE/algorithm-work-index.json");

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  return { path, index };
}

function completedLearningContent(run: AlgorithmRun, timestamp: string): string {
  return [
    `# Algorithm Learning: ${run.id}`,
    "",
    `Captured: ${timestamp}`,
    `Run: ${run.id}`,
    `Goal: ${getGoal(run.isa) ?? ""}`,
    `Effort: ${run.effort}`,
    "",
    "## Criteria",
    ...getCriteria(run.isa).map((criterion) => `- [${criterion.status === "passed" ? "x" : " "}] ${criterion.id}: ${criterion.text}`),
    "",
    "## Verification",
    ...(run.verification.length > 0 ? run.verification.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No verification entries recorded."]),
    "",
    "## Learning",
    ...(run.learning.length > 0 ? run.learning.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No learning entries recorded."]),
  ].join("\n");
}

export async function captureCompletedAlgorithmLearnings(options: SomaLifecycleOptions = {}): Promise<string[]> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const runs = await listAlgorithmRuns({ somaHome });
  const written: string[] = [];

  for (const { run } of runs) {
    if (getRunPhase(run) !== "complete") {
      continue;
    }

    const path = join(somaHome, "memory/LEARNING/ALGORITHM", `${run.id}.md`);
    const exists = await readFile(path, "utf8").then(
      () => true,
      () => false,
    );

    if (exists) {
      continue;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${completedLearningContent(run, timestamp)}\n`, "utf8");
    written.push(path);
  }

  return written;
}

export async function runSomaLifecycleSessionStart(options: SomaLifecycleOptions = {}): Promise<SomaLifecycleResult> {
  const startup = await buildSomaStartupContext(options);
  await appendSomaMemoryEvent(startup.somaHome, {
    substrate: startup.substrate,
    kind: "lifecycle.session_start",
    summary: `Session started${startup.sessionId ? `: ${startup.sessionId}` : ""}`,
    timestamp: startup.timestamp,
    metadata: {
      sessionId: startup.sessionId,
      activeRuns: startup.activeRuns.map((run) => run.id),
    },
  });

  return {
    event: "session_start",
    somaHome: startup.somaHome,
    timestamp: startup.timestamp,
    files: [join(startup.somaHome, "memory/STATE/events.jsonl")],
    context: startup.context,
  };
}

export async function runSomaLifecycleAlgorithmUpdated(options: SomaLifecycleOptions = {}): Promise<SomaLifecycleResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const index = await writeAlgorithmWorkIndex({ ...options, somaHome, timestamp });
  await appendSomaMemoryEvent(somaHome, {
    substrate: substrate(options),
    kind: "lifecycle.algorithm_updated",
    summary: `Algorithm work index updated with ${index.index.runs.length} run(s).`,
    timestamp,
    artifactPaths: [index.path],
  });

  return {
    event: "algorithm_updated",
    somaHome,
    timestamp,
    files: [index.path, join(somaHome, "memory/STATE/events.jsonl")],
  };
}

export async function runSomaLifecycleSessionEnd(options: SomaLifecycleOptions = {}): Promise<SomaLifecycleResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const index = await writeAlgorithmWorkIndex({ ...options, somaHome, timestamp });
  const learningFiles = await captureCompletedAlgorithmLearnings({ ...options, somaHome, timestamp });
  await appendSomaMemoryEvent(somaHome, {
    substrate: substrate(options),
    kind: "lifecycle.session_end",
    summary: `Session ended; captured ${learningFiles.length} Algorithm learning artifact(s).`,
    timestamp,
    artifactPaths: [index.path, ...learningFiles],
    metadata: {
      sessionId: options.sessionId,
    },
  });

  return {
    event: "session_end",
    somaHome,
    timestamp,
    files: [index.path, ...learningFiles, join(somaHome, "memory/STATE/events.jsonl")],
  };
}
