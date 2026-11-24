import { randomUUID as id } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { Db } from "../src/db/db.js";
import { openTestDb } from "./database.js";
import {
  createStudySet,
  createTextMaterial,
} from "../src/services/study-data.js";
import { SearchService, searchPath } from "../src/services/search.js";
import { FlashcardService } from "../src/services/flashcards.js";
import { NoteService } from "../src/services/notes.js";
import { GenerationStore } from "../src/generation/store.js";
import { validateLearningOutput } from "../src/generation/learning-output.js";
import {
  DEFAULT_GENERATION_POLICY,
  UNKNOWN_USAGE,
  type GenerationKind,
  type GenerationConfig,
} from "../src/generation/types.js";
import { materializeQuiz, startQuizAttempt } from "../src/services/quizzes.js";
import { createApp } from "../src/api/app.js";
describe("literal owner-scoped saved-content search without private answer surfaces", () => {
  let db: Db,
    s: SearchService,
    user: string,
    bob: string,
    set: string,
    other: string,
    material: string,
    note: string,
    deck: string,
    quiz: string;
  const quote = "这份共同关键词资料介绍水循环，水蒸气凝结后形成云中的小水滴。";
  beforeEach(async () => {
    db = await openTestDb();
    s = new SearchService(db);
    const users = await db.query<{ id: string }>(
      "INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id",
    );
    user = users[0]!.id;
    bob = users[1]!.id;
    set = (
      await createStudySet(db, user, {
        clientRequestId: id(),
        title: "理科学习集",
      })
    ).studySet.id;
    other = (
      await createStudySet(db, user, {
        clientRequestId: id(),
        title: "项目学习集",
      })
    ).studySet.id;
    material = (
      await createTextMaterial(db, user, set, {
        clientRequestId: id(),
        title: "共同关键词资料",
        body: quote,
      })
    ).material.id;
    const f = new FlashcardService(db);
    deck = (
      await f.create(user, set, { clientRequestId: id(), title: "普通卡组" })
    ).deck.id;
    await f.addCard(user, set, deck, {
      clientRequestId: id(),
      front: "共同关键词正面",
      back: "共同关键词背面 BACK_ONLY_TOKEN",
    });
    await f.addCard(user, set, deck, {
      clientRequestId: id(),
      front: "第二张共同关键词",
      back: "另一解释",
    });
    const j = await generated(
      "study_note",
      { language: "zh-CN", sectionCount: 1 },
      {
        title: "HISTORY_ONLY_TOKEN",
        sections: [
          {
            heading: "原始章节",
            body: "HISTORY_ONLY_TOKEN",
            citations: [{ sourceId: "s1", quote }],
          },
        ],
      },
    );
    note = (
      await new NoteService(db).save(user, set, {
        clientRequestId: id(),
        jobId: j,
      })
    ).note.id;
    await new NoteService(db).edit(user, set, note, {
      version: 1,
      title: "共同关键词笔记",
      body: "当前编辑的 CURRENT_ONLY_TOKEN 共同关键词",
    });
    const q = await generated(
      "quiz",
      { language: "zh-CN", singleChoiceCount: 1, trueFalseCount: 0 },
      {
        title: "普通测验",
        questions: [
          {
            type: "single_choice",
            prompt: "共同关键词 QUIZ_STEM_TOKEN 表示什么？",
            options: [
              "ANSWER_ONLY_TOKEN",
              "另一个选项",
              "其他选项",
              "都不正确",
            ],
            answerIndex: 0,
            explanation: "EXPLANATION_ONLY_TOKEN",
            citations: [{ sourceId: "s1", quote }],
          },
        ],
      },
    );
    quiz = (
      await materializeQuiz(
        db,
        new GenerationStore(db, DEFAULT_GENERATION_POLICY, config),
        user,
        set,
        { clientRequestId: id(), generationId: q },
      )
    ).quiz.id;
    await startQuizAttempt(db, user, set, quiz, {
      clientRequestId: id(),
      mode: "exam",
    });
  }, 30000);
  afterEach(async () => {
    await db?.close();
  });
  const config = {
    provider: "openrouter" as const,
    baseUrl: "https://openrouter.ai/api/v1" as const,
    model: "fixture/model",
    outputMode: "strict" as const,
    maxOutputTokens: 2048,
    timeoutMs: 1000,
    providerOnly: [],
  };
  async function generated(
    kind: GenerationKind,
    configInput: GenerationConfig,
    wire: unknown,
  ) {
    const store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config),
      { job } = await store.create(user, set, {
        clientRequestId: id(),
        kind,
        sources: [{ materialId: material, version: 1 }],
        config: configInput,
      }),
      claim = (await store.claim())!,
      result = validateLearningOutput(JSON.stringify(wire), claim.snapshot);
    await store.settle(claim, {
      status: "succeeded",
      errorCode: null,
      result,
      usage: UNKNOWN_USAGE,
    });
    return job.id;
  }
  it("finds Chinese terms in current material/note/card/stem and returns one entry per object with exact routes", async () => {
    const result = await s.search(user, { q: "共同关键词" });
    expect(result.items.map((r) => r.type).sort()).toEqual([
      "deck",
      "material",
      "note",
      "quiz",
    ]);
    expect(new Set(result.items.map((r) => r.type + ":" + r.id)).size).toBe(4);
    for (const hit of result.items) {
      expect(hit.studySetId).toBe(set);
      expect(hit.studySetTitle).toBe("理科学习集");
      expect(hit.href).toBe(searchPath(hit.type, hit.studySetId, hit.id));
      expect(hit.excerpt).toContain("共同关键词");
    }
    expect(result.items.find((h) => h.type === "deck")!.id).toBe(deck);
  });
  it("matches card backs and quiz stems but never answers, explanation, attempt snapshots or old generated note drafts", async () => {
    expect(
      (await s.search(user, { q: "BACK_ONLY_TOKEN", type: "deck" })).items,
    ).toMatchObject([{ id: deck }]);
    expect(
      (await s.search(user, { q: "QUIZ_STEM_TOKEN", type: "quiz" })).items,
    ).toMatchObject([{ id: quiz }]);
    for (const q of [
      "ANSWER_ONLY_TOKEN",
      "EXPLANATION_ONLY_TOKEN",
      "HISTORY_ONLY_TOKEN",
    ])
      expect((await s.search(user, { q })).items).toEqual([]);
    expect(
      (await s.search(user, { q: "CURRENT_ONLY_TOKEN", type: "note" })).items,
    ).toMatchObject([{ id: note }]);
    const serialized = JSON.stringify(
      await s.search(user, { q: "共同关键词", type: "quiz" }),
    );
    expect(serialized).not.toContain("ANSWER_ONLY_TOKEN");
    expect(serialized).not.toContain("EXPLANATION_ONLY_TOKEN");
    expect(serialized).not.toContain("answerIndex");
  });
  it("does not search unmaterialized generation results or raw source history", async () => {
    await generated(
      "study_note",
      { language: "zh-CN", sectionCount: 1 },
      {
        title: "DRAFT_ONLY_TOKEN",
        sections: [
          {
            heading: "章节",
            body: "DRAFT_ONLY_TOKEN",
            citations: [{ sourceId: "s1", quote }],
          },
        ],
      },
    );
    expect((await s.search(user, { q: "DRAFT_ONLY_TOKEN" })).items).toEqual([]);
  });
  it("keeps same-named objects in distinct sets and applies type/set filters before pagination", async () => {
    const b = (
      await createTextMaterial(db, user, other, {
        clientRequestId: id(),
        title: "共同关键词资料",
        body: "共同关键词项目内容",
      })
    ).material;
    const all = await s.search(user, { q: "共同关键词", type: "material" });
    expect(all.items.map((r) => r.studySetTitle).sort()).toEqual(
      ["理科学习集", "项目学习集"].sort(),
    );
    const filtered = await s.search(user, {
      q: "共同关键词",
      type: "material",
      studySetId: other,
    });
    expect(filtered.items).toMatchObject([{ id: b.id, studySetId: other }]);
    expect(
      (await s.search(user, { q: "理科学习集", type: "study_set" })).items,
    ).toMatchObject([{ id: set }]);
  });
  it("isolates results and filter/cursor scope by account, even for known IDs", async () => {
    expect((await s.search(bob, { q: "共同关键词" })).items).toEqual([]);
    await expect(
      s.search(bob, { q: "共同关键词", studySetId: set }),
    ).rejects.toMatchObject({ code: "not_found" });
    const first = await s.search(user, { q: "共同关键词", limit: 1 });
    await expect(
      s.search(bob, { q: "共同关键词", limit: 1, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      s.search(user, { q: "当前", limit: 1, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      s.search(user, {
        q: "共同关键词",
        type: "material",
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("paginates a stable type/UUID ordering without repeated card/question matches or OFFSET", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await s.search(user, { q: "共同关键词", limit: 1, cursor });
      seen.push(...page.items.map((h) => h.type + ":" + h.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });
  it("treats percent, underscore, slashes and SQL-looking text literally and folds ordinary Latin case", async () => {
    const a = (
      await createTextMaterial(db, user, set, {
        clientRequestId: id(),
        title: "百分比%_\\'",
        body: "CaseSensitiveLatin",
      })
    ).material;
    expect((await s.search(user, { q: "%_\\" })).items).toMatchObject([
      { id: a.id },
    ]);
    expect((await s.search(user, { q: "' OR 1=1 --" })).items).toEqual([]);
    expect(
      (await s.search(user, { q: "casesensitivelatin" })).items,
    ).toMatchObject([{ id: a.id }]);
  });
  it("returns bounded snippets around distant matches rather than complete private bodies", async () => {
    await createTextMaterial(db, user, set, {
      clientRequestId: id(),
      title: "长文",
      body: "前".repeat(8000) + "远处关键词" + "后".repeat(8000),
    });
    const r = await s.search(user, { q: "远处关键词", type: "material" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.excerpt).toContain("远处关键词");
    expect(Array.from(r.items[0]!.excerpt).length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(r)).not.toContain("前".repeat(1000));
  });
  it("rejects empty/oversized/control queries and malformed cursors and excludes deleted materials", async () => {
    for (const q of [" ", "x".repeat(121), "a\u0000b"])
      await expect(s.search(user, { q })).rejects.toThrow();
    await expect(
      s.search(user, { q: "共同关键词", cursor: "not-a-cursor" }),
    ).rejects.toThrow();
    await db.query("DELETE FROM study_materials WHERE id=$1 AND user_id=$2", [
      material,
      user,
    ]);
    expect(
      (await s.search(user, { q: "共同关键词", type: "material" })).items,
    ).toEqual([]);
  });
  it("does not read deleted identities and closes search without mutating saved content", async () => {
    await db.query("UPDATE users SET deleted_at=now() WHERE id=$1", [bob]);
    await expect(s.search(bob, { q: "共同关键词" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    const previous = process.env.STUDYC_SEARCH_ENABLED;
    process.env.STUDYC_SEARCH_ENABLED = "false";
    try {
      await expect(s.search(user, { q: "共同关键词" })).rejects.toMatchObject({
        code: "service_unavailable",
      });
    } finally {
      if (previous === undefined) delete process.env.STUDYC_SEARCH_ENABLED;
      else process.env.STUDYC_SEARCH_ENABLED = previous;
    }
    expect((await s.search(user, { q: "共同关键词" })).items).toHaveLength(4);
  });
  it("reports a database statement timeout as a retryable search limit", async () => {
    const timedOut = new SearchService({
      tx: async () => {
        throw Object.assign(new Error("statement canceled"), { code: "57014" });
      },
    } as unknown as Db);
    await expect(timedOut.search(user, { q: "内容" })).rejects.toMatchObject({
      code: "service_unavailable",
    });
  });
  it("enforces HTTP identity, read-only methods, duplicate query rejection and private no-store", async () => {
    const app = createApp(db, {
        releaseId: "search-http",
        rateLimitSecret: new Uint8Array(32).fill(8),
        sessionFetch: async () =>
          Response.json({ userId: user, csrfToken: "a".repeat(43) }),
      }),
      headers = {
        cookie: "__Host-planplan-session=test",
        "X-PlanPlan-Expected-User": user,
        "X-CSRF-Token": "a".repeat(43),
        origin: "https://study.clyna.ai",
        "content-type": "application/json",
      };
    expect((await app.request("/v1/study/search?q=内容")).status).toBe(401);
    expect(
      (
        await app.request("/v1/study/search?q=内容", {
          headers,
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(405);
    expect(
      (await app.request("/v1/study/search?q=x&q=y", { headers })).status,
    ).toBe(400);
    const r = await app.request("/v1/study/search?q=共同关键词", { headers });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
});
