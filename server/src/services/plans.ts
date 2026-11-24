import { z } from "zod";
import type { Db, Queryable } from "../db/db.js";
import { GenerationError } from "../generation/types.js";
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
  ownedActivity,
  activityTables,
  type ActivityKind,
} from "./organization-common.js";
type Row = Record<string, any>;
const activity = z
  .object({ kind: z.enum(["material", "deck", "quiz", "note"]), id: uuid })
  .strict();
export const planCreate = z
  .object({
    clientRequestId: uuid,
    title: plainTitle,
    goal: z
      .string()
      .max(2000)
      .refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v))
      .default(""),
    dueDate: dateOnly.nullable().default(null),
  })
  .strict();
export const planEdit = z
  .object({
    clientRequestId: uuid,
    version,
    title: plainTitle,
    goal: z
      .string()
      .max(2000)
      .refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v)),
    dueDate: dateOnly.nullable(),
  })
  .strict();
export const taskCreate = z
  .object({
    clientRequestId: uuid,
    title: plainTitle,
    dueDate: dateOnly.nullable().default(null),
    activity: activity.nullable().default(null),
  })
  .strict();
export const taskEdit = z
  .object({
    clientRequestId: uuid,
    version,
    title: plainTitle.optional(),
    dueDate: dateOnly.nullable().optional(),
    manualCompleted: z.boolean().optional(),
    cancelled: z.boolean().optional(),
  })
  .strict()
  .refine((v) =>
    ["title", "dueDate", "manualCompleted", "cancelled"].some((k) => k in v),
  );
export const evidenceInput = z
  .object({
    clientRequestId: uuid,
    version,
    sessionKind: z.enum(["flashcard_session", "spaced_review", "quiz_attempt"]),
    sessionId: uuid,
  })
  .strict();
const planView = (r: Row) => ({
  id: r.id,
  studySetId: r.study_set_id,
  title: r.title,
  goal: r.goal,
  dueDate: r.due_date_text ?? null,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});
