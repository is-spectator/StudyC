import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import { requireVisibleSet } from "./set-visibility.js";
import { uuid, digest, featureEnabled } from "./organization-common.js";
import { GenerationError } from "../generation/types.js";
const text = z.string().refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v));
const item = z
  .object({
    sourceKey: z.literal("sf-k12:uploads"),
    sourceIndex: z.number().int().min(0).max(999),
    title: text
      .transform((v) => v.trim())
      .refine((v) => Array.from(v).length >= 1 && Array.from(v).length <= 120),
    body: text.refine((v) => Buffer.byteLength(v) <= 1048576),
  })
  .strict();
const schema = z
  .object({
    clientRequestId: uuid,
    sourceAccountId: uuid,
    targetSetId: uuid,
    items: z.array(item).min(1).max(100),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.items.map((i) => i.sourceKey + ":" + i.sourceIndex)).size ===
      v.items.length,
  );
type Row = Record<string, any>;
export class LocalImportService {
  constructor(private db: Db) {}
  async import(user: string, raw: unknown) {
    featureEnabled("STUDYC_IMPORT_ENABLED");
    const input = schema.parse(raw);
    if (input.sourceAccountId !== user)
      throw new GenerationError(
        "invalid_input",
        "只能导入当前账户明确导出的旧记录。",
      );
    const hash = digest(input);
    return this.db.tx(async (q) => {
      await requireVisibleSet(q, user, input.targetSetId);
      const [old] = await q.query<Row>(
        "SELECT * FROM study_import_requests WHERE user_id=$1 AND client_request_id=$2",
        [user, input.clientRequestId],
      );
      if (old) {
        if (old.digest !== hash)
          throw new GenerationError(
            "idempotency_conflict",
            "这个导入请求已用于其他内容。",
          );
        return {
          targetSetId: old.target_set_id,
          items: old.outcome,
          replayed: true,
        };
      }
      const outcome = [];
      for (const source of input.items) {
        const fingerprint = digest([
          user,
          source.sourceKey,
          source.sourceIndex,
          source.title,
          source.body,
        ]);
        const [existing] = await q.query<Row>(
          "SELECT material_id FROM study_import_items WHERE user_id=$1 AND target_set_id=$2 AND fingerprint=$3",
          [user, input.targetSetId, fingerprint],
        );
        let materialId = existing?.material_id;
        if (!materialId) {
          const [m] = await q.query<{ id: string }>(
            "INSERT INTO study_materials(user_id,study_set_id,title,body,client_request_id,creation_digest) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
            [
              user,
              input.targetSetId,
              source.title,
              source.body,
              randomUUID(),
              digest([input.targetSetId, source.title, source.body]),
            ],
          );
          materialId = m!.id;
          await q.query(
            "INSERT INTO study_import_items(user_id,target_set_id,fingerprint,source_key,source_index,material_id) VALUES($1,$2,$3,$4,$5,$6)",
            [
              user,
              input.targetSetId,
              fingerprint,
              source.sourceKey,
              source.sourceIndex,
              materialId,
            ],
          );
        }
        outcome.push({
          sourceKey: source.sourceKey,
          sourceIndex: source.sourceIndex,
          materialId,
          status: existing ? "already_imported" : "imported",
        });
      }
      await q.query(
        "INSERT INTO study_import_requests(user_id,client_request_id,digest,target_set_id,outcome) VALUES($1,$2,$3,$4,$5::jsonb)",
        [
          user,
          input.clientRequestId,
          hash,
          input.targetSetId,
          JSON.stringify(outcome),
        ],
      );
      return {
        targetSetId: input.targetSetId,
        items: outcome,
        replayed: false,
      };
    }, `studyc:organization:${user}`);
  }
}
