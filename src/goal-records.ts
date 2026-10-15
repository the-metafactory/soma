import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GOAL_STATUSES, type GoalRecord } from "./types";

/**
 * Goal records (soma#784 D2–D5, D7–D9): one file per goal at
 * `<soma-home>/profile/goals/G<n>.md`. The frontmatter is typed and checked
 * with Zod; the body is private, and its first line is the goal's wording.
 *
 * Loading never fails the home: a file whose frontmatter does not parse is
 * skipped with one warning, and the rest still load. `sweep.yaml` and any file
 * not named `G<n>.md` are ignored here.
 */


const GOAL_FILE = /^(G\d+)\.md$/;
const MISSION_CODE = /^(M\d+)\b/;

export interface GoalRecordWarning {
  /** File name under `profile/goals/`, e.g. `G5.md`. */
  file: string;
  /** The frontmatter field (or `wording`) the warning is about. */
  field: string;
  message: string;
}

export interface GoalRecordsLoad {
  goals: GoalRecord[];
  warnings: GoalRecordWarning[];
}

// Zod is imported lazily: the home loads on every SessionStart, and most homes
// have no goal files, so they should not pay the module load.
async function goalFrontmatterSchema() {
  const { z } = await import("zod");
  return z.object({
    id: z.string().regex(/^G\d+$/, "must match G<n>"),
    status: z.enum(GOAL_STATUSES),
    supports: z.array(z.string()).default([]),
    sensor: z.string().min(1).optional(),
    review_by: z.iso.date().optional(),
    pursuit_window: z.number().int().positive().optional(),
  });
}

/** The `M<n>` codes that the mission bullets start with. */
export function missionCodes(missions: readonly string[]): Set<string> {
  const codes = new Set<string>();
  for (const mission of missions) {
    const code = MISSION_CODE.exec(mission)?.[1];
    if (code !== undefined) codes.add(code);
  }
  return codes;
}

function goalNumber(id: string): number {
  return Number(id.slice(1));
}

function splitGoalFile(content: string): { frontmatter: string; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  return match ? { frontmatter: match[1], body: match[2] } : undefined;
}

