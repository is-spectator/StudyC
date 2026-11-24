import {
  AuthApiError,
  throwIfAborted,
  type RequestOptions,
} from "../../auth/api.ts";
import type { StudySet, StudyPage } from "../api.ts";
export type LibrarySort = "recent" | "created" | "title";
export type LibrarySummary = {
  materialCount: number;
  deckCount: number;
  quizCount: number;
  noteCount: number;
  dueCardCount: number;
  pendingTaskCount: number;
  lastStudiedAt: string | null;
  continue: { label: string; href: string } | null;
};
export interface LibrarySet extends StudySet {
  summary: LibrarySummary;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (): never => {
  throw new AuthApiError(
    "invalid_response",
    "学习集摘要暂时无法读取，请重试。",
    502,
  );
};
const stamp = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const keys = [
  "materialCount",
  "deckCount",
  "quizCount",
  "noteCount",
  "dueCardCount",
  "pendingTaskCount",
] as const;
export function parseLibrarySet(v: any): LibrarySet {
  if (
    !v ||
    typeof v.id !== "string" ||
    !uuid.test(v.id) ||
    typeof v.title !== "string" ||
    !v.title.trim() ||
    v.title !== v.title.trim() ||
    Array.from(v.title).length > 60 ||
    /[\u0000\uD800-\uDFFF]/u.test(v.title) ||
    !Number.isInteger(v.version) ||
    v.version < 1 ||
    v.version > 2147483647 ||
    !stamp(v.createdAt) ||
    !stamp(v.updatedAt) ||
    !v.summary
  )
    fail();
  const summary = v.summary as LibrarySummary;
  if (
    keys.some((k) => !Number.isSafeInteger(summary[k]) || summary[k] < 0) ||
    !(summary.lastStudiedAt === null || stamp(summary.lastStudiedAt))
  )
    fail();
  if (summary.continue !== null) {
    const next = summary.continue;
    if (
      !next ||
      typeof next.label !== "string" ||
      !next.label ||
      typeof next.href !== "string"
    )
      fail();
    const root = "/platform/studyset/" + v.id;
    let url: URL;
    try {
      url = new URL(next.href, "https://studyc.invalid");
    } catch {
      fail();
    }
    if (
      !next.href.startsWith(root + "/") ||
      url!.origin !== "https://studyc.invalid" ||
      url!.hash ||
      (url!.pathname !== root + "/flashcards" &&
        url!.pathname !== root + "/practice" &&
        url!.pathname !== root + "/study-plan")
    )
      fail();
    const p = url!.searchParams,
      allowed = url!.pathname.endsWith("/flashcards")
        ? ["flashcardDeck", "flashcardSession", "spacedReviewSession"]
        : url!.pathname.endsWith("/practice")
          ? ["quizId", "attemptId"]
          : ["planId"];
    if (
      [...p.keys()].some(
        (k) =>
          !allowed.includes(k) ||
          p.getAll(k).length !== 1 ||
          !uuid.test(p.get(k)!),
      ) ||
      !p.get(allowed[0]) ||
      (p.has("flashcardSession") && p.has("spacedReviewSession"))
    )
      fail();
  }
  return {
    id: v.id.toLowerCase(),
    title: v.title,
    version: v.version,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    summary: {
      materialCount: summary.materialCount,
      deckCount: summary.deckCount,
      quizCount: summary.quizCount,
      noteCount: summary.noteCount,
      dueCardCount: summary.dueCardCount,
      pendingTaskCount: summary.pendingTaskCount,
      lastStudiedAt: summary.lastStudiedAt,
      continue: summary.continue
        ? { label: summary.continue.label, href: summary.continue.href }
        : null,
    },
  };
}
export function createLibraryApi(
  request: <T>(path: string, options?: RequestOptions) => Promise<T>,
) {
  const send = async (path: string, signal?: AbortSignal) => {
    throwIfAborted(signal);
    const r = await request<any>(path, { signal });
    throwIfAborted(signal);
    return r;
  };
  return {
    async list(
      input: {
        q?: string;
        sort?: LibrarySort;
        cursor?: string;
        limit?: number;
      } = {},
      signal?: AbortSignal,
    ): Promise<StudyPage<LibrarySet>> {
      const p = new URLSearchParams({ view: "library" });
      if (input.q) p.set("q", input.q);
      if (input.sort) p.set("sort", input.sort);
      if (input.cursor) p.set("cursor", input.cursor);
      if (input.limit) p.set("limit", String(input.limit));
      const r = await send("/v1/study/sets?" + p, signal);
      if (
        !r ||
        !Array.isArray(r.items) ||
        r.items.length > 50 ||
        !(
          r.nextCursor === null ||
          (typeof r.nextCursor === "string" &&
            /^[A-Za-z0-9_-]{1,2048}$/.test(r.nextCursor))
        )
      )
        fail();
      if (!r.items.length && r.nextCursor !== null) fail();
      const items = r.items.map(parseLibrarySet);
      if (new Set(items.map((i: LibrarySet) => i.id)).size !== items.length)
        fail();
      return { items, nextCursor: r.nextCursor };
    },
    async get(setId: string, signal?: AbortSignal): Promise<LibrarySet> {
      if (!uuid.test(setId))
        throw new AuthApiError("invalid_request", "学习集地址无效。", 400);
      const r = await send(
          "/v1/study/sets/" + setId.toLowerCase() + "?view=library",
          signal,
        ),
        item = parseLibrarySet(r?.studySet);
      if (item.id !== setId.toLowerCase()) fail();
      return item;
    },
  };
}
