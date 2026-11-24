import { GenerationError } from "../generation/types.js";
import { dateOnly } from "./organization-common.js";
const invalid = () =>
  new GenerationError("invalid_input", "日期、时区或本地时间无效。");
export function timeZone(value: string) {
  try {
    if (typeof value !== "string" || value.length > 80) throw invalid();
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    throw invalid();
  }
}
export function dayAdd(day: string, delta: number) {
  dateOnly.parse(day);
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function formatter(zone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
function parts(at: number, f: Intl.DateTimeFormat) {
  const p = Object.fromEntries(
    f.formatToParts(new Date(at)).map((p) => [p.type, p.value]),
  );
  return {
    local: `${p.year?.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}`,
    second: p.second,
  };
}
export function localAt(at: string | number, zone: string) {
  return parts(
    typeof at === "number" ? at : Date.parse(at),
    formatter(timeZone(zone)),
  ).local;
}
function localMillis(local: string) {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(local))
    throw invalid();
  dateOnly.parse(local.slice(0, 10));
  const at = Date.parse(local + ":00Z");
  if (!Number.isFinite(at)) throw invalid();
  return at;
}
function offsets(at: number, f: Intl.DateTimeFormat) {
  const out = new Set<number>();
  for (let h = -36; h <= 36; h += 3) {
    const t = at + h * 3600000,
      p = parts(t, f);
    out.add(
      (Date.parse(p.local + ":" + p.second + "Z") -
        Math.floor(t / 1000) * 1000) /
        60000,
    );
  }
  return [...out].filter((v) => Number.isInteger(v) && Math.abs(v) <= 1440);
}
function offsetLabel(value: number) {
  const sign = value < 0 ? "-" : "+";
  value = Math.abs(value);
  return `${sign}${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
function candidates(
  local: string,
  at: number,
  f: Intl.DateTimeFormat,
  possible: number[],
) {
  return possible
    .map((offset) => ({ at: at - offset * 60000, offset }))
    .filter((v) => parts(v.at, f).local === local)
    .sort((a, b) => a.at - b.at)
    .map((v) => ({
      value: local + offsetLabel(v.offset),
      instant: new Date(v.at).toISOString(),
      offset: offsetLabel(v.offset),
    }));
}
export function timeOptions(local: string, zone: string) {
  const canonical = timeZone(zone),
    at = localMillis(local),
    f = formatter(canonical);
  return {
    timeZone: canonical,
    local,
    items: candidates(local, at, f, offsets(at, f)),
  };
}
export function absoluteInput(input: string, zone: string) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::00)?(Z|[+-]\d{2}:\d{2})$/.exec(
    input,
  );
  if (!m) throw invalid();
  const options = timeOptions(m[1]!, zone),
    offset = m[2] === "Z" ? "+00:00" : m[2];
  const chosen = options.items.find((o) => o.offset === offset);
  if (!chosen)
    throw new GenerationError(
      "invalid_input",
      "这个本地时刻与时区偏移不匹配，或处于夏令时跳过区间。请重新检查时间。",
    );
  return chosen;
}
/** First real instant of a floating calendar date. Missing midnight advances within that date; a skipped date has zero duration. */
export function dayBoundary(day: string, zone: string): string {
  const canonical = timeZone(zone),
    f = formatter(canonical);
  for (let next = 0; next < 3; next++) {
    const date = dayAdd(day, next),
      base = localMillis(date + "T00:00"),
      possible = offsets(base, f);
    for (let minute = 0; minute < 1440; minute++) {
      const local =
          date +
          `T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
        found = candidates(local, base + minute * 60000, f, possible);
      if (found.length) return found[0]!.instant;
    }
  }
  throw invalid();
}