function wordingOf(body: string): string {
  const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
  return first.trim().replace(/^#+\s+/, "");
}

async function readGoalFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => GOAL_FILE.test(name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Load every `G<n>.md` under `goalsDir`, in id order. `missions` are the
 * Purpose mission bullets; a `supports` code none of them starts with loads
 * but warns.
 */
export async function loadGoalRecords(goalsDir: string, missions: readonly string[]): Promise<GoalRecordsLoad> {
  const files = await readGoalFiles(goalsDir);
  if (files.length === 0) return { goals: [], warnings: [] };

  const schema = await goalFrontmatterSchema();
  const known = missionCodes(missions);
  const contents = await Promise.all(files.map((file) => readFile(join(goalsDir, file), "utf8")));
  const goals: GoalRecord[] = [];
  const warnings: GoalRecordWarning[] = [];
  const skip = (file: string, field: string, reason: string) =>
    warnings.push({ file, field, message: `soma: skipped goal file ${file}: ${field}: ${reason}` });

  files.forEach((file, index) => {
    const parts = splitGoalFile(contents[index] ?? "");
    if (parts === undefined) return skip(file, "frontmatter", "missing --- frontmatter block");

    let raw: unknown;
    try {
      raw = Bun.YAML.parse(parts.frontmatter);
    } catch (error) {
      return skip(file, "frontmatter", error instanceof Error ? error.message : String(error));
    }

    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      // Zod reports at least one issue on failure; the first names the field.
      const [issue] = parsed.error.issues;
      return skip(file, issue.path.join(".") || "frontmatter", issue.message);
    }

    const data = parsed.data;
    const stem = GOAL_FILE.exec(file)?.[1];
    if (data.id !== stem) return skip(file, "id", `${data.id} does not match the file name`);

    const wording = wordingOf(parts.body);
    if (wording === "") return skip(file, "wording", "the body has no first line");

    if (data.status === "active") {
      const missing = [data.sensor === undefined ? "sensor" : undefined, data.review_by === undefined ? "review_by" : undefined]
        .filter((field): field is string => field !== undefined);
      if (missing.length > 0) {
        warnings.push({
          file,
          field: missing.join(", "),
          message: `soma: goal ${data.id} (${file}) is active without ${missing.join(" and ")}`,
        });
      }
    }

    for (const code of data.supports) {
      if (!known.has(code)) {
        warnings.push({
          file,
          field: "supports",
          message: `soma: goal ${data.id} (${file}) supports ${code}, but no mission starts with ${code}`,
        });
      }
    }

    goals.push({
      id: data.id,
      status: data.status,
      supports: data.supports,
      ...(data.sensor === undefined ? {} : { sensor: data.sensor }),
      ...(data.review_by === undefined ? {} : { reviewBy: data.review_by }),
      ...(data.pursuit_window === undefined ? {} : { pursuitWindow: data.pursuit_window }),
      wording,
      body: parts.body,
    });
  });

  goals.sort((a, b) => goalNumber(a.id) - goalNumber(b.id));
  return { goals, warnings };
}

/** The `active` goals, in id order, as `G<n>: <wording> (supports M…)`. */
export function activeGoalLines(goals: readonly GoalRecord[]): string[] {
  return goals
    .filter((goal) => goal.status === "active")
    .sort((a, b) => goalNumber(a.id) - goalNumber(b.id))
    .map((goal) => {
      const supports = goal.supports.length === 0 ? "" : ` (supports ${goal.supports.join(", ")})`;
      return `${goal.id}: ${goal.wording}${supports}`;
    });
}

export interface AddGoalOptions {
  supports: string[];
  wording: string;
  sensor?: string;
  reviewBy?: string;
}

/** Allocate from file names, including invalid records; never fill a gap. */
export async function addGoalRecord(goalsDir: string, options: AddGoalOptions): Promise<string> {
  if (!options.wording.trim() || /[\r\n]/.test(options.wording)) {
    throw new Error("wording must be a non-empty single line");
  }
  if (options.supports.some((code) => !/^M\d+$/.test(code))) {
    throw new Error("supports must contain M<n> mission codes");
  }
  const schema = await goalFrontmatterSchema();
  const fields = {
    id: "G5", status: "draft", supports: options.supports,
    ...(options.sensor === undefined ? {} : { sensor: options.sensor }),
    ...(options.reviewBy === undefined ? {} : { review_by: options.reviewBy }),
  };
  const parsed = schema.safeParse(fields);
  if (!parsed.success) throw new Error(`Invalid goal field: ${parsed.error.issues[0].path.join(".")}`);
  await mkdir(goalsDir, { recursive: true, mode: 0o700 });
  for (;;) {
    const ids = (await readGoalFiles(goalsDir)).map((file) => BigInt(file.slice(1, -3)));
    const next = ids.reduce((max, id) => id > max ? id : max, 4n) + 1n;
    const id = `G${next}`;
    // JSON string literals are YAML-safe, even for sensor ids with punctuation.
    const lines = [`id: ${id}`, "status: draft", `supports: ${JSON.stringify(options.supports)}`];
    if (options.sensor !== undefined) lines.push(`sensor: ${JSON.stringify(options.sensor)}`);
    if (options.reviewBy !== undefined) lines.push(`review_by: ${options.reviewBy}`);
    try {
      await writeFile(join(goalsDir, `${id}.md`), `---\n${lines.join("\n")}\n---\n${options.wording}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      return id;
    } catch (error) {
      // Another author may have allocated the same id since our directory read.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function readGoalRecord(goalsDir: string, id: string) {
  if (!/^G\d+$/.test(id)) throw new Error("Goal id must match G<n>");
  const path = join(goalsDir, `${id}.md`);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Goal ${id} does not exist: ${path}`, { cause: error });
    throw new Error(`Cannot read goal ${id}: ${path}`, { cause: error });
  }
  const parts = splitGoalFile(content);
  if (!parts) throw new Error(`Invalid frontmatter: ${path}`);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(parts.frontmatter);
  } catch {
    // Parser diagnostics can include private body or field text.
    throw new Error(`Unparseable goal frontmatter: ${path}`);
  }
  const parsed = (await goalFrontmatterSchema()).safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid goal field ${parsed.error.issues[0].path.join(".") || "frontmatter"}: ${path}`);
  if (parsed.data.id !== id) throw new Error(`Goal id does not match file name: ${path}`);
  return { path, content, parts, data: parsed.data };
}

/** Strict CLI listing; warnings never echo private goal content. */
export async function listGoalRecords(goalsDir: string): Promise<GoalRecord[]> {
  const goals = await Promise.all((await readGoalFiles(goalsDir)).map(async (file) => {
    const { data, parts } = await readGoalRecord(goalsDir, file.slice(0, -3));
    return {
      id: data.id, status: data.status, supports: data.supports,
      sensor: data.sensor, reviewBy: data.review_by, pursuitWindow: data.pursuit_window,
      wording: wordingOf(parts.body), body: parts.body,
    };
  }));
  return goals.sort((a, b) => {
    const left = BigInt(a.id.slice(1));
    const right = BigInt(b.id.slice(1));
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

type GoalFile = Awaited<ReturnType<typeof readGoalRecord>>;
export type InactiveGoalStatus = Exclude<GoalRecord["status"], "active">;

async function writeGoalStatus(goal: GoalFile, status: GoalRecord["status"]): Promise<void> {
  // Patch only the scalar, retaining key spelling, quotes, comments and CRLF.
  const field = /^((?:status|"status"|'status')[ \t]*:[ \t]*)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\r\n]|'')*'|[^\s#]+)([ \t]*(?:#[^\r\n]*)?)(\r?)$/gm;
  const matches = [...goal.parts.frontmatter.matchAll(field)];
  if (matches.length !== 1) throw new Error(`status must be a single-line scalar: ${goal.path}`);
  const match = matches[0];
  const quote = match[2].startsWith('"') ? '"' : match[2].startsWith("'") ? "'" : "";
  const offset = goal.content.indexOf("\n") + 1 + match.index + match[1].length;
  const updated = goal.content.slice(0, offset) + quote + status + quote + goal.content.slice(offset + match[2].length);
  await writeFile(goal.path, updated, "utf8");
}

export async function setGoalStatus(goalsDir: string, id: string, status: InactiveGoalStatus): Promise<void> {
  if (!(GOAL_STATUSES as readonly string[]).includes(status) || (status as string) === "active") {
    throw new Error("set-status accepts paused, achieved, dropped or draft; use activate to become active");
  }
  await writeGoalStatus(await readGoalRecord(goalsDir, id), status);
}

async function blueprintSensorIds(activationsDir: string): Promise<Set<string>> {
  let files: string[];
  try {
    files = (await readdir(activationsDir)).filter((file) => file.endsWith(".yaml")).sort();
  } catch {
    throw new Error(`Cannot read Reflex activations directory: ${activationsDir}`);
  }
  const { z } = await import("zod");
  const schema = z.object({
    schema: z.literal("metafactory/activation/v1"),
    activations: z.array(z.object({ id: z.string().min(1) })),
  });
  const ids = new Set<string>();
  for (const file of files) {
    const path = join(activationsDir, file);
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error(`Unparseable or unreadable Reflex blueprint: ${path}`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid Reflex blueprint (expected metafactory/activation/v1 with activations[].id): ${path}`);
    for (const activation of parsed.data.activations) ids.add(activation.id);
  }
  return ids;
}

export async function activateGoalRecord(goalsDir: string, id: string, activationsDir: string): Promise<void> {
  const goal = await readGoalRecord(goalsDir, id);
  if (!goal.data.sensor) throw new Error(`Goal ${id} is missing sensor: ${goal.path}`);
  if (!goal.data.review_by) throw new Error(`Goal ${id} is missing review_by: ${goal.path}`);
  if (!(await blueprintSensorIds(activationsDir)).has(goal.data.sensor)) {
    throw new Error(`Goal ${id} sensor is absent from Reflex blueprints: ${activationsDir}`);
  }
  await writeGoalStatus(goal, "active");
}
