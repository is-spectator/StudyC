import { z } from "zod";
import type { Db, Queryable } from "../db/db.js";
import { requireActiveUser } from "./identity.js";
import { requireVisibleSet } from "./set-visibility.js";
import { digest, uuid, featureEnabled } from "./organization-common.js";
import { GenerationError } from "../generation/types.js";
import type { StudySet } from "./study-data.js";

export const librarySort = z.enum(["recent", "created", "title"]);
const queryText = z
  .string()
  .trim()
  .max(120)
  .refine((v) => !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v));
const options = z
  .object({
    q: queryText.default(""),
    sort: librarySort.default("recent"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
export const libraryQuery = z
  .object({
    view: z.literal("library"),
    q: queryText.optional(),
    sort: librarySort.optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d?$/)
      .transform(Number)
      .pipe(z.number().max(50))
      .optional(),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
export interface LibrarySummary {
  materialCount: number;
  deckCount: number;
  quizCount: number;
  noteCount: number;
  dueCardCount: number;
  pendingTaskCount: number;
  lastStudiedAt: string | null;
  continue: { label: string; href: string } | null;
}
export interface LibrarySet extends StudySet {
  summary: LibrarySummary;
}
type Row = Record<string, any>;
const iso = (v: Date | string) => new Date(v).toISOString();
const failQuery = (error: unknown): never => {
  if ((error as { code?: string }).code === "57014")
    throw new GenerationError(
      "service_unavailable",
      "学习集列表读取超时，请缩小搜索范围后重试。",
    );
  throw error;
};
const invalidCursor = () =>
  new GenerationError(
    "invalid_input",
    "搜索条件或学习记录已变化，请重新读取列表。",
  );
const cursorSchema = z
  .object({
    v: z.literal(1),
    user: uuid,
    filter: z.string().regex(/^[a-f0-9]{64}$/),
    key: z.string().max(240),
    id: uuid,
  })
  .strict();

// Recent study means a real review or submitted attempt, never a generated object
// or simply opening a set. Aggregations remain owner-scoped and do not include answers.
const base = `WITH activity AS (
 SELECT study_set_id,max(studied_at) AS last_studied_at FROM (
  SELECT study_set_id,max(created_at) AS studied_at FROM study_flashcard_reviews WHERE user_id=$1 GROUP BY study_set_id
  UNION ALL SELECT c.study_set_id,max(sc.reviewed_at) FROM study_flashcard_schedules sc JOIN study_flashcards c ON c.id=sc.card_id AND c.user_id=sc.user_id WHERE sc.user_id=$1 GROUP BY c.study_set_id
  UNION ALL SELECT q.study_set_id,max(a.submitted_at) FROM study_quiz_attempts a JOIN study_quizzes q ON q.id=a.quiz_id AND q.user_id=a.user_id WHERE a.user_id=$1 AND a.status='submitted' GROUP BY q.study_set_id
 ) actual GROUP BY study_set_id
), visible AS (
 SELECT s.*,a.last_studied_at FROM study_sets s LEFT JOIN activity a ON a.study_set_id=s.id
 WHERE s.user_id=$1 AND strpos(lower(s.title),lower($2))>0 AND ($3::uuid IS NULL OR s.id=$3)
 AND NOT EXISTS(SELECT 1 FROM study_set_lifecycle l WHERE l.user_id=s.user_id AND l.study_set_id=s.id AND l.deleted_at IS NOT NULL)
)`;
const pending = `t.user_id=s.user_id AND t.study_set_id=s.id AND t.cancelled_at IS NULL AND t.manual_completed_at IS NULL AND NOT EXISTS(SELECT 1 FROM study_plan_evidence e WHERE e.user_id=t.user_id AND e.task_id=t.id)`;
const counts = `
 (SELECT count(*)::integer FROM study_materials m WHERE m.user_id=s.user_id AND m.study_set_id=s.id) AS material_count,
 (SELECT count(*)::integer FROM study_flashcard_decks d WHERE d.user_id=s.user_id AND d.study_set_id=s.id) AS deck_count,
 (SELECT count(*)::integer FROM study_quizzes q WHERE q.user_id=s.user_id AND q.study_set_id=s.id) AS quiz_count,
 (SELECT count(*)::integer FROM study_notes n WHERE n.user_id=s.user_id AND n.study_set_id=s.id) AS note_count,
 (SELECT count(*)::integer FROM study_flashcards c JOIN study_flashcard_schedules sc ON sc.card_id=c.id AND sc.user_id=c.user_id WHERE c.user_id=s.user_id AND c.study_set_id=s.id AND c.version=sc.card_version AND sc.due_at<=clock_timestamp()) AS due_card_count,
 (SELECT count(*)::integer FROM study_plan_tasks t WHERE ${pending}) AS pending_task_count`;
const resume = (srsEnabled: boolean) => `LEFT JOIN LATERAL (
 SELECT label,href FROM (
  SELECT '继续闪卡学习' AS label,'/platform/studyset/'||s.id||'/flashcards?flashcardDeck='||r.deck_id||'&flashcardSession='||r.id AS href,r.updated_at AS touched,0 AS priority FROM study_flashcard_sessions r WHERE r.user_id=s.user_id AND r.study_set_id=s.id AND r.status='in_progress'
  UNION ALL SELECT '继续间隔复习','/platform/studyset/'||s.id||'/flashcards?flashcardDeck='||r.deck_id||'&spacedReviewSession='||r.id,COALESCE(NULLIF(r.data->>'updatedAt','')::timestamptz,(SELECT (a.outcome->>'occurredAt')::timestamptz FROM study_spaced_review_actions a WHERE a.user_id=r.user_id AND a.session_id=r.id ORDER BY a.position DESC LIMIT 1),r.created_at),0 FROM study_spaced_review_sessions r WHERE r.user_id=s.user_id AND r.study_set_id=s.id AND r.data->>'status'='in_progress' AND ${srsEnabled ? "true" : "false"}
  UNION ALL SELECT CASE WHEN a.mode='exam' THEN '继续考试' ELSE '继续练习' END,'/platform/studyset/'||s.id||'/practice?quizId='||q.id||'&attemptId='||a.id,a.updated_at,0 FROM study_quiz_attempts a JOIN study_quizzes q ON q.id=a.quiz_id AND q.user_id=a.user_id WHERE a.user_id=s.user_id AND q.study_set_id=s.id AND a.status='in_progress'
  UNION ALL SELECT '复习到期闪卡','/platform/studyset/'||s.id||'/flashcards?flashcardDeck='||c.deck_id,sc.reviewed_at,1 FROM study_flashcards c JOIN study_flashcard_schedules sc ON sc.card_id=c.id AND sc.user_id=c.user_id WHERE c.user_id=s.user_id AND c.study_set_id=s.id AND c.version=sc.card_version AND sc.due_at<=clock_timestamp() AND ${srsEnabled ? "true" : "false"}
  UNION ALL SELECT '查看学习任务','/platform/studyset/'||s.id||'/study-plan?planId='||t.plan_id,t.updated_at,2 FROM study_plan_tasks t WHERE ${pending}
 ) candidates ORDER BY priority,touched DESC,href LIMIT 1
) next ON true`;
function present(r: Row): LibrarySet {
  return {
    id: r.id,
    title: r.title,
    version: r.version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    summary: {
      materialCount: r.material_count,
      deckCount: r.deck_count,
      quizCount: r.quiz_count,
      noteCount: r.note_count,
      dueCardCount: r.due_card_count,
      pendingTaskCount: r.pending_task_count,
      lastStudiedAt: r.last_studied_at ? iso(r.last_studied_at) : null,
      continue: r.resume_href
        ? { label: r.resume_label, href: r.resume_href }
        : null,
    },
  };
}
export class LibraryService {
  constructor(private readonly db: Db) {}
  private async timeout(q: Queryable) {
    await q.query("SET LOCAL statement_timeout='3s'");
  }
  async list(user: string, raw: unknown) {
    const input = options.parse(raw),
      filter = digest([user, input.q, input.sort]);
    if (input.q) featureEnabled("STUDYC_SEARCH_ENABLED");
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (input.cursor) {
      try {
        const bytes = Buffer.from(input.cursor, "base64url");
        if (bytes.toString("base64url") !== input.cursor) throw invalidCursor();
        cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
        if (cursor.user !== user || cursor.filter !== filter)
          throw invalidCursor();
        if (
          input.sort !== "title" &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.key) ||
            cursor.key.startsWith("0000") ||
            !Number.isFinite(Date.parse(cursor.key)) ||
            new Date(cursor.key).toISOString() !==
              cursor.key.slice(0, 23) + "Z")
        )
          throw invalidCursor();
      } catch {
        throw invalidCursor();
      }
    }
    const value =
        input.sort === "title"
          ? "lower(s.title)"
          : input.sort === "created"
            ? "s.created_at"
            : "COALESCE(s.last_studied_at,s.updated_at)",
      direction = input.sort === "title" ? "ASC" : "DESC",
      operator = input.sort === "title" ? ">" : "<",
      cast = input.sort === "title" ? "text" : "timestamptz";
    const key =
      input.sort === "title"
        ? value
        : `to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    return this.db
      .tx(async (q) => {
        await requireActiveUser(q, user);
        await this.timeout(q);
        if (cursor) {
          const exists = await q.query(
            `${base} SELECT s.id FROM visible s WHERE s.id=$4 AND ${value}=$5::${cast}`,
            [user, input.q, null, cursor.id, cursor.key],
          );
          if (!exists.length) throw invalidCursor();
        }
        const rows = await q.query<Row>(
          `${base}, page AS (SELECT s.*,${key} AS cursor_key FROM visible s WHERE ($4::text IS NULL OR (${value},s.id)${operator}($4::${cast},$5::uuid)) ORDER BY ${value} ${direction},s.id ${direction} LIMIT $6)
    SELECT s.*,${counts},next.label AS resume_label,next.href AS resume_href FROM page s ${resume(process.env.STUDYC_SRS_ENABLED !== "false")} ORDER BY ${value} ${direction},s.id ${direction}`,
          [
            user,
            input.q,
            null,
            cursor?.key ?? null,
            cursor?.id ?? null,
            input.limit + 1,
          ],
        );
        const last = rows[input.limit - 1];
        return {
          items: rows.slice(0, input.limit).map(present),
          nextCursor:
            rows.length > input.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    v: 1,
                    user,
                    filter,
                    key: last.cursor_key,
                    id: last.id,
                  }),
                ).toString("base64url")
              : null,
        };
      })
      .catch(failQuery);
  }
  async get(user: string, set: string) {
    return this.db
      .tx(async (q) => {
        await requireVisibleSet(q, user, set);
        await this.timeout(q);
        const [r] = await q.query<Row>(
          `${base} SELECT s.*,${counts},next.label AS resume_label,next.href AS resume_href FROM visible s ${resume(process.env.STUDYC_SRS_ENABLED !== "false")}`,
          [user, "", set],
        );
        if (!r) throw new GenerationError("not_found", "没有找到这个学习集。");
        return present(r);
      })
      .catch(failQuery);
  }
}
