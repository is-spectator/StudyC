import { StudyError } from "./study-data.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db/db.js";
import { requireVisibleSet } from "./set-visibility.js";
import {
  uuid,
  version,
  digest,
  featureEnabled,
  conflict,
  missing,
} from "./organization-common.js";
import { GenerationError } from "../generation/types.js";
const text = z.string().refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v));
const title = text
  .transform((v) => v.trim())
  .refine((v) => Array.from(v).length >= 1 && Array.from(v).length <= 60);
const selected = z
  .array(z.object({ id: uuid, version }).strict())
  .max(100)
  .refine((v) => new Set(v.map((i) => i.id)).size === v.length);
const schema = z
  .object({
    clientRequestId: uuid,
    sourceSetId: uuid,
    sourceVersion: version,
    materials: selected,
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("new_set"), title }).strict(),
      z.object({ kind: z.literal("existing_set"), id: uuid }).strict(),
    ]),
  })
  .strict()
  .refine((v) => v.target.kind === "new_set" || v.materials.length > 0);
type Row = Record<string, any>;
export class ContentCopyService {
  constructor(private db: Db) {}
  async preview(user: string, set: string, material?: string) {
    return this.db.tx(async (q) => {
      const source = await requireVisibleSet(q, user, set),
        [state] = await q.query<Row>(
          "SELECT version FROM study_sets WHERE id=$1 AND user_id=$2",
          [set, user],
        );
      const rows = await q.query<Row>(
        `SELECT id,title,version,octet_length(body) AS bytes FROM study_materials WHERE user_id=$1 AND study_set_id=$2 ${material ? "AND id=$3" : ""} ORDER BY id LIMIT 101`,
        [user, set, ...(material ? [material] : [])],
      );
      if (material && !rows.length) throw missing();
      return {
        enabled: process.env.STUDYC_COPY_ENABLED !== "false",
        source: { ...source, version: state!.version },
        items: rows.slice(0, 100),
        hasMore: rows.length > 100,
      };
    });
  }
  private async result(q: Queryable, user: string, r: Row, replayed: boolean) {
    await requireVisibleSet(q, user, r.target_set_id);
    return { targetSetId: r.target_set_id, mappings: r.mappings, replayed };
  }
  async copy(user: string, raw: unknown) {
    featureEnabled("STUDYC_COPY_ENABLED");
    const input = schema.parse(raw),
      hash = digest(input);
    // The request ID identifies one immutable command; it is included in its digest.
    return this.db.tx(async (q) => {
      await requireVisibleSet(q, user, input.sourceSetId);
      const [old] = await q.query<Row>(
        "SELECT * FROM study_copy_requests WHERE user_id=$1 AND client_request_id=$2",
        [user, input.clientRequestId],
      );
      if (old) {
        if (old.digest !== hash)
          throw new GenerationError(
            "idempotency_conflict",
            "这个复制请求已用于其他内容。",
          );
        return this.result(q, user, old, true);
      }
      const [source] = await q.query<Row>(
        "SELECT version FROM study_sets WHERE user_id=$1 AND id=$2",
        [user, input.sourceSetId],
      );
      if (source!.version !== input.sourceVersion) throw conflict();
      const materials: Row[] = [];
      let bytes = 0;
      for (const item of input.materials) {
        const [r] = await q.query<Row>(
          "SELECT id,title,body,version FROM study_materials WHERE user_id=$1 AND study_set_id=$2 AND id=$3 FOR SHARE",
          [user, input.sourceSetId, item.id],
        );
        if (!r) throw missing();
        if (r.version !== item.version) throw conflict();
        bytes += Buffer.byteLength(r.body);
        if (bytes > 10 * 1024 * 1024)
          throw new StudyError(
            "payload_too_large",
            "每次复制正文合计最多10 MiB，请减少选择。",
          );
        materials.push(r);
      }
      let target: string;
      if (input.target.kind === "existing_set") {
        await requireVisibleSet(q, user, input.target.id);
        target = input.target.id;
      } else {
        const [r] = await q.query<{ id: string }>(
          "INSERT INTO study_sets(user_id,title,client_request_id,creation_digest) VALUES($1,$2,$3,$4) RETURNING id",
          [
            user,
            input.target.title,
            randomUUID(),
            digest([input.target.title]),
          ],
        );
        target = r!.id;
      }
      const mappings = [];
      for (const m of materials) {
        const [r] = await q.query<{ id: string }>(
          "INSERT INTO study_materials(user_id,study_set_id,title,body,client_request_id,creation_digest) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [
            user,
            target,
            m.title,
            m.body,
            randomUUID(),
            digest([target, m.title, m.body]),
          ],
        );
        mappings.push({
          sourceMaterialId: m.id,
          sourceVersion: m.version,
          sourceDigest: digest([m.title, m.body]),
          targetMaterialId: r!.id,
        });
      }
      const [receipt] = await q.query<Row>(
        "INSERT INTO study_copy_requests(user_id,client_request_id,digest,source_set_id,target_set_id,mappings) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *",
        [
          user,
          input.clientRequestId,
          hash,
          input.sourceSetId,
          target,
          JSON.stringify(mappings),
        ],
      );
      return this.result(q, user, receipt!, false);
    }, `studyc:organization:${user}`);
  }
}
