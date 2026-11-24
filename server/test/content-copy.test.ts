import { it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID as id } from "node:crypto";
import type { Db } from "../src/db/db.js";
import { openTestDb, dropAdditionsAfter } from "./database.js";
import { ContentCopyService } from "../src/services/content-copy.js";
import { TrashService } from "../src/services/trash.js";
import {
  createStudySet,
  createTextMaterial,
  getTextMaterial,
  updateTextMaterial,
} from "../src/services/study-data.js";
import { migrate, checkMigrations } from "../src/db/migrations.js";
let db: Db,
  user: string,
  bob: string,
  set: string,
  material: string,
  s: ContentCopyService;
beforeEach(async () => {
  db = await openTestDb();
  const users = await db.query<{ id: string }>(
    "INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id",
  );
  user = users[0]!.id;
  bob = users[1]!.id;
  set = (
    await createStudySet(db, user, {
      clientRequestId: id(),
      title: "来源学习集",
    })
  ).studySet.id;
  material = (
    await createTextMaterial(db, user, set, {
      clientRequestId: id(),
      title: "来源文本",
      body: "正文\n😀",
    })
  ).material.id;
  s = new ContentCopyService(db);
}, 30000);
afterEach(async () => {
  delete process.env.STUDYC_COPY_ENABLED;
  await db.close();
});
const input = () => ({
  clientRequestId: id(),
  sourceSetId: set,
  sourceVersion: 1,
  materials: [{ id: material, version: 1 }],
  target: { kind: "new_set", title: "独立副本" },
});
it("copies exactly selected current text with new IDs and stable provenance, independently editable", async () => {
  const before = await getTextMaterial(db, user, set, material),
    a = await s.copy(user, input());
  expect(a.targetSetId).not.toBe(set);
  expect(a.mappings).toHaveLength(1);
  const m = a.mappings[0];
  expect(m).toMatchObject({ sourceMaterialId: material, sourceVersion: 1 });
  expect(m.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(m.targetMaterialId).not.toBe(material);
  const copy = await getTextMaterial(
    db,
    user,
    a.targetSetId,
    m.targetMaterialId,
  );
  expect(copy.body).toBe(before.body);
  expect(copy.title).toBe(before.title);
  await updateTextMaterial(db, user, a.targetSetId, copy.id, {
    version: 1,
    body: "独立修改",
  });
  expect(await getTextMaterial(db, user, set, material)).toEqual(before);
  for (const table of [
    "study_flashcard_decks",
    "study_quizzes",
    "study_notes",
    "study_plans",
  ])
    expect(
      await db.query(`SELECT id FROM ${table} WHERE study_set_id=$1`, [
        a.targetSetId,
      ]),
    ).toHaveLength(0);
});
it("replays one intent without recopying and cannot recreate a trashed target", async () => {
  const command = input(),
    a = await s.copy(user, command),
    b = await s.copy(user, command);
  expect(b).toEqual({ ...a, replayed: true });
  await expect(
    s.copy(user, { ...command, target: { kind: "new_set", title: "变化" } }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await new TrashService(db).change(user, a.targetSetId, {
    clientRequestId: id(),
    version: 0,
    deleted: true,
  });
  await expect(s.copy(user, command)).rejects.toMatchObject({
    code: "not_found",
  });
  expect(await db.query("SELECT * FROM study_copy_requests")).toHaveLength(1);
});
it("rejects changed/deleted/mixed-account sources and target without partial inserts", async () => {
  await updateTextMaterial(db, user, set, material, {
    version: 1,
    body: "来源变化",
  });
  await expect(s.copy(user, input())).rejects.toMatchObject({
    code: "version_conflict",
  });
  expect(await db.query("SELECT * FROM study_copy_requests")).toHaveLength(0);
  await expect(s.preview(bob, set)).rejects.toMatchObject({
    code: "not_found",
  });
  const foreign = (
    await createStudySet(db, bob, { clientRequestId: id(), title: "其他账户" })
  ).studySet.id;
  await expect(
    s.copy(user, {
      ...input(),
      materials: [{ id: material, version: 2 }],
      target: { kind: "existing_set", id: foreign },
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  await new TrashService(db).change(user, set, {
    clientRequestId: id(),
    version: 0,
    deleted: true,
  });
  await expect(s.preview(user, set)).rejects.toMatchObject({
    code: "not_found",
  });
});
it("permits explicit empty new set, selected material preview, and existing-set copy", async () => {
  const preview = await s.preview(user, set, material);
  expect(preview.items).toHaveLength(1);
  expect(preview.items[0]).not.toHaveProperty("body");
  const target = (await s.copy(user, { ...input(), materials: [] }))
    .targetSetId;
  const copied = await s.copy(user, {
    ...input(),
    target: { kind: "existing_set", id: target },
  });
  expect(copied.targetSetId).toBe(target);
  expect(copied.mappings).toHaveLength(1);
  await expect(
    s.copy(user, {
      ...input(),
      materials: [
        { id: material, version: 1 },
        { id: material, version: 1 },
      ],
    }),
  ).rejects.toThrow();
});
it("keeps preview when disabled and supports additive v13 migration", async () => {
  await dropAdditionsAfter(db, 13);
  await migrate(db);
  await migrate(db);
  await checkMigrations(db);
  process.env.STUDYC_COPY_ENABLED = "false";
  expect((await s.preview(user, set)).enabled).toBe(false);
  await expect(s.copy(user, input())).rejects.toMatchObject({
    code: "service_unavailable",
  });
});
it("applies preview limit and rejects oversized batches atomically", async () => {
  await db.query(
    "INSERT INTO study_materials(user_id,study_set_id,title,body,client_request_id,creation_digest) SELECT $1,$2,'记录'||i,'文本',gen_random_uuid(),repeat('a',64) FROM generate_series(1,101)i",
    [user, set],
  );
  expect((await s.preview(user, set)).items).toHaveLength(100);
  expect((await s.preview(user, set)).hasMore).toBe(true);
  await expect(
    s.copy(user, {
      ...input(),
      materials: Array.from({ length: 101 }, () => ({ id: id(), version: 1 })),
    }),
  ).rejects.toThrow();
  expect(await db.query("SELECT * FROM study_copy_requests")).toHaveLength(0);
});
it("enforces HTTP authentication, CSRF, read-only preview methods and bounded commands", async () => {
  const { createApp } = await import("../src/api/app.js"),
    app = createApp(db, {
      releaseId: "copy-test",
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
  expect((await app.request("/v1/study/copies")).status).toBe(401);
  expect((await app.request("/v1/study/copies", { headers })).status).toBe(405);
  expect(
    (
      await app.request("/v1/study/copies", {
        headers: { ...headers, "X-CSRF-Token": "wrong" },
        method: "POST",
        body: JSON.stringify(input()),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request("/v1/study/copies", {
        headers,
        method: "POST",
        body: JSON.stringify(input()),
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await app.request("/v1/study/copies", {
        headers,
        method: "POST",
        body: JSON.stringify({ x: "x".repeat(33000) }),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await app.request(
        "/v1/study/sets/" +
          set +
          "/copy-preview?materialId=" +
          material +
          "&materialId=" +
          id(),
        { headers },
      )
    ).status,
  ).toBe(400);
});
