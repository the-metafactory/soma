import { describe, expect, test } from "bun:test";
import { localDate, workdayWindowStart } from "../src/workdays";

const ZURICH = "Europe/Zurich";

describe("localDate", () => {
  test.each([
    [ZURICH, "2026-01-01T23:30:00Z", "2026-01-02"],
    [ZURICH, "2026-07-01T22:30:00Z", "2026-07-02"],
    [ZURICH, "2026-03-29T00:30:00Z", "2026-03-29"],
    [ZURICH, "2026-03-29T01:30:00Z", "2026-03-29"],
    [ZURICH, "2026-10-25T00:30:00Z", "2026-10-25"],
    [ZURICH, "2026-10-25T01:30:00Z", "2026-10-25"],
    ["America/Los_Angeles", "2026-01-01T01:00:00Z", "2025-12-31"],
    ["Pacific/Kiritimati", "2026-12-31T12:00:00Z", "2027-01-01"],
    ["Asia/Kathmandu", "2026-01-01T18:30:00Z", "2026-01-02"],
    ["UTC", "2026-02-28T23:59:59.999Z", "2026-02-28"],
  ])("%s at %s gives %s", (zone, iso, expected) => {
    expect(localDate(zone, new Date(iso))).toBe(expected);
  });

  test("rejects unknown timezones and invalid instants", () => {
    expect(() => localDate("Unknown/Timezone", new Date("2026-10-14T12:00:00Z"))).toThrow(RangeError);
    expect(() => localDate(ZURICH, new Date(NaN))).toThrow(RangeError);
  });
});

describe("workdayWindowStart", () => {
  test.each([
    [3, "2026-10-14T12:00:00Z", "2026-10-11T22:00:00.000Z"], // Wednesday -> Monday
    [1, "2026-10-17T12:00:00Z", "2026-10-15T22:00:00.000Z"], // Saturday -> Friday
    [2, "2026-10-12T12:00:00Z", "2026-10-08T22:00:00.000Z"], // Monday -> Friday
    [1, "2026-10-18T12:00:00Z", "2026-10-15T22:00:00.000Z"], // Sunday -> Friday
    [1, "2026-10-12T22:30:00Z", "2026-10-12T22:00:00.000Z"], // local Tuesday
    [5, "2026-10-16T12:00:00Z", "2026-10-11T22:00:00.000Z"],
    [6, "2026-10-16T12:00:00Z", "2026-10-08T22:00:00.000Z"],
    [10, "2026-10-16T12:00:00Z", "2026-10-04T22:00:00.000Z"],
    [2, "2026-01-01T12:00:00Z", "2025-12-30T23:00:00.000Z"], // holidays still count
    [2, "2024-03-01T12:00:00Z", "2024-02-28T23:00:00.000Z"], // leap day
  ])("%s workdays from %s starts %s", (count, iso, expected) => {
    const instant = new Date(iso);
    expect(workdayWindowStart(count, ZURICH, instant).toISOString()).toBe(expected);
    expect(instant.toISOString()).toBe(new Date(iso).toISOString());
  });

  test.each([
    [1, "2026-03-29T00:30:00Z", "2026-03-26T23:00:00.000Z"],
    [1, "2026-03-29T01:30:00Z", "2026-03-26T23:00:00.000Z"],
    [1, "2026-03-30T12:00:00Z", "2026-03-29T22:00:00.000Z"],
    [2, "2026-03-30T12:00:00Z", "2026-03-26T23:00:00.000Z"],
    [1, "2026-10-25T00:30:00Z", "2026-10-22T22:00:00.000Z"],
    [1, "2026-10-25T01:30:00Z", "2026-10-22T22:00:00.000Z"],
    [1, "2026-10-26T12:00:00Z", "2026-10-25T23:00:00.000Z"],
    [2, "2026-10-26T12:00:00Z", "2026-10-22T22:00:00.000Z"],
  ])("Zurich DST: %s workdays from %s starts %s", (count, iso, expected) => {
    expect(workdayWindowStart(count, ZURICH, new Date(iso)).toISOString()).toBe(expected);
  });

  test.each([
    ["UTC", "2026-10-14T12:00:00Z", "2026-10-14T00:00:00.000Z"],
    ["America/Los_Angeles", "2026-10-12T02:00:00Z", "2026-10-09T07:00:00.000Z"],
    ["Asia/Kathmandu", "2026-10-14T12:00:00Z", "2026-10-13T18:15:00.000Z"],
    ["Pacific/Kiritimati", "2026-10-14T12:00:00Z", "2026-10-14T10:00:00.000Z"],
    ["Asia/Jerusalem", "2026-03-27T12:00:00Z", "2026-03-26T22:00:00.000Z"],
  ])("timezone %s uses its local weekday and midnight", (zone, iso, expected) => {
    expect(workdayWindowStart(1, zone, new Date(iso)).toISOString()).toBe(expected);
  });

  test.each([0, -1, 0.5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid workday count %s", (count) => {
      expect(() => workdayWindowStart(count, ZURICH, new Date("2026-10-14T12:00:00Z"))).toThrow(RangeError);
    },
  );

  test("rejects unknown timezones and invalid instants", () => {
    expect(() => workdayWindowStart(1, "Unknown/Timezone", new Date("2026-10-14T12:00:00Z"))).toThrow(RangeError);
    expect(() => workdayWindowStart(1, ZURICH, new Date(NaN))).toThrow(RangeError);
  });

  test("rejects a target date skipped by a timezone transition", () => {
    // The preceding Friday, 2011-12-30, did not exist in Pacific/Apia.
    expect(() => workdayWindowStart(2, "Pacific/Apia", new Date("2012-01-02T00:00:00Z")))
      .toThrow("Local midnight does not exist");
  });
});
