import { AuthApiError, type RequestOptions } from "../../auth/api.ts";
export const searchTypes = {
  all: "全部类型",
  study_set: "学习集",
  material: "资料",
  note: "笔记",
  deck: "闪卡组",
  quiz: "测验",
};
export type Kind = Exclude<keyof typeof searchTypes, "all">;
export type Hit = {
  id: string;
  type: Kind;
  studySetId: string;
  title: string;
  studySetTitle: string;
  excerpt: string;
  href: string;
};
export type Query = {
  q: string;
  type: keyof typeof searchTypes;
  studySetId?: string;
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const fail = (): never => {
  throw new AuthApiError("invalid_response", "搜索结果暂时无法读取，请重试。");
};
export function hitPath(hit: Pick<Hit, "type" | "id" | "studySetId">) {
  const root = "/platform/studyset/" + hit.studySetId;
  switch (hit.type) {
    case "study_set":
      return root;
    case "material":
      return root + "/material/" + hit.id;
    case "note":
      return root + "/notes?noteId=" + hit.id;
    case "deck":
      return root + "/flashcards?flashcardDeck=" + hit.id;
    case "quiz":
      return root + "/practice?quizId=" + hit.id;
  }
}
export function parseHit(v: any, query: Query): Hit {
  if (
    !v ||
    !uuid(v.id) ||
    !uuid(v.studySetId) ||
    !["study_set", "material", "note", "deck", "quiz"].includes(v.type) ||
    (query.type !== "all" && query.type !== v.type) ||
    (query.studySetId && query.studySetId !== v.studySetId) ||
    typeof v.title !== "string" ||
    typeof v.studySetTitle !== "string" ||
    typeof v.excerpt !== "string" ||
    v.excerpt.length > 480 ||
    (v.type === "study_set" && v.id !== v.studySetId) ||
    v.href !== hitPath(v)
  )
    fail();
  return v;
}
export function createSearchApi(
  request: <T>(path: string, options?: RequestOptions) => Promise<T>,
) {
  return {
    search: async (query: Query, cursor?: string) => {
      const params = new URLSearchParams({
        q: query.q.trim(),
        type: query.type,
        ...(query.studySetId ? { studySetId: query.studySetId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const v = await request<any>("/v1/study/search?" + params);
      if (
        !v ||
        v.query?.q !== query.q.trim() ||
        v.query.type !== query.type ||
        v.query.studySetId !== (query.studySetId ?? null) ||
        !Array.isArray(v.items) ||
        !(
          v.nextCursor === null ||
          (typeof v.nextCursor === "string" && v.nextCursor.length <= 2048)
        )
      )
        fail();
      return {
        items: v.items.map((hit: unknown) => parseHit(hit, query)) as Hit[],
        nextCursor: v.nextCursor as string | null,
      };
    },
  };
}
