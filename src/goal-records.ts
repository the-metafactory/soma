import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GoalRecord } from "./types";

/**
 * Goal records (soma#784 D2–D5, D7–D9): one file per goal at
 * `<soma-home>/profile/goals/G<n>.md`. The frontmatter is typed and checked
 * with Zod; the body is private, and its first line is the goal's wording.
 *
 * Loading never fails the home: a file whose frontmatter does not parse is
 * skipped with one warning, and the rest still load. `sweep.yaml` and any file
 * not named `G<n>.md` are ignored here.
 */

export const GOAL_STATUSES = ["draft", "active", "paused", "achieved", "dropped"] as const;

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
