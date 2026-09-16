/**
 * Business-hours arithmetic. Pure and I/O-free on purpose: this is the hardest
 * correctness problem in the release and it must be cheap to test exhaustively.
 *
 * Everything here works in **wall-clock local time** in the workspace timezone and
 * converts to UTC only at the boundary. Adding milliseconds to a UTC timestamp instead
 * produces due dates an hour wrong twice a year, and the bug stays invisible for months.
 */

export interface BusinessDay {
  /** 0–6, Sunday-first, matching Date.prototype.getDay(). An absent day is non-working. */
  day: number;
  /** "HH:MM" local wall-clock. */
  start: string;
  end: string;
}

export interface BusinessHours {
  timezone: string;
  days: BusinessDay[];
  /** YYYY-MM-DD in the workspace timezone. */
  holidays: string[];
}

export const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
/** A configuration where no day is ever workable must terminate rather than hang the Worker. */
const MAX_DAYS_SCANNED = 365;

interface LocalMoment {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string) {
  let cached = partsCache.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hour12: false,
    });
    partsCache.set(timezone, cached);
  }
  return cached;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Reads an instant as wall-clock local time in `timezone`. */
function toLocal(ms: number, timezone: string): LocalMoment {
  const parts = formatter(timezone).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  // Intl renders midnight as "24" in some ICU versions; normalise it.
  const hour = Number(get("hour")) % 24;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** The zone's offset from UTC, in ms, at a given instant. */
function offsetAt(ms: number, timezone: string) {
  const local = toLocal(ms, timezone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  // Seconds are dropped by design: every boundary this module produces is minute-aligned.
  return asUtc - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * Converts wall-clock local time back to an instant.
 *
 * Two passes, because the offset used to make the first guess may itself be the wrong
 * side of a DST boundary. A wall-clock time that does not exist (the skipped hour in
 * spring) resolves forward, which is the behaviour a due date wants.
 */
function fromLocal(local: { year: number; month: number; day: number; hour: number; minute: number }, timezone: string) {
  const target = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  let ms = target;
  for (let pass = 0; pass < 2; pass += 1) ms = target - offsetAt(ms, timezone);
  return ms;
}

function minutesOf(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function dateKey(local: LocalMoment) {
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}

/**
 * The working window for one local date, as minutes past local midnight, or null when
 * the day is non-working. A day whose end is not after its start is a misconfiguration
 * and is treated as non-working rather than looping forever.
 */
function windowFor(local: LocalMoment, hours: BusinessHours): { start: number; end: number } | null {
  if (hours.holidays.includes(dateKey(local))) return null;
  const configured = hours.days.find((entry) => entry.day === local.weekday);
  if (!configured) return null;
  const start = minutesOf(configured.start);
  const end = minutesOf(configured.end);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

/** Local midnight of the day after `local`, as an instant. */
function nextLocalMidnight(local: LocalMoment, timezone: string) {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day) + 24 * 60 * MINUTE_MS;
  const next = new Date(asUtc);
  return fromLocal(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    timezone,
  );
}

function usable(hours: BusinessHours | null): hours is BusinessHours {
  return Boolean(hours && hours.timezone && hours.days.length);
}

/**
 * Adds `minutes` of business time to `from`, returning epoch ms.
 *
 * With no business hours configured this is plain wall-clock addition — a sane default
 * for a team that has configured nothing, and what 24/7 support actually means.
 */
export function addBusinessMinutes(from: number, minutes: number, hours: BusinessHours | null): number {
  if (!usable(hours)) return from + minutes * MINUTE_MS;
  if (minutes <= 0) return from;

  let cursor = from;
  let remaining = minutes;
  for (let scanned = 0; scanned < MAX_DAYS_SCANNED; scanned += 1) {
    const local = toLocal(cursor, hours.timezone);
    const window = windowFor(local, hours);
    if (!window) {
      cursor = nextLocalMidnight(local, hours.timezone);
      continue;
    }
    const position = local.hour * 60 + local.minute;
    if (position >= window.end) {
      cursor = nextLocalMidnight(local, hours.timezone);
      continue;
    }
    const startMinute = Math.max(position, window.start);
    const available = window.end - startMinute;
    if (available >= remaining) {
      const target = startMinute + remaining;
      return fromLocal(
        {
          year: local.year,
          month: local.month,
          day: local.day,
          hour: Math.floor(target / 60),
          minute: target % 60,
        },
        hours.timezone,
      );
    }
    remaining -= available;
    cursor = nextLocalMidnight(local, hours.timezone);
  }
  // Every day within a year was non-working. Fall back to wall-clock rather than hang;
  // the Settings UI surfaces the misconfiguration separately.
  return from + minutes * MINUTE_MS;
}

/**
 * Business minutes elapsed between two instants. Returns 0 when the range is inverted,
 * so callers never have to guard the order themselves.
 */
export function businessMinutesBetween(from: number, to: number, hours: BusinessHours | null): number {
  if (to <= from) return 0;
  if (!usable(hours)) return Math.floor((to - from) / MINUTE_MS);

  let cursor = from;
  let total = 0;
  for (let scanned = 0; scanned < MAX_DAYS_SCANNED && cursor < to; scanned += 1) {
    const local = toLocal(cursor, hours.timezone);
    const window = windowFor(local, hours);
    const midnight = nextLocalMidnight(local, hours.timezone);
    if (!window) {
      cursor = midnight;
      continue;
    }
    const position = local.hour * 60 + local.minute;
    const startMinute = Math.max(position, window.start);
    if (startMinute < window.end) {
      const windowStart = fromLocal(
        {
          year: local.year,
          month: local.month,
          day: local.day,
          hour: Math.floor(startMinute / 60),
          minute: startMinute % 60,
        },
        hours.timezone,
      );
      const windowEnd = fromLocal(
        {
          year: local.year,
          month: local.month,
          day: local.day,
          hour: Math.floor(window.end / 60),
          minute: window.end % 60,
        },
        hours.timezone,
      );
      const until = Math.min(windowEnd, to);
      if (until > windowStart) total += Math.round((until - windowStart) / MINUTE_MS);
    }
    cursor = midnight;
  }
  return Math.min(total, DAY_MINUTES * MAX_DAYS_SCANNED);
}
