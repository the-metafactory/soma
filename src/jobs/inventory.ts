import { z } from "zod";

export const JOB_LABEL_PREFIXES = ["ch.", "ai.meta-factory.", "com.kai.", "com.pai."] as const;
export const JOB_STATUSES = ["ok", "failing", "late", "unknown"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobSource = "launchd" | "reflex" | "ranger";

const calendarSchema = z.object({
  Minute: z.number().int().min(0).max(59).optional(),
  Hour: z.number().int().min(0).max(23).optional(),
  Day: z.number().int().min(1).max(31).optional(),
  Month: z.number().int().min(1).max(12).optional(),
  Weekday: z.number().int().min(0).max(7).optional(),
}).strict();

export const jobPlistSchema = z.object({
  Label: z.string().min(1),
  StartInterval: z.number().int().positive().optional(),
  StartCalendarInterval: z.union([calendarSchema, z.array(calendarSchema).nonempty()]).optional(),
  StandardOutPath: z.string().optional(),
  StandardErrorPath: z.string().optional(),
});
export type JobPlist = z.infer<typeof jobPlistSchema>;

export interface JobActivity {
  at: string;
  evidence: string;
}

interface JobIdentity {
  source: JobSource;
  label: string;
  path: string;
}

export type JobRecord = JobIdentity & (
  | { kind: "parsed"; plist: JobPlist; activity: JobActivity | null; diagnostic: string | null }
  | { kind: "declaration"; schedule: string | null; diagnostic: string }
  | { kind: "error"; error: string }
);

export interface LaunchctlRow {
  label: string;
  pid: number | null;
  lastExit: number;
}

export interface JobRow extends JobIdentity {
  status: JobStatus;
  lastExit: number | null;
  lastRun: string | null;
  lastRunEvidence: string | null;
  periodMinutes: number | null;
  schedule: string | null;
  reason: string;
}

export function isInventoryLabel(label: string): boolean {
  return JOB_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix));
}

export function parseLaunchctlRows(text: string): LaunchctlRow[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !/^PID\s+Status\s+Label$/.test(line)).map((line) => {
    const match = /^(\d+|-)\s+(-?\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) throw new Error(`Unrecognized launchctl list row: ${line}`);
    return { label: match[3], pid: match[1] === "-" ? null : Number(match[1]), lastExit: Number(match[2]) };
  });
}

function calendarPeriod(value: NonNullable<JobPlist["StartCalendarInterval"]>): number | null {
  const calendars = Array.isArray(value) ? value : [value];
  if (calendars.some((entry) => entry.Day !== undefined || entry.Month !== undefined)) return null;
  const weekMinutes = 7 * 24 * 60;
  const ticks: number[] = [];
  for (let minute = 0; minute < weekMinutes; minute++) {
    const weekday = Math.floor(minute / 1440);
    const hour = Math.floor(minute / 60) % 24;
    if (calendars.some((entry) =>
      (entry.Weekday === undefined || entry.Weekday % 7 === weekday)
      && (entry.Hour === undefined || entry.Hour === hour)
      && (entry.Minute === undefined || entry.Minute === minute % 60))) ticks.push(minute);
  }
  if (ticks.length === 0) return null;
  const gaps = ticks.map((tick, index) => (ticks[index + 1] ?? ticks[0] + weekMinutes) - tick);
  return gaps.every((gap) => gap === gaps[0]) ? gaps[0] : null;
}

export function jobPeriodMinutes(plist: JobPlist): number | null {
  if (plist.StartInterval !== undefined && plist.StartCalendarInterval !== undefined) return null;
  if (plist.StartInterval !== undefined) return plist.StartInterval / 60;
  return plist.StartCalendarInterval === undefined ? null : calendarPeriod(plist.StartCalendarInterval);
}

export function classifyJobs(input: { records: readonly JobRecord[]; launchctl: readonly LaunchctlRow[]; now: Date }): JobRow[] {
  const exits = new Map(input.launchctl.map((row) => [row.label, row.lastExit]));
  return input.records.map((record): JobRow => {
    const base: JobRow = {
      source: record.source, label: record.label, path: record.path,
      status: "unknown", lastExit: record.source === "launchd" ? exits.get(record.label) ?? null : null,
      lastRun: null, lastRunEvidence: null, periodMinutes: null, schedule: null, reason: "",
    };
    if (record.kind === "error") return { ...base, reason: record.error };
    if (record.kind === "declaration") return { ...base, schedule: record.schedule, reason: record.diagnostic };
    const periodMinutes = jobPeriodMinutes(record.plist);
    const row = {
      ...base, periodMinutes, lastRun: record.activity?.at ?? null, lastRunEvidence: record.activity?.evidence ?? null,
      schedule: record.plist.StartInterval !== undefined ? `every ${record.plist.StartInterval}s`
        : record.plist.StartCalendarInterval !== undefined ? JSON.stringify(record.plist.StartCalendarInterval) : null,
    };
    if (row.lastExit !== null && row.lastExit !== 0) return { ...row, status: "failing", reason: `last exit ${row.lastExit}` };
    if (periodMinutes === null) return { ...row, reason: "period cannot be derived (absent, combined or irregular schedule)" };
    if (record.activity === null) return { ...row, reason: record.diagnostic ?? "last run cannot be derived: no nonempty output log" };
    const elapsedMinutes = (input.now.getTime() - Date.parse(record.activity.at)) / 60_000;
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < 0) return { ...row, reason: "last-run timestamp is invalid or in the future" };
    if (elapsedMinutes > 2 * periodMinutes + 15) return { ...row, status: "late", reason: `last activity exceeds ${2 * periodMinutes + 15} minutes (2 periods + 15 minutes)` };
    if (row.lastExit === null) return { ...row, reason: "launchctl last exit unavailable" };
    if (record.diagnostic !== null) return { ...row, reason: record.diagnostic };
    return { ...row, status: "ok", reason: "last exit 0; output activity within 2 periods + 15 minutes" };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
}
