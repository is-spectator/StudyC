import test from "node:test";
import assert from "node:assert/strict";
import { createCalendarApi, parseEvent, dateInZone, viewRange } from "./api.ts";
const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const event = {
  id,
  title: "学习",
  description: "复习",
  kind: "study",
  time: { kind: "all_day", date: "2026-12-01" },
  sourceTask: null,
  version: 1,
  cancelledAt: null,
  taskCancelledAt: null,
};
test("calendar responses reject malformed identities, intervals and source references", () => {
  assert.equal(parseEvent(event).id, id);
  for (const v of [
    { ...event, id: "bad" },
    { ...event, version: 0 },
    { ...event, sourceTask: { taskId: id } },
    { ...event, time: { kind: "timed", startsAt: "bad", endsAt: "bad" } },
  ])
    assert.throws(
      () => parseEvent(v),
      (e) => e.code === "invalid_response",
    );
});
test("calendar dates stay floating while timed instants use the selected timezone", () => {
  assert.equal(
    dateInZone("2026-12-01T01:00:00Z", "America/Los_Angeles"),
    "2026-11-30",
  );
  assert.equal(parseEvent(event).time.date, "2026-12-01");
  assert.deepEqual(viewRange("2026-12-01", "week"), {
    from: "2026-11-30",
    to: "2026-12-06",
  });
  assert.deepEqual(viewRange("2026-12-01", "day"), {
    from: "2026-12-01",
    to: "2026-12-01",
  });
});
test("event and settings replay retain their original intent and expected version", async () => {
  const seen = [],
    api = createCalendarApi(async (path, options) => {
      seen.push(options.body);
      return path.endsWith("/settings")
        ? { timeZone: "Asia/Shanghai", version: 2, enabled: true }
        : { event };
    });
  const input = {
    clientRequestId: other,
    title: "学习",
    kind: "study",
    time: event.time,
    version: 1,
  };
  await api.save(id, input);
  await api.save(id, input);
  assert.deepEqual(seen[0], seen[1]);
  await api.setZone({
    clientRequestId: other,
    version: 1,
    timeZone: "Asia/Shanghai",
  });
  assert.equal(seen.at(-1).version, 1);
});
test("wrong detail IDs, invalid timezone metadata and unbound task context are rejected", async () => {
  const api = createCalendarApi(async (path) =>
    path.endsWith("/settings")
      ? { timeZone: "not/a/zone", version: 1, enabled: true }
      : path.includes("/task-event")
        ? {
            task: {
              taskId: other,
              planId: id,
              studySetId: id,
              title: "别的任务",
            },
            event: null,
          }
        : { event: { ...event, id: other } },
  );
  await assert.rejects(api.get(id), (e) => e.code === "invalid_response");
  await assert.rejects(api.settings(), (e) => e.code === "invalid_response");
  await assert.rejects(
    api.task({ studySetId: id, planId: id, taskId: id }),
    (e) => e.code === "invalid_response",
  );
});
test("repeated-hour labels show both offsets rather than a zero-length clock interval", async () => {
  const { formatCalendarTime } = await import("./api.ts");
  const e = {
    ...event,
    time: {
      kind: "timed",
      start: "2026-11-01T01:30-04:00",
      end: "2026-11-01T01:30-05:00",
      timeZone: "America/New_York",
      startLocal: "2026-11-01T01:30",
      endLocal: "2026-11-01T01:30",
      startsAt: "2026-11-01T05:30:00.000Z",
      endsAt: "2026-11-01T06:30:00.000Z",
    },
  };
  parseEvent(e);
  const label = formatCalendarTime(e, "America/New_York");
  assert.ok(label.includes("-4"));
  assert.ok(label.includes("-5"));
});

test("weekly distribution excludes a skipped day but retains floating all-day records", async () => {
  const { eventInDay } = await import("./api.ts");
  const day = {
      date: "2011-12-30",
      startsAt: "2011-12-30T10:00:00.000Z",
      endsAt: "2011-12-30T10:00:00.000Z",
    },
    timed = {
      ...event,
      time: {
        kind: "timed",
        startsAt: "2011-12-30T09:00:00.000Z",
        endsAt: "2011-12-30T11:00:00.000Z",
      },
    };
  assert.equal(eventInDay(timed, day), false);
  assert.equal(
    eventInDay(
      { ...event, time: { kind: "all_day", date: "2011-12-30" } },
      day,
    ),
    true,
  );
  assert.equal(
    eventInDay(timed, {
      date: "2011-12-29",
      startsAt: "2011-12-29T10:00:00.000Z",
      endsAt: day.startsAt,
    }),
    true,
  );
});
