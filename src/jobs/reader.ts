import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { classifyJobs, isInventoryLabel, jobPlistSchema, parseLaunchctlRows, type JobActivity, type JobRecord, type JobRow, type LaunchctlRow } from "./inventory";

export interface JobsReader {
  entries: (path: string) => Promise<{ name: string; directory: boolean }[]>;
  readText: (path: string) => Promise<string>;
  fileInfo: (path: string) => Promise<{ size: number; modifiedAt: Date }>;
  exec: (argv: string[]) => Promise<string>;
}

export const machineJobsReader: JobsReader = {
  entries: async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
  readText: (path) => readFile(path, "utf8"),
  fileInfo: async (path) => {
    const info = await stat(path);
    return { size: info.size, modifiedAt: info.mtime };
  },
  exec: async (argv) => {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`${argv[0]} exited ${exit}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`);
    return stdout;
  },
};

export interface JobsInventory {
  rows: JobRow[];
  gaps: string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function activityFromLogs(paths: string[], reader: JobsReader): Promise<{ activity: JobActivity | null; diagnostic: string | null }> {
  const activity: JobActivity[] = [];
  const errors: string[] = [];
  for (const path of new Set(paths)) {
    try {
      const info = await reader.fileInfo(path);
      if (info.size > 0) activity.push({ at: info.modifiedAt.toISOString(), evidence: `output log mtime: ${path}` });
    } catch (error) {
      if (!missing(error)) errors.push(`cannot stat ${path}: ${message(error)}`);
    }
  }
  activity.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { activity: activity[0] ?? null, diagnostic: errors.length === 0 ? null : errors.join("; ") };
}

const reflexFileSchema = z.object({ activations: z.array(z.unknown()) });
const reflexActivationSchema = z.object({ id: z.string().min(1), when: z.object({ schedule: z.string().min(1).optional(), timezone: z.string().optional() }) });
const rangerFileSchema = z.object({ jobs: z.array(z.unknown()).default([]) });
const rangerJobSchema = z.object({ name: z.string().min(1), skill: z.string().min(1) });

async function declarations(path: string, source: "reflex" | "ranger", reader: JobsReader, scope = basename(path)): Promise<JobRecord[]> {
  const identity = { source, path, label: `${source}:${scope}` };
  try {
    const data: unknown = parseYaml(await reader.readText(path));
    const items = source === "reflex" ? reflexFileSchema.parse(data).activations : rangerFileSchema.parse(data).jobs;
    return items.flatMap((item, index): JobRecord[] => {
      try {
        if (source === "reflex") {
          const activation = reflexActivationSchema.parse(item);
          if (activation.when.schedule === undefined) return [];
          return [{ ...identity, kind: "declaration", label: `${identity.label}:${activation.id}`, schedule: `${activation.when.schedule} (${activation.when.timezone ?? "UTC"})`, diagnostic: "last run unavailable in Reflex schedule blueprint; no execution history inferred from a declaration" }];
        }
        const job = rangerJobSchema.parse(item);
        return [{ ...identity, kind: "declaration", label: `ranger:${job.name}`, schedule: null, diagnostic: "period and last run unavailable in Ranger skill declaration (triggered externally)" }];
      } catch (error) {
        return [{ ...identity, label: `${identity.label}:entry-${index + 1}`, kind: "error", error: `parse error: ${message(error)}` }];
      }
    });
  } catch (error) {
    return [{ ...identity, kind: "error", error: `parse/read error: ${message(error)}` }];
  }
}

async function readDirectory(path: string, reader: JobsReader, gaps: string[]): Promise<Awaited<ReturnType<JobsReader["entries"]>>> {
  try {
    return await reader.entries(path);
  } catch (error) {
    gaps.push(`${path}: ${message(error)}`);
    return [];
  }
}

export async function readJobsInventory(options: { reader?: JobsReader; homeDir?: string; now?: Date } = {}): Promise<JobsInventory> {
  const reader = options.reader ?? machineJobsReader;
  const home = options.homeDir ?? homedir();
  const records: JobRecord[] = [];
  const gaps: string[] = [];
  let launchctl: LaunchctlRow[] = [];
  try {
    launchctl = parseLaunchctlRows(await reader.exec(["launchctl", "list"]));
  } catch (error) {
    gaps.push(`launchctl status unavailable: ${message(error)}`);
  }
  const launchAgents = join(home, "Library", "LaunchAgents");
  for (const entry of await readDirectory(launchAgents, reader, gaps)) {
    if (entry.directory || !entry.name.endsWith(".plist")) continue;
    const path = join(launchAgents, entry.name);
    let label = basename(entry.name, ".plist");
    try {
      const raw: unknown = JSON.parse(await reader.exec(["plutil", "-convert", "json", "-o", "-", path]));
      label = jobPlistSchema.pick({ Label: true }).parse(raw).Label;
      if (!isInventoryLabel(label)) continue;
      const plist = jobPlistSchema.parse(raw);
      const logs = [plist.StandardOutPath, plist.StandardErrorPath].filter((value): value is string => value !== undefined);
      records.push({ kind: "parsed", source: "launchd", label: plist.Label, path, plist, ...await activityFromLogs(logs, reader) });
    } catch (error) {
      if (isInventoryLabel(label)) records.push({ kind: "error", source: "launchd", label, path, error: `plist parse/read error: ${message(error)}` });
    }
  }
  const reflex = join(home, ".config", "reflex");
  async function readActivations(path: string): Promise<void> {
    for (const entry of await readDirectory(path, reader, gaps)) {
      const child = join(path, entry.name);
      if (entry.directory) await readActivations(child);
      else if (/\.ya?ml$/.test(entry.name)) records.push(...await declarations(child, "reflex", reader, relative(reflex, child)));
    }
  }
  let activationSources = 0;
  for (const entry of await readDirectory(reflex, reader, gaps)) {
    if (!entry.name.includes("activations")) continue;
    const path = join(reflex, entry.name);
    if (entry.directory) { await readActivations(path); activationSources++; }
    else if (/\.ya?ml$/.test(entry.name)) { records.push(...await declarations(path, "reflex", reader, relative(reflex, path))); activationSources++; }
  }
  if (activationSources === 0) gaps.push("No Reflex *activations* sources found");
  records.push(...await declarations(join(home, ".config", "ranger", "ranger.yaml"), "ranger", reader));
  return { rows: classifyJobs({ records, launchctl, now: options.now ?? new Date() }), gaps };
}
