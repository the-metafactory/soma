function dateFormatter(timeZone: string, withTime = false): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, calendar: "iso8601", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(withTime ? { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" } as const : {}),
  });
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((item) => item.type === type)?.value;
  if (value === undefined) throw new RangeError(`Local date is missing ${type}`);
  return value;
}

function dateText(parts: Intl.DateTimeFormatPart[]): string {
  return `${part(parts, "year").padStart(4, "0")}-${part(parts, "month")}-${part(parts, "day")}`;
}

/** The instant's calendar date (YYYY-MM-DD) in an Intl-supported IANA timezone. */
export function localDate(timeZone: string, instant: Date): string {
  return dateText(dateFormatter(timeZone).formatToParts(instant));
}

function localMidnight(date: string, timeZone: string): Date {
  const formatter = dateFormatter(timeZone, true);
  const wall = Date.parse(`${date}T00:00:00Z`);
  let candidate = wall;
  // Re-evaluate the offset at the candidate, since UTC midnight can have a
  // different offset from local midnight on a transition date.
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(candidate));
    const represented = Date.parse(`${dateText(parts)}T${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}Z`);
    if (represented === wall) return new Date(candidate);
    candidate += wall - represented;
  }
  // Some IANA transitions skip midnight entirely. Do not invent a 00:00.
  throw new RangeError(`Local midnight does not exist on ${date} in ${timeZone}`);
}

/**
 * Midnight on the Nth most recent Monday-Friday date, including the instant's
 * own date when it is a weekday. Holidays are ordinary weekdays. Throws for an
 * invalid count/timezone/instant, or if the target local midnight was skipped.
 */
export function workdayWindowStart(workdays: number, timeZone: string, instant: Date): Date {
  if (!Number.isSafeInteger(workdays) || workdays < 1) {
    throw new RangeError("Workdays must be a positive safe integer");
  }
  // This UTC Date represents a calendar date, not an instant in the timezone.
  const day = new Date(`${localDate(timeZone, instant)}T00:00:00Z`);
  const weekday = day.getUTCDay();
  if (weekday === 0) day.setUTCDate(day.getUTCDate() - 2);
  else if (weekday === 6) day.setUTCDate(day.getUTCDate() - 1);

  const remaining = workdays - 1;
  const weekdays = remaining % 5;
  const daysBack = Math.floor(remaining / 5) * 7 + weekdays + (weekdays >= day.getUTCDay() ? 2 : 0);
  day.setUTCDate(day.getUTCDate() - daysBack);
  return localMidnight(day.toISOString().slice(0, 10), timeZone);
}
