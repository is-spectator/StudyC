import {requireVisibleSet} from './set-visibility.js';
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "../db/db.js";
import { requireActiveUser } from "./identity.js";
import {
  GenerationError,
  type NoteResult,
  type GenerationSnapshot,
} from "../generation/types.js";
import { validateLearningOutput } from "../generation/learning-output.js";
const uuid = z.uuid().transform((v) => v.toLowerCase());
const title = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v));
const body = z
  .string()
  .refine(
    (v) =>
      !!v.trim() &&
      Buffer.byteLength(v) <= 65536 &&
      !/[\u0000\uD800-\uDFFF]/u.test(v),
  );
export const noteSaveInput = z
  .object({ clientRequestId: uuid, jobId: uuid })
  .strict();
export const noteEditInput = z
  .object({ version: z.number().int().min(1).max(2147483646), title, body })
  .strict();
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const missing = () => new GenerationError("not_found", "没有找到这份笔记。");
export const noteMarkdown = (result: NoteResult) =>
  result.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n");
type Row = Record<string, any>;
async function scope(q: Queryable, user: string, set: string) { return requireVisibleSet(q,user,set); }
const present = (r: Row) => ({
  id: r.id,
  studySetId: r.study_set_id,
  title: r.title,
  body: r.body,
  version: r.version,
  manuallyEdited: r.manually_edited,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
export class NoteService {
  constructor(private db: Db) {}
  private async owned(q: Queryable, user: string, set: string, id: string) {
    const [r] = await q.query<Row>(
      "SELECT * FROM study_notes WHERE user_id=$1 AND study_set_id=$2 AND id=$3",
      [user, set, id],
    );
    if (!r) throw missing();
    return r;
  }
  private enabled() {
    if (process.env.STUDYC_NOTES_ENABLED === "false")
      throw new GenerationError(
        "service_unavailable",
        "笔记保存暂时关闭，已保存内容仍可查看。",
      );
  }
  async list(user: string, set: string, cursor?: string) {
    return this.db.tx(async (q) => {
      await scope(q, user, set);
      if (cursor) await this.owned(q, user, set, cursor);
      const rows = await q.query<Row>(
        `SELECT * FROM study_notes WHERE user_id=$1 AND study_set_id=$2 ${cursor ? "AND (created_at,id)<(SELECT created_at,id FROM study_notes WHERE id=$3 AND user_id=$1)" : ""} ORDER BY created_at DESC,id DESC LIMIT 21`,
        [user, set, ...(cursor ? [cursor] : [])],
      );
      return {
        enabled: process.env.STUDYC_NOTES_ENABLED !== "false",
        items: rows.slice(0, 20).map((r) => {
          const { body, ...summary } = present(r);
          return summary;
        }),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async get(user: string, set: string, id: string) {
    return this.db.tx(async (q) => {
      await scope(q, user, set);
      const n = await this.owned(q, user, set, id);
      const [origin] = await q.query<Row>(
        "SELECT job_id,result,sources FROM study_note_origins WHERE user_id=$1 AND study_set_id=$2 AND note_id=$3",
        [user, set, id],
      );
      if (!origin) throw missing();
      return {
        note: present(n),
        origin: {
          jobId: origin.job_id,
          result: origin.result as NoteResult,
          sourceSnapshots: origin.sources as GenerationSnapshot["sources"],
        },
      };
    });
  }
  async save(user: string, set: string, raw: unknown) {
    this.enabled();
    const input = noteSaveInput.parse(raw),
      hash = digest([set, input.jobId]);
    return this.db.tx(async (q) => {
      await scope(q, user, set);
      const [intent] = await q.query<Row>(
        "SELECT * FROM study_note_materializations WHERE user_id=$1 AND client_request_id=$2",
        [user, input.clientRequestId],
      );
      if (intent) {
        if (intent.digest !== hash)
          throw new GenerationError(
            "idempotency_conflict",
            "这个保存请求已用于其他笔记。",
          );
        return {
          note: present(await this.owned(q, user, set, intent.note_id)),
          replayed: true,
        };
      }
      const [job] = await q.query<Row>(
        "SELECT * FROM study_generation_jobs WHERE user_id=$1 AND study_set_id=$2 AND id=$3 FOR SHARE",
        [user, set, input.jobId],
      );
      if (!job) throw missing();
      if (
        job.kind !== "study_note" ||
        job.status !== "succeeded" ||
        !job.result
      )
        throw new GenerationError(
          "job_conflict",
          "只有生成成功的笔记候选可以保存。",
        );
      const [saved] = await q.query<Row>(
        "SELECT note_id FROM study_note_origins WHERE user_id=$1 AND study_set_id=$2 AND job_id=$3",
        [user, set, input.jobId],
      );
      let row: Row;
      if (saved) row = await this.owned(q, user, set, saved.note_id);
      else {
        const snapshot = job.input_snapshot as GenerationSnapshot,
          result = job.result as NoteResult;
        if (
          snapshot.promptVersion !== "study-note-v1" ||
          !Array.isArray(snapshot.sources) ||
          result.schemaVersion !== 1 ||
          !Array.isArray(result.sections)
        )
          throw new GenerationError("invalid_input", "生成候选不完整。");
        for (const source of snapshot.sources)
          if (
            typeof source.body !== "string" ||
            createHash("sha256").update(source.body).digest("hex") !==
              source.bodySha256
          )
            throw new GenerationError("invalid_input", "原资料快照校验失败。");
        let normalized: NoteResult;
        try {
          normalized = validateLearningOutput(
            JSON.stringify({
              title: result.title,
              sections: result.sections.map((s) => ({
                heading: s.heading,
                body: s.body,
                citations: s.citations.map((c) => ({
                  sourceId: c.sourceId,
                  quote: c.quote,
                })),
              })),
            }),
            snapshot,
          ) as NoteResult;
        } catch {
          throw new GenerationError(
            "invalid_input",
            "候选正文或引用校验失败。",
          );
        }
        const keys = [
          "sourceId",
          "materialId",
          "version",
          "quote",
          "start",
          "end",
          "page",
        ] as const;
        if (
          result.sections.some((s, i) =>
            s.citations.some((c, j) =>
              keys.some(
                (k) => c[k] !== normalized.sections[i]!.citations[j]![k],
              ),
            ),
          )
        )
          throw new GenerationError("invalid_input", "引用位置与原文不一致。");
        const markdown = body.parse(noteMarkdown(normalized));
        const [created] = await q.query<Row>(
          "INSERT INTO study_notes(user_id,study_set_id,title,body) VALUES($1,$2,$3,$4) RETURNING *",
          [user, set, title.parse(normalized.title), markdown],
        );
        row = created!;
        await q.query(
          "INSERT INTO study_note_origins(note_id,user_id,study_set_id,job_id,result,sources) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
          [
            row.id,
            user,
            set,
            job.id,
            JSON.stringify(normalized),
            JSON.stringify(snapshot.sources),
          ],
        );
      }
      await q.query(
        "INSERT INTO study_note_materializations(user_id,study_set_id,note_id,client_request_id,digest) VALUES($1,$2,$3,$4,$5)",
        [user, set, row.id, input.clientRequestId, hash],
      );
      return { note: present(row), replayed: !!saved };
    }, `studyc:notes:${user}`);
  }
  async edit(user: string, set: string, id: string, raw: unknown) {
    this.enabled();
    const input = noteEditInput.parse(raw);
    return this.db.tx(async (q) => {
      await scope(q, user, set);
      const old = await this.owned(q, user, set, id);
      if (old.version !== input.version)
        throw new GenerationError(
          "version_conflict",
          "笔记已在另一页面更新，你的输入仍保留，请比较后再保存。",
        );
      const [row] = await q.query<Row>(
        "UPDATE study_notes SET title=$4,body=$5,version=version+1,manually_edited=true,updated_at=clock_timestamp() WHERE user_id=$1 AND study_set_id=$2 AND id=$3 RETURNING *",
        [user, set, id, input.title, input.body],
      );
      return present(row!);
    }, `studyc:notes:${user}`);
  }
}
