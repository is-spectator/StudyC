import { z } from "zod";
import type { Db, Queryable } from "../db/db.js";
import { requireActiveUser } from "./identity.js";
import {
  uuid,
  version,
  plainTitle,
  dateOnly,
  missing,
  conflict,
  digest,
  iso,
  ownedSet,
  featureEnabled,
} from "./organization-common.js";
import {
  timeZone,
  timeOptions,
  absoluteInput,
  localAt,
  dayBoundary,
  dayAdd,
} from "./calendar-time.js";
import { GenerationError } from "../generation/types.js";
type Row = Record<string, any>;
export const timingInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all_day"), date: dateOnly }).strict(),
  z
    .object({
      kind: z.literal("timed"),
      start: z.string().max(40),
      end: z.string().max(40),
      timeZone: z.string().min(1).max(80),
    })
    .strict(),
]);
const sourceTask = z
  .object({ studySetId: uuid, planId: uuid, taskId: uuid })
  .strict();
const fields = {
  title: plainTitle,
  description: z
    .string()
    .max(2000)
    .refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v))
    .default(""),
  kind: z.enum(["study", "exam", "personal"]),
  time: timingInput,
};
const acknowledgement = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable()
  .default(null);
export const calendarCreate = z
  .object({
    clientRequestId: uuid,
    ...fields,
    sourceTask: sourceTask.nullable().default(null),
    acknowledgeConflicts: acknowledgement,
  })
  .strict();
export const calendarEdit = z
  .object({
    clientRequestId: uuid,
    version,
    ...fields,
    cancelled: z.boolean(),
    acknowledgeConflicts: acknowledgement,
  })
  .strict();
export const conflictInput = z
  .object({
    ...fields,
    eventId: uuid.optional(),
    sourceTask: sourceTask.nullable().default(null),
  })
  .strict();
export const settingsInput = z
  .object({
    clientRequestId: uuid,
    version: z.number().int().min(0).max(2147483646),
    timeZone: z.string().min(1).max(80),
  })
  .strict();
export const calendarRange = z
  .object({ from: dateOnly, to: dateOnly, cursor: uuid.optional() })
  .strict()
  .refine(
    (v) =>
      v.from <= v.to && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 < 42,
  );
