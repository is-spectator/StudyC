import { z } from "zod";
import type { Db, Queryable } from "../db/db.js";
import { requireActiveUser } from "./identity.js";
import {
  uuid,
  digest,
  ownedSet,
  featureEnabled,
} from "./organization-common.js";
import { GenerationError } from "../generation/types.js";
export const searchKinds = [
  "study_set",
  "material",
  "note",
  "deck",
  "quiz",
] as const;
export const searchInput = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((v) => !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v)),
    type: z.enum(["all", ...searchKinds]).default("all"),
    studySetId: uuid.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
const cursorInput = z
  .object({
    v: z.literal(1),
    user: uuid,
    filter: z.string().regex(/^[a-f0-9]{64}$/),
    rank: z.number().int().min(0).max(4),
    id: uuid,
  })
  .strict();
type Row = {
  type_rank: number;
  type: (typeof searchKinds)[number];
  id: string;
  study_set_id: string;
  title: string;
  set_title: string;
  haystack: string;
  excerpt: string;
};
const invalidCursor = () =>
  new GenerationError("invalid_input", "搜索条件或结果已变化，请从头搜索。");
export function searchPath(kind: Row["type"], set: string, id: string) {
  const root = `/platform/studyset/${set}`;
  switch (kind) {
    case "study_set":
      return root;
    case "material":
      return root + "/material/" + id;
    case "note":
      return root + "/notes?noteId=" + id;
    case "deck":
      return root + "/flashcards?flashcardDeck=" + id;
    case "quiz":
      return root + "/practice?quizId=" + id;
  }
}
function branches(type: z.infer<typeof searchInput>["type"], equal = false) {
  return searchKinds
    .filter((k) => type === "all" || type === k)
    .map((kind) => {
      const rank = searchKinds.indexOf(kind),
        table = {
          study_set: "study_sets",
          material: "study_materials",
          note: "study_notes",
          deck: "study_flashcard_decks",
          quiz: "study_quizzes",
        }[kind];
      const relation =
        kind === "study_set"
          ? ""
          : `JOIN study_sets s ON s.id=o.study_set_id AND s.user_id=o.user_id`;
      const set = kind === "study_set" ? "o.id" : "o.study_set_id",
        setTitle = kind === "study_set" ? "o.title" : "s.title";
      const bound = equal
        ? `${rank}=$4::integer AND o.id=$5::uuid`
        : `(${rank},o.id)>($4::integer,$5::uuid)`;
      let extra = "",
        match = `strpos(lower(o.title),lower($2))>0`,
        text = "o.title";
      if (kind === "material" || kind === "note") {
        match += " OR strpos(lower(o.body),lower($2))>0";
        text =
          "CASE WHEN strpos(lower(o.title),lower($2))>0 THEN o.title ELSE o.body END";
      }
      if (kind === "deck") {
        extra = `LEFT JOIN LATERAL (SELECT c.id,c.front||E'\\n'||c.back AS text FROM study_flashcards c WHERE c.user_id=$1 AND c.study_set_id=o.study_set_id AND c.deck_id=o.id AND (strpos(lower(c.front),lower($2))>0 OR strpos(lower(c.back),lower($2))>0) ORDER BY c.position,c.id LIMIT 1) hit ON strpos(lower(o.title),lower($2))=0`;
        match += " OR hit.id IS NOT NULL";
        text =
          "CASE WHEN strpos(lower(o.title),lower($2))>0 THEN o.title ELSE hit.text END";
      }
      if (kind === "quiz") {
        extra = `LEFT JOIN LATERAL (SELECT question->>'prompt' AS text FROM jsonb_array_elements(o.questions) WITH ORDINALITY AS questions(question,n) WHERE strpos(lower(question->>'prompt'),lower($2))>0 ORDER BY n LIMIT 1) hit ON strpos(lower(o.title),lower($2))=0`;
        match += " OR hit.text IS NOT NULL";
        text =
          "CASE WHEN strpos(lower(o.title),lower($2))>0 THEN o.title ELSE hit.text END";
      }
      return `SELECT ${rank} AS type_rank,'${kind}'::text AS type,o.id,${set} AS study_set_id,o.title,${setTitle} AS set_title,${text} AS haystack FROM ${table} o ${relation} ${extra} WHERE o.user_id=$1 AND NOT EXISTS(SELECT 1 FROM study_set_lifecycle l WHERE l.user_id=o.user_id AND l.study_set_id=${set} AND l.deleted_at IS NOT NULL) AND ($3::uuid IS NULL OR ${set}=$3::uuid) AND (${bound}) AND (${match})`;
    })
    .join(" UNION ALL ");
}
export class SearchService {
  constructor(private db: Db) {}
  async search(user: string, raw: unknown) {
    featureEnabled("STUDYC_SEARCH_ENABLED");
    const input = searchInput.parse(raw),
      filter = digest([user, input.q, input.type, input.studySetId ?? null]);
    let cursor: z.infer<typeof cursorInput> | undefined;
    if (input.cursor) {
      try {
        const bytes = Buffer.from(input.cursor, "base64url");
        if (bytes.toString("base64url") !== input.cursor) throw invalidCursor();
        cursor = cursorInput.parse(JSON.parse(bytes.toString("utf8")));
        if (cursor.user !== user || cursor.filter !== filter)
          throw invalidCursor();
      } catch {
        throw invalidCursor();
      }
    }
    try {
      return await this.db.tx(async (q) => {
        await requireActiveUser(q, user);
        if (input.studySetId) await ownedSet(q, user, input.studySetId);
        await q.exec("SET LOCAL statement_timeout='3s'");
        const params = [
          user,
          input.q,
          input.studySetId ?? null,
          cursor?.rank ?? -1,
          cursor?.id ?? "00000000-0000-0000-0000-000000000000",
        ];
        if (cursor) {
          const exists = await q.query(
            `WITH hits AS (${branches(input.type, true)}) SELECT id FROM hits LIMIT 1`,
            params,
          );
          if (!exists.length) throw invalidCursor();
        }
        const rows = await q.query<Row>(
          `WITH hits AS (${branches(input.type)}) SELECT type_rank,type,id,study_set_id,title,set_title,substring(haystack FROM greatest(1,strpos(lower(haystack),lower($2))-60) FOR 240) AS excerpt FROM hits ORDER BY type_rank,id LIMIT $6`,
          [...params, input.limit + 1],
        );
        const visible = rows.slice(0, input.limit),
          last = visible.at(-1);
        return {
          query: {
            q: input.q,
            type: input.type,
            studySetId: input.studySetId ?? null,
          },
          items: visible.map((r) => ({
            type: r.type,
            id: r.id,
            studySetId: r.study_set_id,
            title: r.title,
            studySetTitle: r.set_title,
            excerpt: r.excerpt,
            href: searchPath(r.type, r.study_set_id, r.id),
          })),
          nextCursor:
            rows.length > input.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    v: 1,
                    user,
                    filter,
                    rank: last.type_rank,
                    id: last.id,
                  }),
                ).toString("base64url")
              : null,
        };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "57014")
        throw new GenerationError(
          "service_unavailable",
          "搜索时间较长，请缩小关键词或学习集范围后再试。",
        );
      throw e;
    }
  }
}
