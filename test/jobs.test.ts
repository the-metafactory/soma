import { describe, expect, test } from "bun:test";
import { classifyJobs, jobPeriodMinutes, jobPlistSchema, parseLaunchctlRows, type JobPlist, type JobRecord } from "../src/jobs/index";

const NOW = new Date("2026-10-28T12:00:00Z");

function record(plist: Partial<JobPlist> = {}, ageMinutes: number | null = 10): JobRecord {
  return {
    kind: "parsed", source: "launchd", label: "ch.example.job", path: "/jobs/ch.example.job.plist",
    plist: jobPlistSchema.parse({ Label: "ch.example.job", StartInterval: 600, ...plist }),
    activity: ageMinutes === null ? null : { at: new Date(NOW.getTime() - ageMinutes * 60_000).toISOString(), evidence: "output log mtime: /logs/job.log" },
    diagnostic: null,
  };
}

function row(job = record(), lastExit: number | null = 0) {
  return classifyJobs({ records: [job], launchctl: lastExit === null ? [] : [{ label: job.label, pid: null, lastExit }], now: NOW })[0];
}

describe("scheduled job classification", () => {
  test.each([1, 78, -9])("nonzero last exit %s takes precedence over timing", (exit) => {
    expect(row(record({ StartInterval: undefined }, null), exit)).toMatchObject({ status: "failing", lastExit: exit });
    expect(row(record({}, 100), exit).status).toBe("failing");
  });

  test("interval lateness is strictly greater than two periods plus fifteen minutes", () => {
    expect(row(record({}, 35)).status).toBe("ok");
    expect(row(record({}, 35.001)).status).toBe("late");
    expect(row(record({ StartInterval: 30 }, 16)).status).toBe("ok");
    expect(row(record({ StartInterval: 30 }, 16.001)).status).toBe("late");
  });

  test("daily calendar jobs use the same threshold", () => {
    const calendar = { StartInterval: undefined, StartCalendarInterval: { Hour: 7, Minute: 0 } };
    expect(row(record(calendar, 2895)).status).toBe("ok");
    expect(row(record(calendar, 2896))).toMatchObject({ status: "late", periodMinutes: 1440 });
  });

  test("periods are derived from calendar wildcards, Sunday aliases and regular arrays", () => {
    const period = (StartCalendarInterval: NonNullable<JobPlist["StartCalendarInterval"]>) => jobPeriodMinutes({ Label: "ch.example", StartCalendarInterval });
    expect(period({})).toBe(1);
    expect(period({ Minute: 5 })).toBe(60);
    expect(period({ Weekday: 7, Hour: 8, Minute: 0 })).toBe(10080);
    expect(period([{ Hour: 6, Minute: 0 }, { Hour: 18, Minute: 0 }])).toBe(720);
    expect(period([{ Hour: 6, Minute: 0 }, { Hour: 17, Minute: 0 }])).toBeNull();
    expect(period({ Day: 1, Hour: 0, Minute: 0 })).toBeNull();
    expect(period({ Month: 2, Day: 29 })).toBeNull();
  });

  test("missing or ambiguous schedules, missing runs, missing exits and future activity never become ok", () => {
    expect(row(record({ StartInterval: undefined })).status).toBe("unknown");
    expect(row(record({ StartCalendarInterval: { Hour: 7 } })).status).toBe("unknown");
    expect(row(record({}, null)).status).toBe("unknown");
    expect(row(record(), null).status).toBe("unknown");
    expect(row(record({}, -1)).status).toBe("unknown");
    expect(row({ ...record(), kind: "error", error: "bad XML" })).toMatchObject({ status: "unknown", reason: "bad XML" });
  });

  test("invalid schedule values are rejected at the boundary", () => {
    for (const value of [{ StartInterval: 0 }, { StartInterval: -1 }, { StartCalendarInterval: { Hour: 24 } }, { StartCalendarInterval: [] }]) {
      expect(jobPlistSchema.safeParse({ Label: "ch.example", ...value }).success).toBe(false);
    }
  });

  test("launchctl list parsing preserves negative exits and running PIDs", () => {
    expect(parseLaunchctlRows(" PID\tStatus\tLabel \n-\t1\tcom.kai.daily-briefing\n 123\t-9\tch.example.job\n")).toEqual([
      { label: "com.kai.daily-briefing", pid: null, lastExit: 1 },
      { label: "ch.example.job", pid: 123, lastExit: -9 },
    ]);
    expect(() => parseLaunchctlRows("not a launchctl row")).toThrow("Unrecognized");
  });
});
