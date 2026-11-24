import { GenerationStore } from "../src/generation/store.js";
import {
  DEFAULT_GENERATION_POLICY,
  UNKNOWN_USAGE,
} from "../src/generation/types.js";
import { validateLearningOutput } from "../src/generation/learning-output.js";
import {
  materializeQuiz,
  startQuizAttempt,
  answerQuiz,
  submitQuiz,
} from "../src/services/quizzes.js";
import { randomUUID as id } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { Db } from "../src/db/db.js";
import { openTestDb, dropAdditionsAfter } from "./database.js";
import { PlanService, planCreate, taskCreate } from "../src/services/plans.js";
import { FlashcardService } from "../src/services/flashcards.js";
import { SpacedReviewService } from "../src/services/spaced-review.js";
import {
  createStudySet,
  createTextMaterial,
} from "../src/services/study-data.js";
import { createApp } from "../src/api/app.js";
import { checkMigrations, migrate } from "../src/db/migrations.js";
describe("owner-scoped plans, dates, explicit completion and evidence", () => {
  let db: Db,
    s: PlanService,
    f: FlashcardService,
    user: string,
    bob: string,
    set: string,
    other: string,
    plan: string,
    deck: string;
  beforeEach(async () => {
    db = await openTestDb();
    s = new PlanService(db);
    f = new FlashcardService(db);
    const rows = await db.query<{ id: string }>(
      "INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id",
    );
    user = rows[0]!.id;
    bob = rows[1]!.id;
    set = (
      await createStudySet(db, user, { clientRequestId: id(), title: "学习集" })
    ).studySet.id;
    other = (
      await createStudySet(db, user, {
        clientRequestId: id(),
        title: "另一个集",
      })
    ).studySet.id;
    plan = (
      await s.create(user, set, {
        clientRequestId: id(),
        title: "目标",
        goal: "会解释关键概念",
        dueDate: "2026-12-31",
      })
    ).plan.id;
    deck = (
      await f.create(user, set, { clientRequestId: id(), title: "概念闪卡" })
    ).deck.id;
    await f.addCard(user, set, deck, {
      clientRequestId: id(),
      front: "概念是什么？",
      back: "概念的解释。",
    });
  }, 30000);
  afterEach(async () => {
    await db?.close();
  });
  const task = (activity: any = null) =>
    s.createTask(user, set, plan, {
      clientRequestId: id(),
      title: "任务",
      dueDate: "2026-12-01",
      activity,
    });
  const edit = (t: any, patch: any) =>
    s.editTask(user, set, plan, t.id, {
      clientRequestId: id(),
      version: t.version,
      ...patch,
    });
  async function complete() {
    const a = (await f.start(user, set, deck, { clientRequestId: id() }))
      .session;
    return (
      await f.review(user, set, deck, a.id, {
        clientRequestId: id(),
        version: a.version,
        position: 0,
        cardId: a.cards[0]!.id,
        rating: "good",
      })
    ).session;
  }
  it("retains date-only deadlines and rejects normalized invalid dates, extra timestamps and injected completion", async () => {
    expect((await s.get(user, set, plan)).dueDate).toBe("2026-12-31");
    for (const dueDate of [
      "2026-02-29",
      "2026-04-31",
      "0000-01-01",
      "2026-01-01T12:00:00Z",
    ])
      expect(() =>
        planCreate.parse({ clientRequestId: id(), title: "目标", dueDate }),
      ).toThrow();
    expect(() =>
      taskCreate.parse({
        clientRequestId: id(),
        title: "任务",
        manualCompletedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
  it("deduplicates create retries and rejects changed intent before creating a second entity", async () => {
    const input = { clientRequestId: id(), title: "另一个目标" };
    const a = await s.create(user, set, input);
    expect((await s.create(user, set, input)).plan.id).toBe(a.plan.id);
    await expect(
      s.create(user, set, { ...input, title: "改变意图" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const tin = {
      clientRequestId: id(),
      title: "任务",
      activity: { kind: "deck", id: deck },
    };
    const t = await s.createTask(user, set, plan, tin);
    expect((await s.createTask(user, set, plan, tin)).task.id).toBe(t.task.id);
    expect((await s.tasks(user, set, plan)).items).toHaveLength(1);
  });
  it("records and reverses manual completion independently of learning evidence and replays mutations without resetting later state", async () => {
    let t = (await task()).task;
    const input = {
      clientRequestId: id(),
      version: t.version,
      manualCompleted: true,
    };
    t = (await s.editTask(user, set, plan, t.id, input)).task;
    expect(t.manualCompletedBy).toBe(user);
    expect(t.manualCompletedAt).toBeTruthy();
    expect(t.evidence).toEqual([]);
    t = (await edit(t, { manualCompleted: false })).task;
    expect(t.manualCompletedAt).toBe(null);
    const retry = await s.editTask(user, set, plan, t.id, input);
    expect(retry.replayed).toBe(true);
    expect(retry.task.manualCompletedAt).toBe(null);
  });
  it("handles stale edits without changing the saved goal or task and keeps original activity linkage fixed", async () => {
    const p = await s.get(user, set, plan);
    await s.edit(user, set, plan, {
      clientRequestId: id(),
      version: p.version,
      title: "云端目标",
      goal: "新目标",
      dueDate: null,
    });
    await expect(
      s.edit(user, set, plan, {
        clientRequestId: id(),
        version: p.version,
        title: "本地",
        goal: "旧目标",
        dueDate: null,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const t = (await task({ kind: "deck", id: deck })).task;
    await edit(t, { dueDate: "2027-01-01" });
    await expect(edit(t, { title: "旧版本" })).rejects.toMatchObject({
      code: "version_conflict",
    });
    await expect(
      edit(t, { activity: { kind: "deck", id: id() } }),
    ).rejects.toThrow();
    expect((await s.tasks(user, set, plan)).items[0]!.activity!.id).toBe(deck);
  });
  it("requires same owner and set for plans, task links, lists, cursors, edits and evidence", async () => {
    const foreign = (
      await f.create(
        bob,
        (await createStudySet(db, bob, { clientRequestId: id(), title: "B" }))
          .studySet.id,
        { clientRequestId: id(), title: "B卡组" },
      )
    ).deck;
    await expect(task({ kind: "deck", id: foreign.id })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(s.get(bob, set, plan)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(s.get(user, other, plan)).rejects.toMatchObject({
      code: "not_found",
    });
    const t = (await task()).task;
    await expect(s.tasks(user, other, plan)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      s.editTask(bob, set, plan, t.id, {
        clientRequestId: id(),
        version: 1,
        title: "攻击",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(s.options(user, other, "deck", deck)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(s.evidence(bob, set, plan, t.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("does not infer completion from opening a deck or an in-progress session", async () => {
    const t = (await task({ kind: "deck", id: deck })).task;
    await f.get(user, set, deck);
    const a = (await f.start(user, set, deck, { clientRequestId: id() }))
      .session;
    expect((await s.evidence(user, set, plan, t.id)).items).toEqual([]);
    await expect(
      s.linkEvidence(user, set, plan, t.id, {
        clientRequestId: id(),
        version: 1,
        sessionKind: "flashcard_session",
        sessionId: a.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await s.tasks(user, set, plan)).items[0]!.manualCompletedAt).toBe(
      null,
    );
  });
  it("links a real completed session exactly once, retains evidence after manual undo, and excludes sessions started before task creation", async () => {
    const earlier = await complete();
    const t = (await task({ kind: "deck", id: deck })).task;
    const a = await complete();
    expect(
      (await s.evidence(user, set, plan, t.id)).items.map((e) => e.sessionId),
    ).toEqual([a.id]);
    await expect(
      s.linkEvidence(user, set, plan, t.id, {
        clientRequestId: id(),
        version: 1,
        sessionKind: "flashcard_session",
        sessionId: earlier.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const input = {
      clientRequestId: id(),
      version: 1,
      sessionKind: "flashcard_session",
      sessionId: a.id,
    };
    let linked = await s.linkEvidence(user, set, plan, t.id, input);
    expect(linked.task.evidence).toHaveLength(1);
    expect(linked.task.manualCompletedAt).toBe(null);
    linked = await s.linkEvidence(user, set, plan, t.id, input);
    expect(linked.replayed).toBe(true);
    let current = (await edit(linked.task, { manualCompleted: true })).task;
    current = (await edit(current, { manualCompleted: false })).task;
    expect(current.evidence).toHaveLength(1);
  });
  it("only counts spaced sessions containing actual ratings rather than all-skipped completion", async () => {
    const t = (await task({ kind: "deck", id: deck })).task;
    const spaced = new SpacedReviewService(db);
    const a = (await spaced.start(user, set, deck, { clientRequestId: id() }))
      .session;
    const c = a.cards[0]!;
    await spaced.act(user, set, deck, a.id, {
      clientRequestId: id(),
      version: a.version,
      position: 0,
      cardId: c.id,
      action: "rate",
      rating: "good",
    });
    const items = (await s.evidence(user, set, plan, t.id)).items;
    expect(
      items.some(
        (e) => e.sessionKind === "spaced_review" && e.sessionId === a.id,
      ),
    ).toBe(true);
    const current=(await f.get(user,set,deck)).cards[0]!;
    const changed=await f.editCard(user,set,deck,current.id,{version:current.version,front:'更新概念',back:'更新解释'});
    const stale=(await spaced.start(user,set,deck,{clientRequestId:id()})).session;
    await f.editCard(user,set,deck,changed.id,{version:changed.version,front:'再次更新',back:'解释三'});
    const ended=await spaced.act(user,set,deck,stale.id,{clientRequestId:id(),version:stale.version,position:0,cardId:changed.id,action:'skip_stale'});
    expect(ended.session.reviewedCount).toBe(0);
    expect((await s.evidence(user,set,plan,t.id)).items.some(e=>e.sessionId===stale.id)).toBe(false);
  });
  it("only links submitted quiz attempts, never an opened exam or answers in progress", async () => {
    const quote = "水蒸气冷却后凝结成小水滴，降水把水带回地表。",
      m = (
        await createTextMaterial(db, user, set, {
          clientRequestId: id(),
          title: "来源",
          body: quote,
        })
      ).material;
    const store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "fixture/model",
      outputMode: "strict",
      maxOutputTokens: 1024,
      timeoutMs: 1000,
      providerOnly: [],
    });
    const { job } = await store.create(user, set, {
        clientRequestId: id(),
        kind: "quiz",
        sources: [{ materialId: m.id, version: 1 }],
        config: { language: "zh-CN", singleChoiceCount: 0, trueFalseCount: 1 },
      }),
      claim = (await store.claim())!;
    const result = validateLearningOutput(
      JSON.stringify({
        title: "水循环",
        questions: [
          {
            type: "true_false",
            prompt: "降水把水带回地表？",
            options: ["正确", "错误"],
            answerIndex: 0,
            explanation: "原文提供依据。",
            citations: [{ sourceId: "s1", quote }],
          },
        ],
      }),
      claim.snapshot,
    );
    await store.settle(claim, {
      status: "succeeded",
      errorCode: null,
      result,
      usage: UNKNOWN_USAGE,
    });
    const quiz = (
      await materializeQuiz(db, store, user, set, {
        clientRequestId: id(),
        generationId: job.id,
      })
    ).quiz;
    const t = (await task({ kind: "quiz", id: quiz.id })).task;
    let a = (
      await startQuizAttempt(db, user, set, quiz.id, {
        clientRequestId: id(),
        mode: "exam",
      })
    ).attempt;
    expect((await s.evidence(user, set, plan, t.id)).items).toEqual([]);
    a = (
      await answerQuiz(db, user, set, quiz.id, a.id, {
        clientRequestId: id(),
        version: a.version,
        questionIndex: 0,
        answerIndex: 0,
      })
    ).attempt;
    expect((await s.evidence(user, set, plan, t.id)).items).toEqual([]);
    a = (
      await submitQuiz(db, user, set, quiz.id, a.id, {
        clientRequestId: id(),
        version: a.version,
      })
    ).attempt;
    expect((await s.evidence(user, set, plan, t.id)).items).toMatchObject([
      { sessionId: a.id, sessionKind: "quiz_attempt" },
    ]);
    const linked = await s.linkEvidence(user, set, plan, t.id, {
      clientRequestId: id(),
      version: t.version,
      sessionId: a.id,
      sessionKind: "quiz_attempt",
    });
    expect(linked.task.evidence).toHaveLength(1);
    expect(linked.task.manualCompletedAt).toBe(null);
  });
  it("keeps task cancellation reversible and disallows completing canceled tasks", async () => {
    const t = (await task()).task;
    const canceled = (await edit(t, { cancelled: true })).task;
    await expect(
      edit(canceled, { manualCompleted: true }),
    ).rejects.toMatchObject({ code: "job_conflict" });
    const restored = (await edit(canceled, { cancelled: false })).task;
    expect(restored.cancelledAt).toBe(null);
    expect(
      (await edit(restored, { manualCompleted: true })).task.manualCompletedAt,
    ).toBeTruthy();
  });
  it("paginates tasks and plans without missing equal timestamp rows and scopes options", async () => {
    for (let i = 0; i < 22; i++) await task();
    const first = await s.tasks(user, set, plan),
      second = await s.tasks(user, set, plan, first.nextCursor!);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(2);
    expect(
      new Set([...first.items, ...second.items].map((t) => t.id)).size,
    ).toBe(22);
    const m = (
      await createTextMaterial(db, user, set, {
        clientRequestId: id(),
        title: "资料",
        body: "学习内容",
      })
    ).material;
    expect((await s.options(user, set, "material")).items).toEqual([
      { id: m.id, title: "资料" },
    ]);
  });
  it("blocks mutations under feature closure while saved goals and tasks remain readable", async () => {
    const previous = process.env.STUDYC_PLANS_ENABLED;
    process.env.STUDYC_PLANS_ENABLED = "false";
    try {
      expect((await s.list(user, set)).enabled).toBe(false);
      expect((await s.get(user, set, plan)).id).toBe(plan);
      await expect(task()).rejects.toMatchObject({
        code: "service_unavailable",
      });
    } finally {
      if (previous === undefined) delete process.env.STUDYC_PLANS_ENABLED;
      else process.env.STUDYC_PLANS_ENABLED = previous;
    }
  });
  it("enforces HTTP identity, CSRF, methods, strict input and write size", async () => {
    const app = createApp(db, {
        releaseId: "plans-http",
        rateLimitSecret: new Uint8Array(32).fill(8),
        sessionFetch: async () =>
          Response.json({ userId: user, csrfToken: "a".repeat(43) }),
      }),
      root = `/v1/study/sets/${set}/plans`,
      headers = {
        cookie: "__Host-planplan-session=test",
        "X-PlanPlan-Expected-User": user,
        "X-CSRF-Token": "a".repeat(43),
        origin: "https://study.clyna.ai",
        "content-type": "application/json",
      };
    expect((await app.request(root)).status).toBe(401);
    expect(
      (await app.request(root, { headers, method: "DELETE" })).status,
    ).toBe(405);
    expect(
      (
        await app.request(root, {
          headers: { ...headers, "X-CSRF-Token": "wrong" },
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(root, {
          headers,
          method: "POST",
          body: JSON.stringify({ x: "x".repeat(16385) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (await app.request(root + "?cursor=x&cursor=y", { headers })).status,
    ).toBe(400);
    expect(
      (
        await app.request(root, {
          headers,
          method: "POST",
          body: JSON.stringify({
            clientRequestId: id(),
            title: "HTTP计划",
            dueDate: "2026-12-01",
          }),
        })
      ).status,
    ).toBe(201);
  });
  it("preserves v9 history and data on upgrade and detects new schema drift", async () => {
    await dropAdditionsAfter(db, 9);
    const history = await db.query(
      "SELECT * FROM studyc_schema_migrations ORDER BY version",
    );
    await migrate(db);
    await migrate(db);
    await checkMigrations(db);
    expect(
      await db.query(
        "SELECT * FROM studyc_schema_migrations WHERE version<=9 ORDER BY version",
      ),
    ).toEqual(history);
    await db.exec(
      "ALTER TABLE study_plan_tasks DROP CONSTRAINT study_plan_tasks_plan_id_user_id_study_set_id_fkey",
    );
    await expect(checkMigrations(db)).rejects.toThrow(/drift/);
  });
  it("removes all planning data during hard account deletion and rejects soft-deleted identities", async () => {
    await task();
    await db.query("UPDATE users SET deleted_at=now() WHERE id=$1", [user]);
    await expect(s.get(user, set, plan)).rejects.toThrow();
    await db.query("DELETE FROM users WHERE id=$1", [user]);
    for (const table of [
      "study_plans",
      "study_plan_tasks",
      "study_plan_evidence",
      "study_planning_requests",
    ])
      expect(
        await db.query(`SELECT * FROM ${table} WHERE user_id=$1`, [user]),
      ).toEqual([]);
  });
});
