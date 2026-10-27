import { mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";

const ACTIVATION_SCHEMA = "metafactory/activation/v1";

export const GOAL_STATUSES = ["draft", "active", "paused", "achieved", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * One goal (soma#784 D2–D8). The frontmatter fields are typed; `wording` is the
 * body's first line and `body` the whole private body (drop condition, notes).
 * Goal text stays in soma-home: only the id travels in envelopes and ledgers.
 */
export interface GoalRecord {
  /** `G<n>`, opaque and never reused. */
  id: string;
  status: GoalStatus;
  /** Mission codes (`M<n>`) this goal serves. */
  supports: string[];
  /** A reflex activation id that measures the goal. */
  sensor?: string;
  /** ISO date (`YYYY-MM-DD`) when the sweep recommends keep, revise or drop. */
  reviewBy?: string;
  /** Whole days a goal counts as pursued after its last live link (default 14). */
  pursuitWindow?: number;
  wording: string;
  body: string;
}

/**
 * Goal records (soma#784 D2–D5, D7–D9): one file per goal at
 * `<soma-home>/profile/goals/G<n>.md`. The frontmatter is typed and checked
 * with Zod; the body is private, and its first line is the goal's wording.
 *
 * A bad goal file never fails the home: one that cannot be read, or whose
 * frontmatter does not parse, is skipped with one warning, and the rest still
 * load. Only an unreadable `profile/goals/` directory itself rejects (a missing
 * one loads no goals). `sweep.yaml` and any file not named `G<n>.md` are
 * ignored here.
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
    return (await readdir(dir)).filter((name) => GOAL_FILE.test(name)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** One goal file as read: its content, or the reason it could not be read. */
export type GoalFileRead = { file: string; content: string } | { file: string; error: string };

/**
 * Read every `G<n>.md` under `goalsDir`. A file that cannot be read (EACCES, a
 * directory named `G5.md`) comes back with its error rather than rejecting.
 * Needs no missions, so a caller can run it alongside the Purpose read.
 */
export async function readGoalRecordFiles(goalsDir: string): Promise<GoalFileRead[]> {
  const files = await readGoalFiles(goalsDir);
  const reads = await Promise.allSettled(files.map((file) => readFile(join(goalsDir, file), "utf8")));
  return files.map((file, index) => {
    const read = reads[index];
    if (read.status === "fulfilled") return { file, content: read.value };
    return { file, error: read.reason instanceof Error ? read.reason.message : String(read.reason) };
  });
}

type GoalFrontmatterSchema = Awaited<ReturnType<typeof goalFrontmatterSchema>>;

function skipped(file: string, field: string, reason: string): GoalRecordWarning {
  return { file, field, message: `soma: skipped goal file ${file}: ${field}: ${reason}` };
}

function parseGoalFile(
  file: string,
  content: string,
  schema: GoalFrontmatterSchema,
  known: ReadonlySet<string>,
): { goal?: GoalRecord; warnings: GoalRecordWarning[] } {
  const parts = splitGoalFile(content);
  if (parts === undefined) return { warnings: [skipped(file, "frontmatter", "missing --- frontmatter block")] };

  let raw: unknown;
  try {
    raw = Bun.YAML.parse(parts.frontmatter);
  } catch (error) {
    return { warnings: [skipped(file, "frontmatter", error instanceof Error ? error.message : String(error))] };
  }

  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    // Zod reports at least one issue on failure; the first names the field.
    const [issue] = parsed.error.issues;
    return { warnings: [skipped(file, issue.path.join(".") || "frontmatter", issue.message)] };
  }

  const data = parsed.data;
  const stem = GOAL_FILE.exec(file)?.[1];
  if (data.id !== stem) return { warnings: [skipped(file, "id", `${data.id} does not match the file name`)] };

  const wording = wordingOf(parts.body);
  if (wording === "") return { warnings: [skipped(file, "wording", "the body has no first line")] };

  const warnings: GoalRecordWarning[] = [];
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

  return {
    goal: {
      id: data.id,
      status: data.status,
      supports: data.supports,
      ...(data.sensor === undefined ? {} : { sensor: data.sensor }),
      ...(data.review_by === undefined ? {} : { reviewBy: data.review_by }),
      ...(data.pursuit_window === undefined ? {} : { pursuitWindow: data.pursuit_window }),
      wording,
      body: parts.body,
    },
    warnings,
  };
}

/**
 * Validate goal files read by `readGoalRecordFiles`, in id order. `missions`
 * are the Purpose mission bullets; a `supports` code none of them starts with
 * loads but warns.
 */
export async function validateGoalRecords(reads: readonly GoalFileRead[], missions: readonly string[]): Promise<GoalRecordsLoad> {
  if (reads.length === 0) return { goals: [], warnings: [] };

  const schema = await goalFrontmatterSchema();
  const known = missionCodes(missions);
  const goals: GoalRecord[] = [];
  const warnings: GoalRecordWarning[] = [];
  for (const read of reads) {
    if ("error" in read) {
      warnings.push(skipped(read.file, "file", read.error));
      continue;
    }
    const result = parseGoalFile(read.file, read.content, schema, known);
    if (result.goal !== undefined) goals.push(result.goal);
    warnings.push(...result.warnings);
  }

  goals.sort((a, b) => goalNumber(a.id) - goalNumber(b.id));
  return { goals, warnings };
}

/** Load every `G<n>.md` under `goalsDir`: `readGoalRecordFiles` then `validateGoalRecords`. */
export async function loadGoalRecords(goalsDir: string, missions: readonly string[]): Promise<GoalRecordsLoad> {
  return validateGoalRecords(await readGoalRecordFiles(goalsDir), missions);
}

/** The `active` goals, in id order, as `G<n>: <wording> (supports M…)`. */
export function activeGoalLines(goals: readonly GoalRecord[] = []): string[] {
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
  /** Private text following the wording line. */
  body?: string;
}

function validateGoalOptions(options: AddGoalOptions): void {
  if (!options.wording.trim() || /[\r\n]/.test(options.wording)) {
    throw new Error("wording must be a non-empty single line");
  }
  if (options.supports.some((code) => !/^M\d+$/.test(code))) {
    throw new Error("supports must contain M<n> mission codes");
  }
}

/** Allocate from file names, including invalid records; never fill a gap.
 * A factory binds dependent activation ids to the exclusively allocated id.
 */
export async function addGoalRecord(goalsDir: string, input: AddGoalOptions | ((id: string) => AddGoalOptions)): Promise<string> {
  if (typeof input !== "function") validateGoalOptions(input);
  const schema = await goalFrontmatterSchema();
  for (;;) {
    const ids = (await readGoalFiles(goalsDir)).map((file) => BigInt(file.slice(1, -3)));
    const next = ids.reduce((max, id) => id > max ? id : max, 4n) + 1n;
    const id = `G${next}`;
    const options = typeof input === "function" ? input(id) : input;
    validateGoalOptions(options);
    const parsed = schema.safeParse({
      id, status: "draft", supports: options.supports,
      ...(options.sensor === undefined ? {} : { sensor: options.sensor }),
      ...(options.reviewBy === undefined ? {} : { review_by: options.reviewBy }),
    });
    if (!parsed.success) throw new Error(`Invalid goal field: ${parsed.error.issues[0].path.join(".")}`);
    await mkdir(goalsDir, { recursive: true, mode: 0o700 });
    // JSON string literals are YAML-safe, even for sensor ids with punctuation.
    const lines = [`id: ${id}`, "status: draft", `supports: ${JSON.stringify(options.supports)}`];
    if (options.sensor !== undefined) lines.push(`sensor: ${JSON.stringify(options.sensor)}`);
    if (options.reviewBy !== undefined) lines.push(`review_by: ${options.reviewBy}`);
    try {
      await writeFile(join(goalsDir, `${id}.md`), `---\n${lines.join("\n")}\n---\n${options.wording}\n${options.body ?? ""}`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      return id;
    } catch (error) {
      // Another author may have allocated the same id since our directory read.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Remove a goal record written by addGoalRecord, e.g. to roll back a partial acceptance. */
export async function removeGoalRecord(goalsDir: string, id: string): Promise<void> {
  if (!/^G\d+$/.test(id)) throw new Error("Goal id must match G<n>");
  await unlink(join(goalsDir, `${id}.md`));
}

/** The staged Reflex blueprint that activateGoalRecord installs; the one producer of its envelope. */
export function serializeStagedActivations(activations: readonly unknown[]): string {
  return stringify({ schema: ACTIVATION_SCHEMA, activations });
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
  const ids = new Set<string>();
  for (const file of files) {
    for (const id of await blueprintActivationIds(join(activationsDir, file))) ids.add(id);
  }
  return ids;
}

async function blueprintActivationIds(path: string): Promise<string[]> {
  const { z } = await import("zod");
  const schema = z.object({
    schema: z.literal(ACTIVATION_SCHEMA),
    activations: z.array(z.object({ id: z.string().min(1) })),
  });
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unparseable or unreadable Reflex blueprint: ${path}`, { cause: error });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid Reflex blueprint (expected metafactory/activation/v1 with activations[].id): ${path}`);
  return parsed.data.activations.map(({ id }) => id);
}

/** Install staged blueprints before validating the sensor; return their activation ids. */
export async function activateGoalRecord(goalsDir: string, id: string, activationsDir: string): Promise<string[]> {
  const goal = await readGoalRecord(goalsDir, id);
  if (!goal.data.sensor) throw new Error(`Goal ${id} is missing sensor: ${goal.path}`);
  if (!goal.data.review_by) throw new Error(`Goal ${id} is missing review_by: ${goal.path}`);

  const stagePath = join(goalsDir, `${id}.activations.yaml`);
  let staged: Buffer | undefined;
  try {
    staged = await readFile(stagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read staged Reflex blueprint: ${stagePath}`, { cause: error });
    }
  }

  const target = join(activationsDir, `${id.toLowerCase()}.yaml`);
  let created = false;
  try {
    if (staged !== undefined) {
      await mkdir(activationsDir, { recursive: true, mode: 0o700 });
      const file = await open(target, "wx", 0o600).catch(async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await readFile(target)).equals(staged)) {
          throw new Error(`Reflex blueprint already exists with different content: ${target}`);
        }
        return undefined;
      });
      if (file !== undefined) {
        created = true;
        try {
          await file.writeFile(staged);
        } finally {
          await file.close();
        }
      }
    }
    if (!(await blueprintSensorIds(activationsDir)).has(goal.data.sensor)) {
      throw new Error(`Goal ${id} sensor is absent from Reflex blueprints: ${activationsDir}`);
    }
    const activationIds = staged === undefined ? [] : await blueprintActivationIds(target);
    await writeGoalStatus(goal, "active");
    return activationIds;
  } catch (error) {
    // An identical pre-existing blueprint belongs to its earlier install.
    if (created) await unlink(target);
    throw error;
  }
}
