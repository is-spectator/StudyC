import { AuthApiError, type RequestOptions } from "../../auth/api.ts";
export type Settings = { timeZone: string; version: number; enabled: boolean };
export type SourceTask = { studySetId: string; planId: string; taskId: string };
export type Time =
  | { kind: "all_day"; date: string }
  | {
      kind: "timed";
      start: string;
      end: string;
      timeZone: string;
      startsAt: string;
      endsAt: string;
      startLocal: string;
      endLocal: string;
    };
export type Event = {
  id: string;
  title: string;
  description: string;
  kind: "study" | "exam" | "personal";
  time: Time;
  sourceTask: SourceTask | null;
  cancelledAt: string | null;
  taskCancelledAt: string | null;
  version: number;
};
export type DayRange = { date: string; startsAt: string; endsAt: string };
export function eventInDay(event: Event, day: DayRange) {
  return event.time.kind === "all_day"
    ? event.time.date === day.date
    : Date.parse(day.startsAt) < Date.parse(day.endsAt) &&
        Date.parse(event.time.startsAt) < Date.parse(day.endsAt) &&
        Date.parse(event.time.endsAt) > Date.parse(day.startsAt);
}
export type Option = { value: string; instant: string; offset: string };
export type Conflict = { id: string; title: string; version: number };
export type Candidate = {
  title: string;
  description: string;
  kind: string;
  time:
    | { kind: "all_day"; date: string }
    | { kind: "timed"; start: string; end: string; timeZone: string };
};
const id = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const instant = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const validZone = (v: unknown) => {
  try {
    return (
      typeof v === "string" &&
      !!new Intl.DateTimeFormat("en", { timeZone: v }).resolvedOptions()
        .timeZone
    );
  } catch {
    return false;
  }
};
const fail = (): never => {
  throw new AuthApiError("invalid_response", "日历数据暂时无法读取，请重试。");
};
export function parseEvent(v: any): Event {
  if (
    !v ||
    !id(v.id) ||
    typeof v.title !== "string" ||
    typeof v.description !== "string" ||
    !["study", "exam", "personal"].includes(v.kind) ||
    !Number.isInteger(v.version) ||
    v.version < 1 ||
    ![v.cancelledAt, v.taskCancelledAt].every((x) => x === null || instant(x))
  )
    fail();
  if (
    !(
      v.sourceTask === null ||
      (v.sourceTask &&
        id(v.sourceTask.studySetId) &&
        id(v.sourceTask.planId) &&
        id(v.sourceTask.taskId))
    )
  )
    fail();
  const t = v.time;
  if (
    !t ||
    !(
      (t.kind === "all_day" &&
        typeof t.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(t.date)) ||
      (t.kind === "timed" &&
        validZone(t.timeZone) &&
        typeof t.start === "string" &&
        typeof t.end === "string" &&
        typeof t.startLocal === "string" &&
        typeof t.endLocal === "string" &&
        instant(t.startsAt) &&
        instant(t.endsAt) &&
        Date.parse(t.endsAt) > Date.parse(t.startsAt) &&
        Date.parse(t.start) === Date.parse(t.startsAt) &&
        Date.parse(t.end) === Date.parse(t.endsAt))
    )
  )
    fail();
  return v;
}
export function createCalendarApi(
  request: <T>(path: string, options?: RequestOptions) => Promise<T>,
) {
  const root = "/v1/study/calendar";
  const settings = (v: any): Settings => {
    if (
      !v ||
      !validZone(v.timeZone) ||
      !Number.isInteger(v.version) ||
      v.version < 0 ||
      typeof v.enabled !== "boolean"
    )
      fail();
    return v;
  };
  return {
    settings: async () => settings(await request(root + "/settings")),
    setZone: async (body: unknown) =>
      settings(await request(root + "/settings", { method: "PATCH", body })),
    list: async (from: string, to: string, cursor?: string) => {
      const v = await request<any>(
        root +
          `/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      if (
        !v ||
        typeof v.timeZone !== "string" ||
        !Array.isArray(v.items) ||
        (v.nextCursor !== null && !id(v.nextCursor))
      )
        fail();
      if (
        !Array.isArray(v.days) ||
        !Number.isInteger(v.settingsVersion) ||
        v.settingsVersion < 0
      )
        fail();
      const count = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
      if (v.days.length !== count) fail();
      for (const [i, d] of v.days.entries())
        if (
          !d ||
          d.date !== addDays(from, i) ||
          !instant(d.startsAt) ||
          !instant(d.endsAt) ||
          Date.parse(d.endsAt) < Date.parse(d.startsAt) ||
          (i > 0 && v.days[i - 1].endsAt !== d.startsAt)
        )
          fail();
      return {
        days: v.days as DayRange[],
        settingsVersion: v.settingsVersion as number,
        items: v.items.map(parseEvent) as Event[],
        nextCursor: v.nextCursor as string | null,
        timeZone: v.timeZone as string,
      };
    },
    get: async (eventId: string) => {
      const v = await request<{ event: Event }>(root + "/events/" + eventId);
      if (v.event?.id !== eventId) fail();
      return parseEvent(v.event);
    },
    save: async (eventId: string | undefined, body: unknown) => {
      const v = await request<{ event: Event }>(
        root + "/events" + (eventId ? "/" + eventId : ""),
        { method: eventId ? "PATCH" : "POST", body },
      );
      if (eventId && v.event?.id !== eventId) fail();
      return parseEvent(v.event);
    },
    options: async (local: string, timeZone: string) => {
      const v = await request<{ items: Option[] }>(
        root +
          `/time-options?local=${encodeURIComponent(local)}&timeZone=${encodeURIComponent(timeZone)}`,
      );
      if (!Array.isArray(v.items)) fail();
      for (const o of v.items)
        if (
          typeof o.value !== "string" ||
          !instant(o.instant) ||
          typeof o.offset !== "string"
        )
          fail();
      return v.items;
    },
    preview: async (body: unknown) => {
      const v = await request<{
        conflicts: Conflict[];
        conflictToken: string | null;
      }>(root + "/conflicts", { method: "POST", body });
      if (
        !Array.isArray(v.conflicts) ||
        !(
          v.conflictToken === null ||
          (typeof v.conflictToken === "string" &&
            /^[a-f0-9]{64}$/.test(v.conflictToken))
        )
      )
        fail();
      for (const c of v.conflicts)
        if (
          !id(c.id) ||
          typeof c.title !== "string" ||
          !Number.isInteger(c.version)
        )
          fail();
      return v;
    },
    task: async (source: SourceTask) => {
      const q = new URLSearchParams(source);
      const v = await request<{
        task: SourceTask & {
          title: string;
          dueDate: string | null;
          cancelledAt: string | null;
        };
        event: Event | null;
      }>(root + "/task-event?" + q);
      if (
        !v?.task ||
        v.task.taskId !== source.taskId ||
        v.task.planId !== source.planId ||
        v.task.studySetId !== source.studySetId ||
        typeof v.task.title !== "string"
      )
        fail();
      if (v.event) parseEvent(v.event);
      return v;
    },
  };
}
export function dateInZone(at: Date | string, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year?.padStart(4, "0")}-${parts.month}-${parts.day}`;
}
export function addDays(date: string, days: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function viewRange(anchor: string, view: "day" | "week") {
  if (view === "day") return { from: anchor, to: anchor };
  const weekday = new Date(anchor + "T00:00:00Z").getUTCDay(),
    from = addDays(anchor, -((weekday + 6) % 7));
  return { from, to: addDays(from, 6) };
}

/** Display interval dates and offset changes so cross-day events and repeated hours are unambiguous. */
export function formatCalendarTime(event: Event, zone: string) {
  if (event.time.kind === "all_day") return "全天";
  const t = event.time,
    first = new Date(t.startsAt),
    last = new Date(t.endsAt),
    offset = new Intl.DateTimeFormat("en", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }),
    name = (d: Date) =>
      offset.formatToParts(d).find((p) => p.type === "timeZoneName")?.value;
  const cross =
      dateInZone(first, zone) !==
      dateInZone(new Date(last.getTime() - 1), zone),
    shift = name(first) !== name(last);
  const f = new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    ...(cross ? { month: "2-digit", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(shift ? { timeZoneName: "shortOffset" } : {}),
  });
  return f.format(first) + "–" + f.format(last);
}
