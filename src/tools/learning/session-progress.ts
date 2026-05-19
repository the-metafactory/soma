import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathsForLearningOptions } from "./paths";
import type { LearningToolOptions, SessionProgressRecord } from "./types";

function slugProject(project: string): string {
  const slug = project.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Project is required.");
  return slug;
}

function progressPath(project: string, options: LearningToolOptions): string {
  return pathsForLearningOptions(options).resolve("memory", "STATE", "progress", `${slugProject(project)}-progress.json`);
}

async function loadProgress(project: string, options: LearningToolOptions): Promise<SessionProgressRecord> {
  const path = progressPath(project, options);
  const content = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`No progress file for ${project}`);
    }
    throw error;
  });
  return JSON.parse(content) as SessionProgressRecord;
}

async function saveProgress(progress: SessionProgressRecord, options: LearningToolOptions): Promise<string> {
  const path = progressPath(progress.project, options);
  await mkdir(dirname(path), { recursive: true });
  progress.updated = (options.now ?? new Date()).toISOString();
  await writeFile(path, JSON.stringify(progress, null, 2), "utf8");
  return path;
}

export async function createSessionProgress(
  project: string,
  objectives: string[] = [],
  options: LearningToolOptions = {},
): Promise<SessionProgressRecord> {
  const now = (options.now ?? new Date()).toISOString();
  const progress: SessionProgressRecord = {
    project: slugProject(project),
    created: now,
    updated: now,
    status: "active",
    objectives,
    decisions: [],
    work_completed: [],
    blockers: [],
    handoff_notes: [],
    next_steps: [],
  };
  await saveProgress(progress, options);
  return progress;
}

export async function recordSessionDecision(project: string, text: string, options: LearningToolOptions = {}): Promise<SessionProgressRecord> {
  return updateProgress(project, options, (progress, timestamp) => {
    progress.decisions.push({ text, timestamp });
  });
}

export async function recordSessionWork(project: string, text: string, options: LearningToolOptions = {}): Promise<SessionProgressRecord> {
  return updateProgress(project, options, (progress, timestamp) => {
    progress.work_completed.push({ text, timestamp });
  });
}

export async function recordSessionBlocker(project: string, text: string, options: LearningToolOptions = {}): Promise<SessionProgressRecord> {
  return updateProgress(project, options, (progress, timestamp) => {
    progress.status = "blocked";
    progress.blockers.push({ text, timestamp });
  });
}

export async function recordSessionNextStep(project: string, text: string, options: LearningToolOptions = {}): Promise<SessionProgressRecord> {
  return updateProgress(project, options, (progress) => {
    progress.next_steps.push(text);
  });
}

export async function recordSessionHandoff(project: string, text: string, options: LearningToolOptions = {}): Promise<SessionProgressRecord> {
  return updateProgress(project, options, (progress) => {
    progress.handoff_notes.push(text);
  });
}

export async function completeSessionProgress(project: string, options: LearningToolOptions = {}): Promise<SessionProgressRecord> {
  return updateProgress(project, options, (progress) => {
    progress.status = "completed";
  });
}

async function updateProgress(
  project: string,
  options: LearningToolOptions,
  mutate: (progress: SessionProgressRecord, timestamp: string) => void,
): Promise<SessionProgressRecord> {
  const progress = await loadProgress(project, options);
  mutate(progress, (options.now ?? new Date()).toISOString());
  await saveProgress(progress, options);
  return progress;
}

export async function resumeSessionProgress(project: string, options: LearningToolOptions = {}): Promise<string> {
  const progress = await loadProgress(project, options);
  return [
    `SESSION RESUME: ${progress.project}`,
    `Status: ${progress.status}`,
    `Updated: ${progress.updated}`,
    "",
    "Objectives:",
    ...(progress.objectives.length ? progress.objectives.map((item, index) => `${index + 1}. ${item}`) : ["None"]),
    "",
    "Recent decisions:",
    ...(progress.decisions.slice(-5).map((item) => `- ${item.text}`)),
    "",
    "Recent work:",
    ...(progress.work_completed.slice(-5).map((item) => `- ${item.text}`)),
    "",
    "Blockers:",
    ...(progress.blockers.filter((item) => item).map((item) => `- ${item.text}`)),
    "",
    "Next steps:",
    ...(progress.next_steps.map((item, index) => `${index + 1}. ${item}`)),
    "",
    "Handoff:",
    ...(progress.handoff_notes.map((item) => `- ${item}`)),
    "",
  ].join("\n");
}

export async function listSessionProgress(options: LearningToolOptions = {}): Promise<SessionProgressRecord[]> {
  const dir = pathsForLearningOptions(options).resolve("memory", "STATE", "progress");
  const files = await readdir(dir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const records = await Promise.all(files.filter((file) => file.endsWith("-progress.json")).map(async (file) =>
    JSON.parse(await readFile(join(dir, file), "utf8")) as SessionProgressRecord
  ));
  return records.sort((a, b) => b.updated.localeCompare(a.updated));
}
