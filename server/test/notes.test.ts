import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { Db } from "../src/db/db.js";
import { openTestDb } from "./database.js";
import { NoteService } from "../src/services/notes.js";
import {
  createStudySet,
  createTextMaterial,
  updateTextMaterial,
} from "../src/services/study-data.js";
import { GenerationStore } from "../src/generation/store.js";
import {
  DEFAULT_GENERATION_POLICY,
  type GenerationProviderConfig,
} from "../src/generation/types.js";
import { createOpenRouterGenerationProvider } from "../src/generation/provider.js";
import { validateLearningOutput } from "../src/generation/learning-output.js";
import { createApp } from "../src/api/app.js";
import { migrate, checkMigrations } from "../src/db/migrations.js";
const quote = "水蒸气冷却凝结形成云中的小水滴，降水把大气中的水带回地表。";
const config: GenerationProviderConfig = {
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "fixture/model",
  outputMode: "strict",
  maxOutputTokens: 1024,
  timeoutMs: 1000,
  providerOnly: [],
};
const output = () => ({
  title: "水循环笔记",
  sections: [
    {
      heading: "凝结和降水",
      body: "## 凝结\n\n- 水蒸气冷却凝结。\n- 降水把水带回地表。",
      citations: [{ sourceId: "s1", quote }],
    },
  ],
});
describe("generated notes snapshots, explicit materialization and editing", () => {
  let db: Db,
    store: GenerationStore,
    service: NoteService,
    user: string,
    bob: string,
    set: string,
    other: string,
    material: string,
    jobId: string;
  beforeEach(async () => {
    db = await openTestDb();
    const users = await db.query<{
      id: string;
    }>("INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id");
    user = users[0]!.id;
    bob = users[1]!.id;
    set = (
      await createStudySet(db, user, {
        clientRequestId: randomUUID(),
        title: "水循环",
      })
    ).studySet.id;
    other = (
      await createStudySet(db, user, {
        clientRequestId: randomUUID(),
        title: "其他",
      })
    ).studySet.id;
    material = (
      await createTextMaterial(db, user, set, {
        clientRequestId: randomUUID(),
        title: "原资料",
        body: quote,
      })
    ).material.id;
    store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config);
    service = new NoteService(db);
    const { job } = await store.create(user, set, {
      clientRequestId: randomUUID(),
      kind: "study_note",
      sources: [{ materialId: material, version: 1 }],
      config: { language: "zh-CN", sectionCount: 1 },
    });
    jobId = job.id;
  }, 30000);
  afterEach(async () => {
    await db?.close();
  });
  async function succeed() {
    const claim = (await store.claim())!;
    const provider = createOpenRouterGenerationProvider({
      config,
      apiKey: "synthetic-test-only",
      fetch: async () =>
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(output()) },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 100,
            total_tokens: 200,
          },
        }),
    });
    const outcome = await provider.generate(
      claim,
      new AbortController().signal,
    );
    expect(outcome.status).toBe("succeeded");
    await store.settle(claim, outcome);
    return (await store.get(user, set, jobId)).inputSnapshot!;
  }
  const save = (clientRequestId = randomUUID()) =>
    service.save(user, set, { clientRequestId, jobId });
  it("does not create a note before explicit save, and recovers the same entity with either replay identity", async () => {
    await succeed();
    expect((await service.list(user, set)).items).toHaveLength(0);
    const id = randomUUID(),
      a = await save(id);
    expect(a.replayed).toBe(false);
    expect((await save(id)).note.id).toBe(a.note.id);
    expect((await save()).note.id).toBe(a.note.id);
    expect((await service.list(user, set)).items).toHaveLength(1);
    const detail = await service.get(user, set, a.note.id);
    expect(detail.origin.result.title).toBe(output().title);
    expect(detail.note.body).toContain("凝结");
    expect(detail.note.manuallyEdited).toBe(false);
  });
  it("rejects nonterminal, foreign and mismatched intent inputs without creating data", async () => {
    await expect(save()).rejects.toMatchObject({ code: "job_conflict" });
    await succeed();
    const id = randomUUID();
    await save(id);
    await expect(
      service.save(user, set, { clientRequestId: id, jobId: randomUUID() }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      service.save(bob, set, { clientRequestId: randomUUID(), jobId }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.save(user, other, { clientRequestId: randomUUID(), jobId }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.save(user, set, {
        clientRequestId: randomUUID(),
        jobId,
        body: "injected",
      }),
    ).rejects.toThrow();
  });
  it("keeps the immutable original and source v1 after manual editing and source v2", async () => {
    await succeed();
    const { note } = await save(),
      before = await service.get(user, set, note.id);
    await updateTextMaterial(db, user, set, material, {
      version: 1,
      title: "资料 v2",
      body: quote + "地表径流可以汇入河流。",
    });
    const n = await service.edit(user, set, note.id, {
      version: 1,
      title: "我的笔记",
      body: "## 自己的理解\n\n<script>alert(1)</script>",
    });
    expect(n).toMatchObject({ version: 2, manuallyEdited: true });
    expect((await service.get(user, set, note.id)).origin).toEqual(
      before.origin,
    );
    expect(
      (await service.get(user, set, note.id)).origin.sourceSnapshots[0]!
        .version,
    ).toBe(1);
    expect((await save()).note.title).toBe("我的笔记");
  });
  it("preserves current server content on stale concurrent updates and requires explicit rebasing", async () => {
    await succeed();
    const { note } = await save();
    await service.edit(user, set, note.id, {
      version: 1,
      title: "云端",
      body: "云端正文",
    });
    await expect(
      service.edit(user, set, note.id, {
        version: 1,
        title: "本地",
        body: "本地正文",
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect((await service.get(user, set, note.id)).note.title).toBe("云端");
    const n = await service.edit(user, set, note.id, {
      version: 2,
      title: "本地",
      body: "本地正文",
    });
    expect(n.version).toBe(3);
  });
  it("verifies chapter count, quote uniqueness, source membership and exact output shape", async () => {
    const snapshot = await succeed();
    for (const bad of [
      { ...output(), extra: true },
      { ...output(), sections: [] },
      {
        ...output(),
        sections: [
          { ...output().sections[0], citations: [{ sourceId: "s2", quote }] },
        ],
      },
      {
        ...output(),
        sections: [
          {
            ...output().sections[0],
            citations: [
              { sourceId: "s1", quote: "这条引文并不在原文的任何一个位置中。" },
            ],
          },
        ],
      },
    ])
      expect(() =>
        validateLearningOutput(JSON.stringify(bad), snapshot),
      ).toThrow();
  });
  it("rejects generated candidates whose aggregate UTF-8 Markdown cannot be saved", async () => {
    const snapshot=await succeed();snapshot.config={language:'zh-CN',sectionCount:8};
    const oversized={title:'长笔记',sections:Array.from({length:8},(_,i)=>({heading:`章 ${i}`,body:'水'.repeat(4000),citations:[{sourceId:'s1',quote}]}))};
    expect(()=>validateLearningOutput(JSON.stringify(oversized),snapshot)).toThrow('invalid_output');
  });
  it("revalidates persisted citation offsets before materialization and rolls back all inserts", async () => {
    await succeed();
    await db.exec(
      "ALTER TABLE study_generation_jobs DISABLE TRIGGER immutable_input",
    );
    await db.query(
      "UPDATE study_generation_jobs SET result=jsonb_set(result,'{sections,0,citations,0,start}','1') WHERE id=$1",
      [jobId],
    );
    await db.exec(
      "ALTER TABLE study_generation_jobs ENABLE TRIGGER immutable_input",
    );
    await expect(save()).rejects.toMatchObject({ code: "invalid_input" });
    expect((await service.list(user, set)).items).toHaveLength(0);
  });
  it("isolates reads, cursors and edits by owner and set", async () => {
    await succeed();
    const { note } = await save();
    for (const [u, s] of [
      [bob, set],
      [user, other],
    ]) {
      await expect(service.get(u!, s!, note.id)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(service.list(u!, s!, note.id)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        service.edit(u!, s!, note.id, { version: 1, title: "x", body: "x" }),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(
      service.edit(user, set, note.id, {
        version: 1,
        title: "x",
        body: "x".repeat(65537),
      }),
    ).rejects.toThrow();
  });
  it("disables mutations while keeping saved notes readable", async () => {
    await succeed();
    const { note } = await save(),
      previous = process.env.STUDYC_NOTES_ENABLED;
    process.env.STUDYC_NOTES_ENABLED = "false";
    try {
      expect((await service.list(user, set)).enabled).toBe(false);
      expect((await service.get(user, set, note.id)).note.id).toBe(note.id);
      await expect(save()).rejects.toMatchObject({
        code: "service_unavailable",
      });
      await expect(
        service.edit(user, set, note.id, { version: 1, title: "x", body: "x" }),
      ).rejects.toMatchObject({ code: "service_unavailable" });
    } finally {
      if (previous === undefined) delete process.env.STUDYC_NOTES_ENABLED;
      else process.env.STUDYC_NOTES_ENABLED = previous;
    }
  });
  it("paginates stable owner-scoped notes without missing equal timestamp records", async () => {
    await succeed();
    const { note } = await save();
    for (let i = 0; i < 22; i++)
      await db.query(
        "INSERT INTO study_notes(user_id,study_set_id,title,body,created_at) VALUES($1,$2,$3,'正文','2026-01-01T00:00:00Z')",
        [user, set, `笔记 ${i}`],
      );
    const first = await service.list(user, set),
      second = await service.list(user, set, first.nextCursor!);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(3);
    expect(
      new Set([...first.items, ...second.items].map((n) => n.id)).size,
    ).toBe(23);
    expect(
      [...first.items, ...second.items].some((n) => n.id === note.id),
    ).toBe(true);
  });
  it("rejects deleted identities and cascades note history on hard account deletion", async () => {
    await succeed();
    const { note } = await save();
    await db.query("UPDATE users SET deleted_at=now() WHERE id=$1", [user]);
    await expect(service.get(user, set, note.id)).rejects.toThrow();
    await db.query("DELETE FROM users WHERE id=$1", [user]);
    for (const table of [
      "study_notes",
      "study_note_origins",
      "study_note_materializations",
    ])
      expect(
        await db.query(`SELECT * FROM ${table} WHERE user_id=$1`, [user]),
      ).toEqual([]);
  });
  it("feature closure blocks note generation and retry before reserving model usage", async () => {
    const app = createApp(db, {
      releaseId: "notes-disabled",
      generationStore: store,
      rateLimitSecret: new Uint8Array(32).fill(7),
      sessionFetch: async () =>
        Response.json({ userId: user, csrfToken: "a".repeat(43) }),
    });
    const headers = {
        cookie: "__Host-planplan-session=test",
        "X-PlanPlan-Expected-User": user,
        "X-CSRF-Token": "a".repeat(43),
        origin: "https://study.clyna.ai",
        "content-type": "application/json",
      },
      root = `/v1/study/sets/${set}/generations`,
      before = await store.usage(user),
      previous = process.env.STUDYC_NOTES_ENABLED;
    process.env.STUDYC_NOTES_ENABLED = "false";
    try {
      expect(
        (
          await app.request(root, {
            method: "POST",
            headers,
            body: JSON.stringify({
              clientRequestId: randomUUID(),
              kind: "study_note",
              sources: [{ materialId: material, version: 1 }],
              config: { language: "zh-CN", sectionCount: 1 },
            }),
          })
        ).status,
      ).toBe(503);
      expect(
        (
          await app.request(`${root}/${jobId}/retry`, {
            method: "POST",
            headers,
            body: JSON.stringify({ clientRequestId: randomUUID() }),
          })
        ).status,
      ).toBe(503);
      expect(await store.usage(user)).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.STUDYC_NOTES_ENABLED;
      else process.env.STUDYC_NOTES_ENABLED = previous;
    }
  });
  it("guards HTTP session, CSRF, methods, JSON and payload limits", async () => {
    await succeed();
    const app = createApp(db, {
      releaseId: "notes-http",
      generationStore: store,
      rateLimitSecret: new Uint8Array(32).fill(8),
      sessionFetch: async () =>
        Response.json({ userId: user, csrfToken: "a".repeat(43) }),
    });
    const h = {
        cookie: "__Host-planplan-session=test",
        "X-PlanPlan-Expected-User": user,
        "X-CSRF-Token": "a".repeat(43),
        origin: "https://study.clyna.ai",
        "content-type": "application/json",
      },
      root = `/v1/study/sets/${set}/notes`;
    expect((await app.request(root)).status).toBe(401);
    expect(
      (await app.request(root, { headers: h, method: "DELETE" })).status,
    ).toBe(405);
    expect(
      (
        await app.request(root, {
          headers: { ...h, "X-CSRF-Token": "wrong" },
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(root, {
          headers: h,
          method: "POST",
          body: JSON.stringify({ x: "x".repeat(262145) }),
        })
      ).status,
    ).toBe(413);
    const res = await app.request(root, {
      headers: h,
      method: "POST",
      body: JSON.stringify({ clientRequestId: randomUUID(), jobId }),
    });
    expect(res.status).toBe(201);
    const { note } = await res.json();
    expect(
      (
        await app.request(`${root}/${note.id}`, {
          headers: h,
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(405);
    expect(
      (await app.request(`${root}?cursor=x&cursor=y`, { headers: h })).status,
    ).toBe(400);
  });
});
it("upgrades a genuine v8 registry without changing prior fingerprints and rejects v9 kind drift", async () => {
  const db = await openTestDb();
  try {
    const [u] = await db.query<{
      id: string;
    }>("INSERT INTO users(id) VALUES(DEFAULT) RETURNING id");
    const set = (
      await createStudySet(db, u!.id, {
        clientRequestId: randomUUID(),
        title: "旧学习集",
      })
    ).studySet;
    await db.exec(
      "DROP TABLE study_note_materializations; DROP TABLE study_note_origins; DROP TABLE study_notes; DELETE FROM studyc_schema_migrations WHERE version=9; ALTER TABLE study_generation_jobs DROP CONSTRAINT study_generation_jobs_kind_check; ALTER TABLE study_generation_jobs ADD CONSTRAINT study_generation_jobs_kind_check CHECK(kind IN ('study_outline','chat_answer','flashcards','quiz')); ",
    );
    const old = await db.query(
      "SELECT * FROM studyc_schema_migrations ORDER BY version",
    );

    await migrate(db);
    await migrate(db);
    await checkMigrations(db);
    expect(
      await db.query(
        "SELECT * FROM studyc_schema_migrations WHERE version<=8 ORDER BY version",
      ),
    ).toEqual(old);
    expect(
      await db.query("SELECT title FROM study_sets WHERE id=$1", [set.id]),
    ).toEqual([{ title: set.title }]);
    await db.exec(
      "ALTER TABLE study_generation_jobs DROP CONSTRAINT study_generation_jobs_kind_check; ALTER TABLE study_generation_jobs ADD CONSTRAINT study_generation_jobs_kind_check CHECK(kind IN ('study_outline','chat_answer','flashcards','quiz','study_note','bad_kind'))",
    );
    await expect(checkMigrations(db)).rejects.toThrow(/drift/);
  } finally {
    await db.close();
  }
}, 30000);
