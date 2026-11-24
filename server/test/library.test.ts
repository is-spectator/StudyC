import { randomUUID as id } from "node:crypto";
import { beforeEach, afterEach, it, expect } from "vitest";
import type { Db } from "../src/db/db.js";
import { openTestDb } from "./database.js";
import { LibraryService } from "../src/services/library.js";
import {
  createStudySet,
  createTextMaterial,
} from "../src/services/study-data.js";
import { TrashService } from "../src/services/trash.js";
import { FlashcardService } from "../src/services/flashcards.js";
import { SpacedReviewService } from "../src/services/spaced-review.js";
import { PlanService } from "../src/services/plans.js";
let db: Db, user: string, bob: string, s: LibraryService, set: string;
beforeEach(async () => {
  db = await openTestDb();
  const users = await db.query<{ id: string }>(
    "INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id",
  );
  user = users[0]!.id;
  bob = users[1]!.id;
  s = new LibraryService(db);
  set = (
    await createStudySet(db, user, {
      clientRequestId: id(),
      title: "真实学习集",
    })
  ).studySet.id;
}, 30000);
afterEach(async () => {
  await db.close();
});
const create = (title: string, owner = user) =>
  createStudySet(db, owner, { clientRequestId: id(), title });
it("searches all matching owned titles beyond the first page with literal percent matching", async () => {
  await db.query(
    "INSERT INTO study_sets(user_id,title,client_request_id,creation_digest) SELECT $1,'普通学习集'||i,gen_random_uuid(),repeat('a',64) FROM generate_series(1,55)i",
    [user],
  );
  await create("中文搜索 100%_准确");
  await create("中文搜索 100其他");
  await create("中文搜索 100%_准确", bob);
  expect(
    (await s.list(user, { q: "100%_", limit: 20 })).items.map((i) => i.title),
  ).toEqual(["中文搜索 100%_准确"]);
  expect((await s.list(user, { q: "中文搜索" })).items).toHaveLength(2);
});
it("binds keyset cursors to owner, title filter and ordering, returns each item once", async () => {
  for (const title of ["A-one", "A-two", "A-three", "A-four"])
    await create(title);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await s.list(user, {
      q: "A-",
      sort: "title",
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.items.map((i) => i.title));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(["A-four", "A-one", "A-three", "A-two"]);
  const first = await s.list(user, { q: "A-", sort: "title", limit: 2 });
  for (const raw of [
    { q: "A-", sort: "recent" },
    { q: "A", sort: "title" },
  ])
    await expect(
      s.list(user, { ...raw, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    s.list(bob, { q: "A-", sort: "title", cursor: first.nextCursor }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});
it("returns truthful zero states and hides trashed data in list, detail and cursor reuse", async () => {
  const item = await s.get(user, set);
  expect(item.summary).toEqual({
    materialCount: 0,
    deckCount: 0,
    quizCount: 0,
    noteCount: 0,
    dueCardCount: 0,
    pendingTaskCount: 0,
    lastStudiedAt: null,
    continue: null,
  });
  await expect(s.get(bob, set)).rejects.toMatchObject({ code: "not_found" });
  await new TrashService(db).change(user, set, {
    clientRequestId: id(),
    version: 0,
    deleted: true,
  });
  expect((await s.list(user, {})).items).toEqual([]);
  await expect(s.get(user, set)).rejects.toMatchObject({ code: "not_found" });
});
it("counts saved text, current-version due cards and pending tasks without treating creation as study", async () => {
  const f = new FlashcardService(db),
    p = new PlanService(db);
  await createTextMaterial(db, user, set, {
    clientRequestId: id(),
    title: "资料",
    body: "来自资料",
  });
  const deck = (
    await f.create(user, set, { clientRequestId: id(), title: "闪卡" })
  ).deck;
  const card = (
    await f.addCard(user, set, deck.id, {
      clientRequestId: id(),
      front: "问",
      back: "答",
    })
  ).card;
  const plan = (
    await p.create(user, set, { clientRequestId: id(), title: "目标" })
  ).plan;
  const pending = (
    await p.createTask(user, set, plan.id, {
      clientRequestId: id(),
      title: "待学",
    })
  ).task;
  const complete = (
    await p.createTask(user, set, plan.id, {
      clientRequestId: id(),
      title: "已标记",
    })
  ).task;
  const cancelled = (
    await p.createTask(user, set, plan.id, {
      clientRequestId: id(),
      title: "已取消",
    })
  ).task;
  await db.query(
    "UPDATE study_plan_tasks SET manual_completed_at=clock_timestamp(),manual_completed_by=$2 WHERE id=$1",
    [complete.id, user],
  );
  await db.query(
    "UPDATE study_plan_tasks SET cancelled_at=clock_timestamp() WHERE id=$1",
    [cancelled.id],
  );
  let summary = (await s.get(user, set)).summary;
  expect(summary).toMatchObject({
    materialCount: 1,
    deckCount: 1,
    pendingTaskCount: 1,
    dueCardCount: 0,
    lastStudiedAt: null,
  });
  expect(summary.continue).toEqual({
    label: "查看学习任务",
    href: `/platform/studyset/${set}/study-plan?planId=${plan.id}`,
  });
  await db.query(
    "INSERT INTO study_flashcard_schedules(card_id,user_id,card_version,revision,stage,rule_version,due_at,reviewed_at) VALUES($1,$2,1,1,0,'fixture',clock_timestamp()-interval '1 day',clock_timestamp()-interval '2 days')",
    [card.id, user],
  );
  summary = (await s.get(user, set)).summary;
  expect(summary.dueCardCount).toBe(1);
  expect(summary.lastStudiedAt).not.toBeNull();
  expect(summary.continue?.label).toBe("复习到期闪卡");
  await db.query("UPDATE study_flashcards SET version=2 WHERE id=$1", [
    card.id,
  ]);
  expect((await s.get(user, set)).summary.dueCardCount).toBe(0);
  await db.query(
    "INSERT INTO study_plan_evidence(user_id,task_id,session_kind,session_id,completed_at) VALUES($1,$2,'flashcard_session',$3,clock_timestamp())",
    [user, pending.id, id()],
  );
  expect((await s.get(user, set)).summary.pendingTaskCount).toBe(0);
});
it("resumes real free and spaced sessions with exact parent-scoped URLs, preserving study dates", async () => {
  const f = new FlashcardService(db),
    deck = (
      await f.create(user, set, { clientRequestId: id(), title: "学习卡组" })
    ).deck;
  await f.addCard(user, set, deck.id, {
    clientRequestId: id(),
    front: "问",
    back: "答",
  });
  const free = (await f.start(user, set, deck.id, { clientRequestId: id() }))
    .session;
  let summary = (await s.get(user, set)).summary;
  expect(summary.lastStudiedAt).toBeNull();
  expect(summary.continue?.href).toBe(
    `/platform/studyset/${set}/flashcards?flashcardDeck=${deck.id}&flashcardSession=${free.id}`,
  );
  const spaced = (
    await new SpacedReviewService(db).start(user, set, deck.id, {
      clientRequestId: id(),
    })
  ).session;
  summary = (await s.get(user, set)).summary;
  expect(summary.continue?.href).toBe(
    `/platform/studyset/${set}/flashcards?flashcardDeck=${deck.id}&spacedReviewSession=${spaced.id}`,
  );
  expect(summary.lastStudiedAt).toBeNull();
});
it("keeps HTTP default contracts and guards library query input", async () => {
  const { createApp } = await import("../src/api/app.js"),
    app = createApp(db, {
      releaseId: "library-test",
      rateLimitSecret: new Uint8Array(32).fill(8),
      sessionFetch: async () =>
        Response.json({ userId: user, csrfToken: "a".repeat(43) }),
    }),
    headers = {
      cookie: "__Host-planplan-session=test",
      "X-PlanPlan-Expected-User": user,
    };
  const old = await (await app.request("/v1/study/sets", { headers })).json();
  expect(old.items[0]).not.toHaveProperty("summary");
  const page = await (
    await app.request("/v1/study/sets?view=library", { headers })
  ).json();
  expect(page.items[0]).toHaveProperty("summary.materialCount", 0);
  const detail = await (
    await app.request(`/v1/study/sets/${set}?view=library`, { headers })
  ).json();
  expect(detail.studySet.summary.lastStudiedAt).toBeNull();
  expect(
    (await app.request("/v1/study/sets?view=library&sort=invalid", { headers }))
      .status,
  ).toBe(400);
  expect(
    (await app.request("/v1/study/sets?view=library&q=a&q=b", { headers }))
      .status,
  ).toBe(400);
  expect((await app.request("/v1/study/sets?view=library")).status).toBe(401);
});
it("uses submitted quizzes for real study time and resumes only unfinished attempts", async () => {
  const [job] = await db.query<{ id: string }>(
    "INSERT INTO study_generation_jobs(user_id,study_set_id,kind,client_request_id,request_digest,input_snapshot,provider_config,status) VALUES($1,$2,'quiz',$3,repeat('a',64),'{}','{}','failed') RETURNING id",
    [user, set, id()],
  );
  const [quiz] = await db.query<{ id: string }>(
    'INSERT INTO study_quizzes(user_id,study_set_id,generation_id,client_request_id,title,questions,source_snapshot) VALUES($1,$2,$3,$4,\'真题集\',\'[{"type":"true_false","prompt":"原题干不应暴露到摘要","options":["是","否"],"answerIndex":0,"explanation":"解析也不暴露","citations":[]}]\',\'{}\') RETURNING id',
    [user, set, job!.id, id()],
  );
  const [attempt] = await db.query<{ id: string }>(
    "INSERT INTO study_quiz_attempts(user_id,quiz_id,client_request_id,mode,snapshot) VALUES($1,$2,$3,'exam','{}') RETURNING id",
    [user, quiz!.id, id()],
  );
  let item = await s.get(user, set);
  expect(item.summary.quizCount).toBe(1);
  expect(item.summary.lastStudiedAt).toBeNull();
  expect(item.summary.continue).toEqual({
    label: "继续考试",
    href: `/platform/studyset/${set}/practice?quizId=${quiz!.id}&attemptId=${attempt!.id}`,
  });
  await db.query(
    "UPDATE study_quiz_attempts SET status='submitted',submitted_at='2026-01-02T03:04:05Z',first_correct=1,final_correct=1 WHERE id=$1",
    [attempt!.id],
  );
  item = await s.get(user, set);
  expect(item.summary.lastStudiedAt).toBe("2026-01-02T03:04:05.000Z");
  expect(item.summary.continue).toBeNull();
  expect(JSON.stringify(item)).not.toContain("原题干");
  expect(JSON.stringify(item)).not.toContain("解析");
});
it("paginates recent/created microsecond ties and rejects moved or malformed cursor dates", async () => {
  for (let i = 0; i < 5; i++) await create("同名");
  await db.query(
    "UPDATE study_sets SET created_at='2026-01-01T00:00:00.000123Z',updated_at='2026-01-01T00:00:00.000123Z' WHERE user_id=$1",
    [user],
  );
  for (const sort of ["recent", "created"]) {
    let cursor: string | null = null,
      seen: string[] = [];
    do {
      const page = await s.list(user, {
        sort,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(6);
  }
  const page = await s.list(user, { sort: "recent", limit: 2 }),
    value = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString());
  await expect(
    s.list(user, {
      sort: "recent",
      cursor: Buffer.from(
        JSON.stringify({ ...value, key: "2026-99-99T00:00:00.000000Z" }),
      ).toString("base64url"),
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await db.query(
    "UPDATE study_sets SET updated_at=clock_timestamp() WHERE id=$1",
    [value.id],
  );
  await expect(
    s.list(user, { sort: "recent", cursor: page.nextCursor }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});
it("respects search closure while keeping ordinary library reads and maps query timeout safely", async () => {
  const previous = process.env.STUDYC_SEARCH_ENABLED;
  process.env.STUDYC_SEARCH_ENABLED = "false";
  try {
    await expect(s.list(user, { q: "真实" })).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect((await s.list(user, {})).items).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.STUDYC_SEARCH_ENABLED;
    else process.env.STUDYC_SEARCH_ENABLED = previous;
  }
  const timed: Db = {
    ...db,
    query: db.query.bind(db),
    exec: db.exec.bind(db),
    close: db.close.bind(db),
    tx: async (fn) =>
      db.tx((q) =>
        fn({
          query: async (sql, params) => {
            if (sql.startsWith("SET LOCAL")) throw { code: "57014" };
            return q.query(sql, params);
          },
          exec: q.exec,
        }),
      ),
  };
  await expect(new LibraryService(timed).list(user, {})).rejects.toMatchObject({
    code: "service_unavailable",
  });
});
it("does not offer closed SRS continuations while retaining real due counts and study history", async () => {
  const previous = process.env.STUDYC_SRS_ENABLED;
  process.env.STUDYC_SRS_ENABLED = "true";
  try {
    const f = new FlashcardService(db),
      spaced = new SpacedReviewService(db);
    const deck = (
      await f.create(user, set, {
        clientRequestId: id(),
        title: "有进度的卡组",
      })
    ).deck;
    for (const title of ["第一个问题", "第二个问题"])
      await f.addCard(user, set, deck.id, {
        clientRequestId: id(),
        front: title,
        back: "答案",
      });
    const free = (await f.start(user, set, deck.id, { clientRequestId: id() }))
      .session;
    const session = (
      await spaced.start(user, set, deck.id, { clientRequestId: id() })
    ).session;
    await spaced.act(user, set, deck.id, session.id, {
      clientRequestId: id(),
      version: 1,
      position: 0,
      cardId: session.cards[0].id,
      action: "rate",
      rating: "again",
    });
    await db.query(
      "UPDATE study_flashcard_schedules SET due_at=clock_timestamp()-interval '1 minute' WHERE user_id=$1",
      [user],
    );
    const before = (await s.get(user, set)).summary;
    expect(before.continue?.label).toBe("继续间隔复习");
    expect(before.dueCardCount).toBe(1);
    expect(before.lastStudiedAt).not.toBeNull();
    process.env.STUDYC_SRS_ENABLED = "false";
    const closed = (await s.get(user, set)).summary;
    expect(closed.continue).toEqual({
      label: "继续闪卡学习",
      href: `/platform/studyset/${set}/flashcards?flashcardDeck=${deck.id}&flashcardSession=${free.id}`,
    });
    expect(closed.dueCardCount).toBe(before.dueCardCount);
    expect(closed.lastStudiedAt).toBe(before.lastStudiedAt);
    for (let i = 0; i < free.cards.length; i++)
      await f.review(user, set, deck.id, free.id, {
        clientRequestId: id(),
        version: i + 1,
        position: i,
        cardId: free.cards[i]!.id,
        rating: "good",
      });
    const withoutFree = (await s.get(user, set)).summary;
    expect(withoutFree.continue).toBeNull();
    expect(withoutFree.dueCardCount).toBe(1);
    expect(withoutFree.lastStudiedAt).not.toBeNull();
    expect((await spaced.get(user, set, deck.id, session.id)).status).toBe(
      "in_progress",
    );
  } finally {
    if (previous === undefined) delete process.env.STUDYC_SRS_ENABLED;
    else process.env.STUDYC_SRS_ENABLED = previous;
  }
});
it("orders legacy SRS continuations by their latest persisted action when updatedAt is absent", async () => {
  const f = new FlashcardService(db),
    deck = (
      await f.create(user, set, {
        clientRequestId: id(),
        title: "旧版复习进度",
      })
    ).deck;
  for (const title of ["第一题", "第二题"])
    await f.addCard(user, set, deck.id, {
      clientRequestId: id(),
      front: title,
      back: "答案",
    });
  let clock = new Date("2026-01-01T00:00:00Z");
  const spaced = new SpacedReviewService(
      db,
      () => clock,
      () => true,
    ),
    session = (
      await spaced.start(user, set, deck.id, { clientRequestId: id() })
    ).session;
  clock = new Date("2026-03-01T09:00:00Z");
  await spaced.act(user, set, deck.id, session.id, {
    clientRequestId: id(),
    version: 1,
    position: 0,
    cardId: session.cards[0].id,
    action: "rate",
    rating: "good",
  });
  await db.query(
    "UPDATE study_spaced_review_sessions SET data=data-'updatedAt',created_at='2026-01-01T00:00:00Z' WHERE id=$1",
    [session.id],
  );
  const free = (await f.start(user, set, deck.id, { clientRequestId: id() }))
    .session;
  await db.query(
    "UPDATE study_flashcard_sessions SET created_at='2026-02-01T00:00:00Z',updated_at='2026-02-01T00:00:00Z' WHERE id=$1",
    [free.id],
  );
  expect((await spaced.get(user, set, deck.id, session.id)).updatedAt).toBe(
    clock.toISOString(),
  );
  expect((await s.get(user, set)).summary.continue).toEqual({
    label: "继续间隔复习",
    href: `/platform/studyset/${set}/flashcards?flashcardDeck=${deck.id}&spacedReviewSession=${session.id}`,
  });
  const [stored] = await db.query<{ data: Record<string, unknown> }>(
    "SELECT data FROM study_spaced_review_sessions WHERE id=$1",
    [session.id],
  );
  expect(stored!.data).not.toHaveProperty("updatedAt");
});
