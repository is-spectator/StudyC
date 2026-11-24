import { z } from "zod";
import type { Db, Queryable } from "../db/db.js";
import type { GenerationStore } from "../generation/store.js";
import { GenerationError } from "../generation/types.js";
import { requireActiveUser } from "./identity.js";
import {
  uuid,
  digest,
  iso,
  missing,
  conflict,
  featureEnabled,
} from "./organization-common.js";
const inputSchema = z
  .object({
    clientRequestId: uuid,
    version: z.number().int().min(0).max(2147483646),
    deleted: z.boolean(),
  })
  .strict();
type Row = Record<string, any>;
export class TrashService {
  constructor(
    private db: Db,
    private store?: GenerationStore,
  ) {}
  private async state(q: Queryable, user: string, set: string, write = false) {
    const [r] = await q.query<Row>(
      `SELECT id,title FROM study_sets WHERE user_id=$1 AND id=$2 ${write ? "FOR UPDATE" : "FOR SHARE"}`,
      [user, set],
    );
    if (!r) throw missing();
    const [l] = await q.query<Row>(
      "SELECT * FROM study_set_lifecycle WHERE user_id=$1 AND study_set_id=$2",
      [user, set],
    );
    return {
      id: r.id,
      title: r.title,
      version: l?.version ?? 0,
      deletedAt: iso(l?.deleted_at ?? null),
    };
  }
  async get(user: string, set: string) {
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      return this.state(q, user, set);
    });
  }
  async list(user: string, cursor?: string) {
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      if (cursor) {
        const current = await this.state(q, user, cursor);
        if (!current.deletedAt)
          throw new GenerationError(
            "invalid_input",
            "回收站内容已变化，请重新读取。",
          );
      }
      const rows = await q.query<Row>(
        `SELECT s.id,s.title,l.version,l.deleted_at FROM study_set_lifecycle l JOIN study_sets s ON s.id=l.study_set_id AND s.user_id=l.user_id WHERE l.user_id=$1 AND l.deleted_at IS NOT NULL ${cursor ? "AND s.id>$2" : ""} ORDER BY s.id LIMIT 21`,
        [user, ...(cursor ? [cursor] : [])],
      );
      return {
        enabled: process.env.STUDYC_TRASH_ENABLED !== "false",
        items: rows
          .slice(0, 20)
          .map((r) => ({
            id: r.id,
            title: r.title,
            version: r.version,
            deletedAt: iso(r.deleted_at),
          })),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async change(user: string, set: string, raw: unknown) {
    featureEnabled("STUDYC_TRASH_ENABLED");
    const input = inputSchema.parse(raw),
      hash = digest([set, input.version, input.deleted]);
    // Same lock ordering as generation enqueue/claim/settle: global lock then set row.
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      const current = await this.state(q, user, set, true);
      const [old] = await q.query<Row>(
        "SELECT * FROM study_trash_requests WHERE user_id=$1 AND client_request_id=$2",
        [user, input.clientRequestId],
      );
      if (old) {
        if (old.digest !== hash || old.study_set_id !== set)
          throw new GenerationError(
            "idempotency_conflict",
            "这个请求ID已用于其他操作。",
          );
        return { item: current, replayed: true };
      }
      if (current.version !== input.version) throw conflict();
      if (Boolean(current.deletedAt) === input.deleted)
        throw new GenerationError(
          "job_conflict",
          input.deleted ? "学习集已在回收站。" : "学习集已恢复。",
        );
      if (input.deleted) {
        if (this.store) await this.store.cancelSetInTransaction(q, user, set);
        else if (
          (
            await q.query(
              "SELECT id FROM study_generation_jobs WHERE user_id=$1 AND study_set_id=$2 AND status IN ('queued','running')",
              [user, set],
            )
          ).length
        )
          throw new GenerationError(
            "service_unavailable",
            "生成任务服务未就绪，请稍后再移入回收站。",
          );
      }
      await q.query(
        "INSERT INTO study_set_lifecycle(user_id,study_set_id,version,deleted_at) VALUES($1,$2,1,CASE WHEN $3::boolean THEN clock_timestamp() ELSE NULL END) ON CONFLICT(study_set_id,user_id) DO UPDATE SET version=study_set_lifecycle.version+1,deleted_at=excluded.deleted_at",
        [user, set, input.deleted],
      );
      await q.query(
        "INSERT INTO study_trash_requests(user_id,client_request_id,study_set_id,digest) VALUES($1,$2,$3,$4)",
        [user, input.clientRequestId, set, hash],
      );
      return { item: await this.state(q, user, set), replayed: false };
    }, "studyc:generations");
  }
}
