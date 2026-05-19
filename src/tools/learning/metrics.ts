import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathsForLearningOptions } from "./paths";
import type { LearningToolOptions, SomaCounts } from "./types";

async function readDirOrEmpty(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
}

async function readFileOrEmpty(path: string): Promise<string> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function countFilesRecursive(dir: string, predicate: (file: string) => boolean = () => true): Promise<number> {
  const counts = await Promise.all((await readDirOrEmpty(dir)).map(async (entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return countFilesRecursive(full, predicate);
    return entry.isFile() && predicate(entry.name) ? 1 : 0;
  }));
  return counts.reduce((sum, count) => sum + count, 0);
}

async function countSkills(skillsDir: string): Promise<number> {
  const counts: number[] = await Promise.all((await readDirOrEmpty(skillsDir)).map(async (entry) =>
    entry.isDirectory() && await exists(join(skillsDir, entry.name, "SKILL.md")) ? 1 : 0
  ));
  return counts.reduce((sum, count) => sum + count, 0);
}

async function countWorkflowFiles(dir: string): Promise<number> {
  const counts = await Promise.all((await readDirOrEmpty(dir)).map(async (entry) => {
    if (!entry.isDirectory()) return 0;
    const full = join(dir, entry.name);
    return entry.name.toLowerCase() === "workflows"
      ? await countFilesRecursive(full, (file) => file.endsWith(".md"))
      : await countWorkflowFiles(full);
  }));
  return counts.reduce((sum, count) => sum + count, 0);
}

async function countDirectDirectories(dir: string): Promise<number> {
  return (await readDirOrEmpty(dir)).filter((entry) => entry.isDirectory()).length;
}

async function countJsonlLines(path: string): Promise<number> {
  const content = await readFileOrEmpty(path);
  return content.split("\n").filter((line) => line.trim()).length;
}

export async function getSomaCounts(options: LearningToolOptions = {}): Promise<SomaCounts> {
  const paths = pathsForLearningOptions(options);
  const [skills, workflows, signals, files, work, research, ratings] = await Promise.all([
    countSkills(paths.skills()),
    countWorkflowFiles(paths.skills()),
    countFilesRecursive(paths.learning(), (file) => file.endsWith(".md")),
    countFilesRecursive(paths.identity()),
    countDirectDirectories(paths.work()),
    countFilesRecursive(paths.resolve("memory", "RESEARCH"), (file) => file.endsWith(".md") || file.endsWith(".json")),
    countJsonlLines(paths.ratings()),
  ]);
  return {
    skills,
    workflows,
    signals,
    files,
    work,
    research,
    ratings,
  };
}

export function formatCountsShell(counts: SomaCounts): string {
  return Object.entries(counts).map(([key, value]) => `${key}_count=${value}`).join("\n") + "\n";
}