export class PlanService {
  constructor(private db: Db) {}
  private async plan(q: Queryable, user: string, set: string, id: string) {
    const [r] = await q.query<Row>(
      "SELECT *,to_char(due_date,$fmt$YYYY-MM-DD$fmt$) AS due_date_text FROM study_plans WHERE id=$1 AND user_id=$2 AND study_set_id=$3",
      [id, user, set],
    );
    if (!r) throw missing();
    return r;
  }
  private async task(
    q: Queryable,
    user: string,
    set: string,
    plan: string,
    id: string,
  ) {
    const [r] = await q.query<Row>(
      "SELECT *,to_char(due_date,$fmt$YYYY-MM-DD$fmt$) AS due_date_text FROM study_plan_tasks WHERE id=$1 AND user_id=$2 AND study_set_id=$3 AND plan_id=$4",
      [id, user, set, plan],
    );
    if (!r) throw missing();
    return r;
  }
  private async viewTask(q: Queryable, r: Row) {
    const evidence = await q.query<Row>(
      "SELECT * FROM study_plan_evidence WHERE user_id=$1 AND task_id=$2 ORDER BY linked_at,id",
      [r.user_id, r.id],
    );
    return {
      id: r.id,
      studySetId: r.study_set_id,
      planId: r.plan_id,
      title: r.title,
      dueDate: r.due_date_text ?? null,
      version: r.version,
      activity: r.activity_id
        ? { kind: r.activity_kind, id: r.activity_id, title: r.activity_title }
        : null,
      manualCompletedAt: iso(r.manual_completed_at),
      manualCompletedBy: r.manual_completed_by,
      cancelledAt: iso(r.cancelled_at),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      evidence: evidence.map((e) => ({
        id: e.id,
        sessionKind: e.session_kind,
        sessionId: e.session_id,
        completedAt: iso(e.completed_at),
        linkedAt: iso(e.linked_at),
      })),
    };
  }
  private async replay(
    q: Queryable,
    user: string,
    id: string,
    hash: string,
    kind: string,
  ) {
    const [r] = await q.query<Row>(
      "SELECT * FROM study_planning_requests WHERE user_id=$1 AND client_request_id=$2",
      [user, id],
    );
    if (r && (r.digest !== hash || r.entity_kind !== kind))
      throw new GenerationError(
        "idempotency_conflict",
        "这个请求已用于其他操作。",
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
      "INSERT INTO study_planning_requests(user_id,client_request_id,digest,entity_kind,entity_id) VALUES($1,$2,$3,$4,$5)",
      [user, id, hash, kind, entity],
    );
  }
  async list(user: string, set: string, cursor?: string) {
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      if (cursor) await this.plan(q, user, set, cursor);
      const rows = await q.query<Row>(
        `SELECT *,to_char(due_date,$fmt$YYYY-MM-DD$fmt$) AS due_date_text FROM study_plans WHERE user_id=$1 AND study_set_id=$2 ${cursor ? "AND (created_at,id)<(SELECT created_at,id FROM study_plans WHERE id=$3 AND user_id=$1)" : ""} ORDER BY created_at DESC,id DESC LIMIT 21`,
        [user, set, ...(cursor ? [cursor] : [])],
      );
      return {
        enabled: process.env.STUDYC_PLANS_ENABLED !== "false",
        items: rows.slice(0, 20).map(planView),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async get(user: string, set: string, id: string) {
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      return planView(await this.plan(q, user, set, id));
    });
  }
  async create(user: string, set: string, raw: unknown) {
    featureEnabled("STUDYC_PLANS_ENABLED");
    const input = planCreate.parse(raw),
      hash = digest(["create_plan", set, input]);
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      const old = await this.replay(
        q,
        user,
        input.clientRequestId,
        hash,
        "plan",
      );
      if (old)
        return {
          plan: planView(await this.plan(q, user, set, old)),
          replayed: true,
        };
      const [r] = await q.query<Row>(
        "INSERT INTO study_plans(user_id,study_set_id,title,goal,due_date) VALUES($1,$2,$3,$4,$5) RETURNING *,to_char(due_date,$fmt$YYYY-MM-DD$fmt$) AS due_date_text",
        [user, set, input.title, input.goal, input.dueDate],
      );
      await this.receipt(q, user, input.clientRequestId, hash, "plan", r!.id);
      return { plan: planView(r!), replayed: false };
    }, `studyc:planning:${user}`);
  }
  async edit(user: string, set: string, id: string, raw: unknown) {
    featureEnabled("STUDYC_PLANS_ENABLED");
    const input = planEdit.parse(raw),
      hash = digest(["edit_plan", set, id, input]);
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      const r = await this.plan(q, user, set, id);
      const old = await this.replay(
        q,
        user,
        input.clientRequestId,
        hash,
        "plan",
      );
      if (old)
        return {
          plan: planView(await this.plan(q, user, set, old)),
          replayed: true,
        };
      if (r.version !== input.version) throw conflict();
      const [n] = await q.query<Row>(
        "UPDATE study_plans SET title=$3,goal=$4,due_date=$5,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING *,to_char(due_date,$fmt$YYYY-MM-DD$fmt$) AS due_date_text",
        [id, user, input.title, input.goal, input.dueDate],
      );
      await this.receipt(q, user, input.clientRequestId, hash, "plan", id);
      return { plan: planView(n!), replayed: false };
    }, `studyc:planning:${user}`);
  }
  async tasks(user: string, set: string, plan: string, cursor?: string) {
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      await this.plan(q, user, set, plan);
      if (cursor) await this.task(q, user, set, plan, cursor);
      const rows = await q.query<Row>(
        `SELECT *,to_char(due_date,$fmt$YYYY-MM-DD$fmt$) AS due_date_text FROM study_plan_tasks WHERE user_id=$1 AND study_set_id=$2 AND plan_id=$3 ${cursor ? "AND (created_at,id)<(SELECT created_at,id FROM study_plan_tasks WHERE id=$4 AND user_id=$1)" : ""} ORDER BY created_at DESC,id DESC LIMIT 21`,
        [user, set, plan, ...(cursor ? [cursor] : [])],
      );
      return {
        items: await Promise.all(
          rows.slice(0, 20).map((r) => this.viewTask(q, r)),
        ),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async createTask(user: string, set: string, plan: string, raw: unknown) {
    featureEnabled("STUDYC_PLANS_ENABLED");
    const input = taskCreate.parse(raw),
      hash = digest(["create_task", set, plan, input]);
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      await this.plan(q, user, set, plan);
      const old = await this.replay(
        q,
        user,
        input.clientRequestId,
        hash,
        "task",
      );
      if (old)
        return {
          task: await this.viewTask(
            q,
            await this.task(q, user, set, plan, old),
          ),
          replayed: true,
        };
      const resource = input.activity
        ? await ownedActivity(
            q,
            user,
            set,
            input.activity.kind,
            input.activity.id,
          )
        : null;
      const [r] = await q.query<Row>(
        "INSERT INTO study_plan_tasks(user_id,study_set_id,plan_id,title,due_date,activity_kind,activity_id,activity_title) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *,to_char(due_date,$fmt$YYYY-MM-DD$fmt$) AS due_date_text",
        [
          user,
          set,
          plan,
          input.title,
          input.dueDate,
          input.activity?.kind ?? null,
          input.activity?.id ?? null,
          resource?.title ?? null,
        ],
      );
      await this.receipt(q, user, input.clientRequestId, hash, "task", r!.id);
      return { task: await this.viewTask(q, r!), replayed: false };
    }, `studyc:planning:${user}`);
  }
  async editTask(
    user: string,
    set: string,
    plan: string,
    id: string,
    raw: unknown,
  ) {
    featureEnabled("STUDYC_PLANS_ENABLED");
    const input = taskEdit.parse(raw),
      hash = digest(["edit_task", set, plan, id, input]);
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      await this.plan(q, user, set, plan);
      const r = await this.task(q, user, set, plan, id);
      const old = await this.replay(
        q,
        user,
        input.clientRequestId,
        hash,
        "task",
      );
      if (old)
        return {
          task: await this.viewTask(
            q,
            await this.task(q, user, set, plan, old),
          ),
          replayed: true,
        };
      if (r.version !== input.version) throw conflict();
      if (input.manualCompleted && (input.cancelled ?? !!r.cancelled_at))
        throw new GenerationError("job_conflict", "请先恢复已取消的任务。");
      const [n] = await q.query<Row>(
        `UPDATE study_plan_tasks SET title=$3,due_date=$4,manual_completed_at=$5,manual_completed_by=$6,cancelled_at=$7,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING *,to_char(due_date,$fmt$YYYY-MM-DD$fmt$) AS due_date_text`,
        [
          id,
          user,
          input.title ?? r.title,
          input.dueDate === undefined ? r.due_date_text : input.dueDate,
          input.manualCompleted === undefined
            ? r.manual_completed_at
            : input.manualCompleted
              ? (r.manual_completed_at ?? new Date())
              : null,
          input.manualCompleted === undefined
            ? r.manual_completed_by
            : input.manualCompleted
              ? user
              : null,
          input.cancelled === undefined
            ? r.cancelled_at
            : input.cancelled
              ? (r.cancelled_at ?? new Date())
              : null,
        ],
      );
      await this.receipt(q, user, input.clientRequestId, hash, "task", id);
      return { task: await this.viewTask(q, n!), replayed: false };
    }, `studyc:planning:${user}`);
  }
  private async eligible(q: Queryable, r: Row) {
    if (r.activity_kind === "quiz")
      return await q.query<Row>(
        `SELECT a.id,'quiz_attempt' AS kind,a.submitted_at AS completed_at FROM study_quiz_attempts a JOIN study_quizzes z ON z.id=a.quiz_id AND z.user_id=a.user_id WHERE a.user_id=$1 AND z.study_set_id=$2 AND a.quiz_id=$3 AND a.status='submitted' AND a.created_at>=(SELECT created_at FROM study_plan_tasks WHERE id=$4 AND user_id=$1) ORDER BY a.submitted_at DESC,a.id DESC LIMIT 50`,
        [r.user_id, r.study_set_id, r.activity_id, r.id],
      );
    if (r.activity_kind !== "deck") return [];
    const ordinary = await q.query<Row>(
      `SELECT id,'flashcard_session' AS kind,updated_at AS completed_at FROM study_flashcard_sessions WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 AND status='completed' AND created_at>=(SELECT created_at FROM study_plan_tasks WHERE id=$4 AND user_id=$1) ORDER BY updated_at DESC,id DESC LIMIT 50`,
      [r.user_id, r.study_set_id, r.activity_id, r.id],
    );
    const spaced = await q.query<Row>(
      `SELECT id,'spaced_review' AS kind,(data->>'updatedAt')::timestamptz AS completed_at FROM study_spaced_review_sessions WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 AND data->>'status'='completed' AND (data->>'reviewedCount')::integer>0 AND created_at>=(SELECT created_at FROM study_plan_tasks WHERE id=$4 AND user_id=$1) ORDER BY created_at DESC,id DESC LIMIT 50`,
      [r.user_id, r.study_set_id, r.activity_id, r.id],
    );
    return [...ordinary, ...spaced]
      .sort(
        (a, b) => b.completed_at - a.completed_at || b.id.localeCompare(a.id),
      )
      .slice(0, 50);
  }
  async evidence(user: string, set: string, plan: string, id: string) {
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      await this.plan(q, user, set, plan);
      const r = await this.task(q, user, set, plan, id);
      return {
        items: (await this.eligible(q, r)).map((e) => ({
          sessionId: e.id,
          sessionKind: e.kind,
          completedAt: iso(e.completed_at),
        })),
      };
    });
  }
  async linkEvidence(
    user: string,
    set: string,
    plan: string,
    id: string,
    raw: unknown,
  ) {
    featureEnabled("STUDYC_PLANS_ENABLED");
    const input = evidenceInput.parse(raw),
      hash = digest(["link_evidence", set, plan, id, input]);
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      await this.plan(q, user, set, plan);
      const r = await this.task(q, user, set, plan, id);
      const old = await this.replay(
        q,
        user,
        input.clientRequestId,
        hash,
        "task",
      );
      if (old)
        return {
          task: await this.viewTask(
            q,
            await this.task(q, user, set, plan, old),
          ),
          replayed: true,
        };
      if (r.version !== input.version) throw conflict();
      if (r.cancelled_at)
        throw new GenerationError("job_conflict", "请先恢复已取消的任务。");
      const evidence = (await this.eligible(q, r)).find(
        (e) => e.id === input.sessionId && e.kind === input.sessionKind,
      );
      if (!evidence) throw missing();
      await q.query(
        "INSERT INTO study_plan_evidence(user_id,task_id,session_kind,session_id,completed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,session_kind,session_id) DO NOTHING",
        [user, id, evidence.kind, evidence.id, evidence.completed_at],
      );
      const [n] = await q.query<Row>(
        "UPDATE study_plan_tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING *,to_char(due_date,$fmt$YYYY-MM-DD$fmt$) AS due_date_text",
        [id, user],
      );
      await this.receipt(q, user, input.clientRequestId, hash, "task", id);
      return { task: await this.viewTask(q, n!), replayed: false };
    }, `studyc:planning:${user}`);
  }
  async options(
    user: string,
    set: string,
    kind: ActivityKind,
    cursor?: string,
  ) {
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      if (cursor) await ownedActivity(q, user, set, kind, cursor);
      const rows = await q.query<{ id: string; title: string }>(
        `SELECT id,title FROM ${activityTables[kind]} WHERE user_id=$1 AND study_set_id=$2 ${cursor ? "AND id>$3" : ""} ORDER BY id LIMIT 21`,
        [user, set, ...(cursor ? [cursor] : [])],
      );
      return {
        items: rows.slice(0, 20),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
}
