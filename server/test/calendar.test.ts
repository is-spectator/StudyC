import { randomUUID as id } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../src/db/db.js";
import { openTestDb, dropAdditionsAfter } from "./database.js";
import { CalendarService } from "../src/services/calendar.js";
import {
  timeOptions,
  absoluteInput,
  dayBoundary,
  localAt,
} from "../src/services/calendar-time.js";
import { PlanService } from "../src/services/plans.js";
import { createStudySet } from "../src/services/study-data.js";
import { migrate, checkMigrations } from "../src/db/migrations.js";
import { createApp } from "../src/api/app.js";
describe("IANA calendar wall times and date boundaries", () => {
  it("rejects nonexistent spring wall time and requires an explicit offset for a repeated hour", () => {
    expect(
      timeOptions("2026-03-08T02:30", "America/New_York").items,
    ).toHaveLength(0);
    const options = timeOptions("2026-11-01T01:30", "America/New_York").items;
    expect(options.map((o) => o.offset)).toEqual(["-04:00", "-05:00"]);
    expect(options.map((o) => o.instant)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
    expect(() =>
      absoluteInput("2026-03-08T02:30-05:00", "America/New_York"),
    ).toThrow();
    expect(() =>
      absoluteInput("2026-11-01T01:30Z", "America/New_York"),
    ).toThrow();
  });
  it("handles quarter-hour offsets, half-hour DST, skipped midnight and skipped whole dates", () => {
    expect(
      timeOptions("2026-01-01T12:00", "Asia/Kathmandu").items[0]!.offset,
    ).toBe("+05:45");
    expect(
      timeOptions("2026-10-04T02:15", "Australia/Lord_Howe").items,
    ).toHaveLength(0);
    expect(dayBoundary("2011-12-30", "Pacific/Apia")).toBe(
      dayBoundary("2011-12-31", "Pacific/Apia"),
    );
    expect(
      localAt(
        dayBoundary("2018-11-04", "America/Sao_Paulo"),
        "America/Sao_Paulo",
      ),
    ).toBe("2018-11-04T01:00");
  });
  it("rejects invalid dates and timezone identifiers and preserves floating dates through DST-length days", () => {
    expect(() => timeOptions("2026-02-30T09:00", "UTC")).toThrow();
    expect(() => timeOptions("2026-01-01T09:00", "not/a/zone")).toThrow();
    const spring =
      Date.parse(dayBoundary("2026-03-09", "America/New_York")) -
      Date.parse(dayBoundary("2026-03-08", "America/New_York"));
    expect(spring).toBe(23 * 3600000);
  });
});
describe("calendar ownership, explicit conflict acknowledgement, task linkage and persistence", () => {
  let db: Db,
    s: CalendarService,
    p: PlanService,
    user: string,
    bob: string,
    set: string,
    plan: string,
    task: string;
  beforeEach(async () => {
    db = await openTestDb();
    s = new CalendarService(db);
    p = new PlanService(db);
    const users = await db.query<{ id: string }>(
      "INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id",
    );
    user = users[0]!.id;
    bob = users[1]!.id;
    set = (
      await createStudySet(db, user, { clientRequestId: id(), title: "计划集" })
    ).studySet.id;
    plan = (await p.create(user, set, { clientRequestId: id(), title: "目标" }))
      .plan.id;
    task = (
      await p.createTask(user, set, plan, {
        clientRequestId: id(),
        title: "复习任务",
        dueDate: "2026-12-01",
      })
    ).task.id;
  }, 30000);
  afterEach(async () => {
    await db?.close();
  });
  const fields = (date = "2026-12-01") => ({
    title: "学习安排",
    kind: "study",
    description: "复习",
    time: { kind: "all_day", date },
  });
  const timed = (
    start = "2026-12-01T09:00+08:00",
    end = "2026-12-01T10:00+08:00",
  ) => ({
    ...fields(),
    time: { kind: "timed", start, end, timeZone: "Asia/Shanghai" },
  });
  const create = (fields: any) =>
    s.create(user, { clientRequestId: id(), ...fields });
  const source = () => ({ studySetId: set, planId: plan, taskId: task });
  async function zone(timeZone: string) {
    const old = await s.getSettings(user);
    return s.setSettings(user, {
      clientRequestId: id(),
      version: old.version,
      timeZone,
    });
  }
  it("stores calendar timezone independently of floating event dates and absolute timed instants", async () => {
    await zone("Asia/Shanghai");
    const day = (await create(fields())).event,
      clock = (
        await create(timed("2026-12-02T09:00+08:00", "2026-12-02T10:00+08:00"))
      ).event;
    await zone("America/Los_Angeles");
    expect((await s.get(user, day.id)).time).toEqual({
      kind: "all_day",
      date: "2026-12-01",
    });
    expect((await s.get(user, clock.id)).time).toMatchObject({
      startsAt: "2026-12-02T01:00:00.000Z",
      timeZone: "Asia/Shanghai",
    });
    expect(
      (await s.list(user, { from: "2026-12-01", to: "2026-12-01" })).items.map(
        (e) => e.id,
      ),
    ).toContain(clock.id);
  });
  it("does not place timed events on a skipped calendar date or falsely conflict with its floating all-day entry", async () => {
    await zone("Pacific/Apia");
    const day = (await create(fields("2011-12-30"))).event;
    const input = {
      ...fields(),
      time: {
        kind: "timed",
        start: "2011-12-29T23:00-10:00",
        end: "2011-12-31T01:00+14:00",
        timeZone: "Pacific/Apia",
      },
    };
    expect((await s.preview(user, input)).conflicts).toEqual([]);
    await create(input);
    const week = await s.list(user, { from: "2011-12-26", to: "2012-01-01" }),
      skipped = week.days.find((d) => d.date === "2011-12-30")!;
    expect(skipped.startsAt).toBe(skipped.endsAt);
    expect(
      (await s.list(user, { from: "2011-12-30", to: "2011-12-30" })).items.map(
        (e) => e.id,
      ),
    ).toEqual([day.id]);
  });
  it("deduplicates creation after lost response and rejects changed intent", async () => {
    const input = { clientRequestId: id(), ...fields() },
      a = await s.create(user, input);
    expect((await s.create(user, input)).event.id).toBe(a.event.id);
    expect(
      (await s.list(user, { from: "2026-12-01", to: "2026-12-01" })).items,
    ).toHaveLength(1);
    await expect(
      s.create(user, { ...input, title: "另一个" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("warns on overlaps, requires matching explicit acknowledgement and never moves another event", async () => {
    await zone("Asia/Shanghai");
    const a = (await create(timed())).event;
    const input = timed("2026-12-01T09:30+08:00", "2026-12-01T10:30+08:00");
    await expect(create(input)).rejects.toMatchObject({ code: "job_conflict" });
    const preview = await s.preview(user, input);
    expect(preview.conflicts).toMatchObject([{ id: a.id }]);
    const b = (
      await create({ ...input, acknowledgeConflicts: preview.conflictToken })
    ).event;
    expect((await s.get(user, a.id)).version).toBe(1);
    expect(b.time).toMatchObject({ start: "2026-12-01T09:30+08:00" });
  });
  it("invalidates stale conflict acknowledgement when another schedule changes", async () => {
    await zone("Asia/Shanghai");
    const a = (await create(timed())).event,
      input = timed("2026-12-01T09:30+08:00", "2026-12-01T10:30+08:00"),
      preview = await s.preview(user, input);
    await s.edit(user, a.id, {
      clientRequestId: id(),
      version: 1,
      ...timed(),
      cancelled: true,
    });
    await expect(
      create({ ...input, acknowledgeConflicts: preview.conflictToken }),
    ).rejects.toMatchObject({ code: "job_conflict" });
    expect((await s.preview(user, input)).conflictToken).toBe(null);
  });
  it("uses exclusive interval ends and accounts for all-day/timed overlap in the viewing timezone", async () => {
    await zone("Asia/Shanghai");
    await create(timed());
    expect(
      (
        await s.preview(
          user,
          timed("2026-12-01T10:00+08:00", "2026-12-01T11:00+08:00"),
        )
      ).conflicts,
    ).toEqual([]);
    expect((await s.preview(user, fields())).conflicts).toHaveLength(1);
    await create(timed("2026-12-02T23:00+08:00", "2026-12-03T00:00+08:00"));
    expect(
      (await s.list(user, { from: "2026-12-03", to: "2026-12-03" })).items,
    ).toEqual([]);
  });
  it("keeps linked task scheduling unique, including another request ID, and rejects silently replacing its time", async () => {
    const input = { ...fields(), sourceTask: source() },
      a = await create(input);
    expect((await create(input)).event.id).toBe(a.event.id);
    await expect(
      create({ ...input, ...fields("2026-12-02") }),
    ).rejects.toMatchObject({ code: "job_conflict" });
    expect((await s.taskEvent(user, source())).event!.id).toBe(a.event.id);
  });
  it("suspends linked calendars on task cancellation, restores on task recovery, and keeps calendar cancellation independent", async () => {
    const a = (await create({ ...fields(), sourceTask: source() })).event;
    let t = (
      await p.editTask(user, set, plan, task, {
        clientRequestId: id(),
        version: 1,
        cancelled: true,
      })
    ).task;
    expect((await s.get(user, a.id)).taskCancelledAt).toBeTruthy();
    expect((await s.preview(user, fields())).conflicts).toEqual([]);
    t = (
      await p.editTask(user, set, plan, task, {
        clientRequestId: id(),
        version: t.version,
        cancelled: false,
      })
    ).task;
    expect((await s.get(user, a.id)).taskCancelledAt).toBe(null);
    await s.edit(user, a.id, {
      clientRequestId: id(),
      version: a.version,
      ...fields(),
      cancelled: true,
    });
    expect((await p.tasks(user, set, plan)).items[0]!.cancelledAt).toBe(null);
    expect((await s.get(user, a.id)).cancelledAt).toBeTruthy();
  });
  it("does not auto-move the calendar when the task deadline changes, and detects stale event edits", async () => {
    const a = (await create({ ...fields(), sourceTask: source() })).event;
    await p.editTask(user, set, plan, task, {
      clientRequestId: id(),
      version: 1,
      dueDate: "2027-01-01",
    });
    expect((await s.get(user, a.id)).time).toEqual({
      kind: "all_day",
      date: "2026-12-01",
    });
    await s.edit(user, a.id, {
      clientRequestId: id(),
      version: 1,
      ...fields("2026-12-03"),
      cancelled: false,
    });
    await expect(
      s.edit(user, a.id, {
        clientRequestId: id(),
        version: 1,
        ...fields("2026-12-04"),
        cancelled: false,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });
  it("does not restore an old canceled linked event over a newer active schedule", async () => {
    const a = (await create({ ...fields(), sourceTask: source() })).event;
    await s.edit(user, a.id, {
      clientRequestId: id(),
      version: 1,
      ...fields(),
      cancelled: true,
    });
    await create({ ...fields("2026-12-02"), sourceTask: source() });
    await expect(
      s.edit(user, a.id, {
        clientRequestId: id(),
        version: 2,
        ...fields(),
        cancelled: false,
      }),
    ).rejects.toMatchObject({ code: "job_conflict" });
  });
  it("isolates events, conflict titles, source tasks, settings and pagination by owner", async () => {
    const a = (await create(fields())).event;
    await expect(s.get(bob, a.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await s.preview(bob, fields())).conflicts).toEqual([]);
    expect(
      (await s.list(bob, { from: "2026-12-01", to: "2026-12-01" })).items,
    ).toEqual([]);
    await expect(
      s.list(bob, { from: "2026-12-01", to: "2026-12-01", cursor: a.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      s.create(bob, {
        clientRequestId: id(),
        ...fields(),
        sourceTask: source(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await s.getSettings(bob)).version).toBe(0);
  });
  it("rejects non-positive durations, too-long windows and invalid range inputs", async () => {
    await expect(
      create(timed("2026-12-01T10:00+08:00", "2026-12-01T09:00+08:00")),
    ).rejects.toThrow();
    await expect(
      create(timed("2026-12-01T10:00+08:00", "2026-12-09T10:00+08:00")),
    ).rejects.toThrow();
    await expect(
      s.list(user, { from: "2026-01-01", to: "2027-01-01" }),
    ).rejects.toThrow();
  });
  it("maintains stable pagination and read-only data under feature closure", async () => {
    for (let i = 0; i < 22; i++)
      await create(fields(`2026-12-${String(i + 1).padStart(2, "0")}`));
    const first = await s.list(user, { from: "2026-12-01", to: "2026-12-31" }),
      second = await s.list(user, {
        from: "2026-12-01",
        to: "2026-12-31",
        cursor: first.nextCursor!,
      });
    expect(
      new Set([...first.items, ...second.items].map((e) => e.id)).size,
    ).toBe(22);
    const previous = process.env.STUDYC_CALENDAR_ENABLED;
    process.env.STUDYC_CALENDAR_ENABLED = "false";
    try {
      expect((await s.getSettings(user)).enabled).toBe(false);
      await expect(create(fields("2027-01-01"))).rejects.toMatchObject({
        code: "service_unavailable",
      });
      expect((await s.get(user, first.items[0]!.id)).id).toBe(
        first.items[0]!.id,
      );
    } finally {
      if (previous === undefined) delete process.env.STUDYC_CALENDAR_ENABLED;
      else process.env.STUDYC_CALENDAR_ENABLED = previous;
    }
  });
  it("guards HTTP session, CSRF, methods and request size", async () => {
    const app = createApp(db, {
        releaseId: "calendar-http",
        rateLimitSecret: new Uint8Array(32).fill(9),
        sessionFetch: async () =>
          Response.json({ userId: user, csrfToken: "a".repeat(43) }),
      }),
      headers = {
        cookie: "__Host-planplan-session=test",
        "X-PlanPlan-Expected-User": user,
        "X-CSRF-Token": "a".repeat(43),
        origin: "https://study.clyna.ai",
        "content-type": "application/json",
      },
      root = "/v1/study/calendar";
    expect((await app.request(root + "/settings")).status).toBe(401);
    expect(
      (await app.request(root + "/events", { headers, method: "DELETE" }))
        .status,
    ).toBe(405);
    expect(
      (
        await app.request(root + "/events", {
          headers: { ...headers, "X-CSRF-Token": "wrong" },
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(root + "/events", {
          headers,
          method: "POST",
          body: JSON.stringify({ x: "x".repeat(17000) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (await app.request(root + "/events?from=x&from=y", { headers })).status,
    ).toBe(400);
  });
  it("upgrades v10 without changing earlier data or registry and rejects schema drift", async () => {
    await dropAdditionsAfter(db, 10);
    const history = await db.query(
      "SELECT * FROM studyc_schema_migrations ORDER BY version",
    );
    await migrate(db);
    await migrate(db);
    await checkMigrations(db);
    expect(
      await db.query(
        "SELECT * FROM studyc_schema_migrations WHERE version<=10 ORDER BY version",
      ),
    ).toEqual(history);
    expect((await p.get(user, set, plan)).id).toBe(plan);
    await db.exec("DROP INDEX calendar_active_task");
    await expect(checkMigrations(db)).rejects.toThrow(/drift/);
  });
  it("cleans all calendar state on account deletion and refuses deleted identities", async () => {
    await create({ ...fields(), sourceTask: source() });
    await zone("Asia/Shanghai");
    await db.query("UPDATE users SET deleted_at=now() WHERE id=$1", [user]);
    await expect(
      s.list(user, { from: "2026-12-01", to: "2026-12-01" }),
    ).rejects.toThrow();
    await db.query("DELETE FROM users WHERE id=$1", [user]);
    for (const table of [
      "study_calendar_events",
      "study_calendar_settings",
      "study_calendar_requests",
    ])
      expect(
        await db.query(`SELECT * FROM ${table} WHERE user_id=$1`, [user]),
      ).toEqual([]);
  });
});