function normalizeTime(raw: z.infer<typeof timingInput>) {
  if (raw.kind === "all_day")
    return { data: raw, day: raw.date, start: null, end: null, zone: null };
  const zone = timeZone(raw.timeZone),
    start = absoluteInput(raw.start, zone),
    end = absoluteInput(raw.end, zone);
  if (
    end.instant <= start.instant ||
    Date.parse(end.instant) - Date.parse(start.instant) > 7 * 86400000
  )
    throw new GenerationError(
      "invalid_input",
      "结束时间须晚于开始时间，单次安排最长7天。",
    );
  return {
    data: {
      kind: "timed" as const,
      start: start.value,
      end: end.value,
      timeZone: zone,
      startsAt: start.instant,
      endsAt: end.instant,
      startLocal: raw.start.slice(0, 16),
      endLocal: raw.end.slice(0, 16),
    },
    day: null,
    start: start.instant,
    end: end.instant,
    zone,
  };
}
const join = `SELECT e.*,t.cancelled_at AS task_cancelled_at FROM study_calendar_events e LEFT JOIN study_plan_tasks t ON t.id=e.task_id AND t.user_id=e.user_id AND t.study_set_id=e.study_set_id AND t.plan_id=e.plan_id`;
const present = (r: Row) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  kind: r.kind,
  time: r.timing,
  sourceTask: r.task_id
    ? { studySetId: r.study_set_id, planId: r.plan_id, taskId: r.task_id }
    : null,
  cancelledAt: iso(r.cancelled_at),
  taskCancelledAt: iso(r.task_cancelled_at ?? null),
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});
export class CalendarService {
  constructor(private db: Db) {}
  private async settings(q: Queryable, user: string) {
    const [r] = await q.query<Row>(
      "SELECT * FROM study_calendar_settings WHERE user_id=$1",
      [user],
    );
    return { timeZone: r?.time_zone ?? "UTC", version: r?.version ?? 0 };
  }
  private async event(q: Queryable, user: string, id: string) {
    const [r] = await q.query<Row>(`${join} WHERE e.user_id=$1 AND e.id=$2`, [
      user,
      id,
    ]);
    if (!r) throw missing();
    return r;
  }
  private async task(
    q: Queryable,
    user: string,
    source: z.infer<typeof sourceTask>,
  ) {
    await ownedSet(q, user, source.studySetId);
    const [r] = await q.query<Row>(
      "SELECT t.*,to_char(t.due_date,$f$YYYY-MM-DD$f$) AS due_date_text FROM study_plan_tasks t JOIN study_plans p ON p.id=t.plan_id AND p.user_id=t.user_id AND p.study_set_id=t.study_set_id WHERE t.user_id=$1 AND t.study_set_id=$2 AND t.plan_id=$3 AND t.id=$4 FOR SHARE OF t,p",
      [user, source.studySetId, source.planId, source.taskId],
    );
    if (!r) throw missing();
    return r;
  }
  private async replay(
    q: Queryable,
    user: string,
    id: string,
    hash: string,
    kind: string,
  ) {
    const [r] = await q.query<Row>(
      "SELECT * FROM study_calendar_requests WHERE user_id=$1 AND client_request_id=$2",
      [user, id],
    );
    if (r && (r.digest !== hash || r.entity_kind !== kind))
      throw new GenerationError(
        "idempotency_conflict",
        "请求ID已用于另一个操作。",
      );
    return r?.entity_id as string | undefined;
  }
  private async receipt(
    q: Queryable,
    user: string,
    id: string,
    hash: string,
    kind: string,
    entity: string,
  ) {
    await q.query(
      "INSERT INTO study_calendar_requests(user_id,client_request_id,digest,entity_kind,entity_id) VALUES($1,$2,$3,$4,$5)",
      [user, id, hash, kind, entity],
    );
  }
  async getSettings(user: string) {
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      return {
        ...(await this.settings(q, user)),
        enabled: process.env.STUDYC_CALENDAR_ENABLED !== "false",
      };
    });
  }
  async setSettings(user: string, raw: unknown) {
    featureEnabled("STUDYC_CALENDAR_ENABLED");
    const input = settingsInput.parse(raw),
      zone = timeZone(input.timeZone),
      hash = digest(["calendar_settings", input.version, zone]);
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      if (await this.replay(q, user, input.clientRequestId, hash, "settings"))
        return { ...(await this.settings(q, user)), enabled: true };
      const old = await this.settings(q, user);
      if (old.version !== input.version) throw conflict();
      await q.query(
        "INSERT INTO study_calendar_settings(user_id,time_zone,version) VALUES($1,$2,1) ON CONFLICT(user_id) DO UPDATE SET time_zone=$2,version=study_calendar_settings.version+1",
        [user, zone],
      );
      await this.receipt(
        q,
        user,
        input.clientRequestId,
        hash,
        "settings",
        user,
      );
      return { ...(await this.settings(q, user)), enabled: true };
    }, `studyc:calendar:${user}`);
  }
  async options(user: string, local: string, zone: string) {
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      return timeOptions(local, zone);
    });
  }
  async get(user: string, id: string) {
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      return present(await this.event(q, user, id));
    });
  }
  async taskEvent(user: string, raw: unknown) {
    const source = sourceTask.parse(raw);
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      const task = await this.task(q, user, source),
        [r] = await q.query<Row>(
          `${join} WHERE e.user_id=$1 AND e.task_id=$2 AND e.cancelled_at IS NULL`,
          [user, task.id],
        );
      return {
        task: {
          ...source,
          title: task.title,
          dueDate: task.due_date_text ?? null,
          cancelledAt: iso(task.cancelled_at),
        },
        event: r ? present(r) : null,
      };
    });
  }
  async list(user: string, raw: unknown) {
    const range = calendarRange.parse(raw);
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      const settings = await this.settings(q, user),
        start = dayBoundary(range.from, settings.timeZone),
        end = dayBoundary(dayAdd(range.to, 1), settings.timeZone);
      if (range.cursor) {
        const r = await this.event(q, user, range.cursor);
        const day = r.timing.kind === "all_day" ? r.timing.date : null;
        if (
          !(day
            ? day >= range.from && day <= range.to
            : start < end &&
              r.starts_at < new Date(end) &&
              r.ends_at > new Date(start))
        )
          throw new GenerationError(
            "invalid_input",
            "分页游标不属于当前日期范围。",
          );
      }
      const rows = await q.query<Row>(
        `${join} WHERE e.user_id=$1 AND ((e.all_day BETWEEN $2::date AND $3::date) OR ($4::timestamptz<$5::timestamptz AND e.starts_at<$5::timestamptz AND e.ends_at>$4::timestamptz)) ${range.cursor ? "AND e.id>$6" : ""} ORDER BY e.id LIMIT 21`,
        [
          user,
          range.from,
          range.to,
          start,
          end,
          ...(range.cursor ? [range.cursor] : []),
        ],
      );
      return {
        timeZone: settings.timeZone,
        items: rows.slice(0, 20).map(present),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  private async conflicts(
    q: Queryable,
    user: string,
    time: ReturnType<typeof normalizeTime>,
    exclude?: string,
  ) {
    const { timeZone: zone } = await this.settings(q, user);
    const endpointDates = time.day
      ? [time.day, time.day]
      : [
          localAt(time.start!, zone).slice(0, 10),
          localAt(Date.parse(time.end!) - 1, zone).slice(0, 10),
        ].sort();
    const from = endpointDates[0]!,
      to = endpointDates[1]!,
      start = time.start ?? dayBoundary(from, zone),
      end = time.end ?? dayBoundary(dayAdd(to, 1), zone);
    const days: string[] = [];
    for (let day = from; day <= to; day = dayAdd(day, 1)) {
      if (time.day) {
        days.push(day);
        continue;
      }
      const first = dayBoundary(day, zone),
        last = dayBoundary(dayAdd(day, 1), zone);
      if (first < last && first < end && last > start) days.push(day);
    }
    const rows = await q.query<Row>(
      `${join} WHERE e.user_id=$1 AND e.cancelled_at IS NULL AND t.cancelled_at IS NULL AND ((e.all_day=ANY($2::date[])) OR ($3::timestamptz<$4::timestamptz AND e.starts_at<$4::timestamptz AND e.ends_at>$3::timestamptz)) ${exclude ? "AND e.id<>$5" : ""} ORDER BY e.id LIMIT 101`,
      [user, days, start, end, ...(exclude ? [exclude] : [])],
    );
    if (rows.length > 100)
      throw new GenerationError(
        "invalid_input",
        "这个时段的冲突超过100项，请缩短安排时间。",
      );
    const token = rows.length
      ? digest([zone, time.data, rows.map((r) => [r.id, r.version])])
      : null;
    return {
      conflicts: rows.map((r) => ({
        id: r.id,
        title: r.title,
        version: r.version,
      })),
      conflictToken: token,
    };
  }
  async preview(user: string, raw: unknown) {
    const input = conflictInput.parse(raw),
      time = normalizeTime(input.time);
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      if (input.eventId) await this.event(q, user, input.eventId);
      if (input.sourceTask) await this.task(q, user, input.sourceTask);
      return this.conflicts(q, user, time, input.eventId);
    });
  }
  async create(user: string, raw: unknown) {
    featureEnabled("STUDYC_CALENDAR_ENABLED");
    const input = calendarCreate.parse(raw),
      time = normalizeTime(input.time),
      creation = digest([
        input.title,
        input.description,
        input.kind,
        time.data,
        input.sourceTask,
      ]),
      hash = digest(["create_event", creation, input.acknowledgeConflicts]);
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      const old = await this.replay(
        q,
        user,
        input.clientRequestId,
        hash,
        "event",
      );
      if (old)
        return {
          event: present(await this.event(q, user, old)),
          replayed: true,
        };
      if (input.sourceTask) {
        const task = await this.task(q, user, input.sourceTask);
        if (task.cancelled_at)
          throw new GenerationError(
            "job_conflict",
            "关联任务已取消，请先在计划中恢复。",
          );
        const [existing] = await q.query<Row>(
          "SELECT * FROM study_calendar_events WHERE user_id=$1 AND task_id=$2 AND cancelled_at IS NULL",
          [user, task.id],
        );
        if (existing) {
          if (existing.creation_digest !== creation)
            throw new GenerationError(
              "job_conflict",
              "这个任务已有日程，请打开已有安排修改。",
            );
          await this.receipt(
            q,
            user,
            input.clientRequestId,
            hash,
            "event",
            existing.id,
          );
          return {
            event: present(await this.event(q, user, existing.id)),
            replayed: true,
          };
        }
      }
      const preview = await this.conflicts(q, user, time);
      if (preview.conflictToken !== input.acknowledgeConflicts)
        throw new GenerationError(
          "job_conflict",
          "时间冲突已变化，请检查冲突后明确确认保存。",
        );
      const [r] = await q.query<Row>(
        "INSERT INTO study_calendar_events(user_id,title,description,kind,all_day,starts_at,ends_at,time_zone,timing,study_set_id,plan_id,task_id,creation_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13) RETURNING id",
        [
          user,
          input.title,
          input.description,
          input.kind,
          time.day,
          time.start,
          time.end,
          time.zone,
          JSON.stringify(time.data),
          input.sourceTask?.studySetId ?? null,
          input.sourceTask?.planId ?? null,
          input.sourceTask?.taskId ?? null,
          creation,
        ],
      );
      await this.receipt(q, user, input.clientRequestId, hash, "event", r!.id);
      return {
        event: present(await this.event(q, user, r!.id)),
        replayed: false,
      };
    }, `studyc:calendar:${user}`);
  }
  async edit(user: string, id: string, raw: unknown) {
    featureEnabled("STUDYC_CALENDAR_ENABLED");
    const input = calendarEdit.parse(raw),
      time = normalizeTime(input.time),
      hash = digest([
        "edit_event",
        id,
        input.version,
        input.title,
        input.description,
        input.kind,
        time.data,
        input.cancelled,
        input.acknowledgeConflicts,
      ]);
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      const r = await this.event(q, user, id);
      if (await this.replay(q, user, input.clientRequestId, hash, "event"))
        return {
          event: present(await this.event(q, user, id)),
          replayed: true,
        };
      if (r.version !== input.version) throw conflict();
      if (r.task_id) {
        const task = await this.task(q, user, {
          studySetId: r.study_set_id,
          planId: r.plan_id,
          taskId: r.task_id,
        });
        r.task_cancelled_at = task.cancelled_at;
        if (!input.cancelled) {
          const [other] = await q.query(
            "SELECT id FROM study_calendar_events WHERE user_id=$1 AND task_id=$2 AND id<>$3 AND cancelled_at IS NULL",
            [user, r.task_id, id],
          );
          if (other)
            throw new GenerationError(
              "job_conflict",
              "此任务已有其他有效日程，不能重复恢复。",
            );
        }
      }
      if (!input.cancelled && !r.task_cancelled_at) {
        const preview = await this.conflicts(q, user, time, id);
        if (preview.conflictToken !== input.acknowledgeConflicts)
          throw new GenerationError(
            "job_conflict",
            "时间冲突已变化，请检查冲突后明确确认保存。",
          );
      }
      await q.query(
        "UPDATE study_calendar_events SET title=$3,description=$4,kind=$5,all_day=$6,starts_at=$7,ends_at=$8,time_zone=$9,timing=$10::jsonb,cancelled_at=$11,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
        [
          user,
          id,
          input.title,
          input.description,
          input.kind,
          time.day,
          time.start,
          time.end,
          time.zone,
          JSON.stringify(time.data),
          input.cancelled ? (r.cancelled_at ?? new Date()) : null,
        ],
      );
      await this.receipt(q, user, input.clientRequestId, hash, "event", id);
      return { event: present(await this.event(q, user, id)), replayed: false };
    }, `studyc:calendar:${user}`);
  }
}
