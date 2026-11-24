import { it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID as id } from "node:crypto";
import type { Db } from "../src/db/db.js";
import { openTestDb, dropAdditionsAfter } from "./database.js";
import { LocalImportService } from "../src/services/local-import.js";
import { TrashService } from "../src/services/trash.js";
import {
  createStudySet,
  getTextMaterial,
  updateTextMaterial,
} from "../src/services/study-data.js";
import { migrate, checkMigrations } from "../src/db/migrations.js";
let db: Db, user: string, bob: string, set: string, s: LocalImportService;
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
      title: "明确的导入归属",
    })
  ).studySet.id;
  s = new LocalImportService(db);
}, 30000);
afterEach(async () => {
  delete process.env.STUDYC_IMPORT_ENABLED;
  await db.close();
});
const item = (sourceIndex = 0) => ({
    sourceKey: "sf-k12:uploads",
    sourceIndex,
    title: "本机旧文本",
    body: "完整旧原文\n😀",
  }),
  input = () => ({
    clientRequestId: id(),
    sourceAccountId: user,
    targetSetId: set,
    items: [item()],
  });
it("imports each selected record with new stable material ID and does not infer any set", async () => {
  const r = await s.import(user, input());
  expect(r.targetSetId).toBe(set);
  expect(r.items[0]).toMatchObject({
    sourceKey: "sf-k12:uploads",
    sourceIndex: 0,
    status: "imported",
  });
  expect(
    (await getTextMaterial(db, user, set, r.items[0].materialId)).body,
  ).toBe(item().body);
  expect(
    await db.query("SELECT * FROM study_sets WHERE user_id=$1", [user]),
  ).toHaveLength(1);
});
it("deduplicates across independent exports and requests, preserving subsequent cloud edits", async () => {
  const command = input(),
    a = await s.import(user, command);
  expect(await s.import(user, command)).toEqual({ ...a, replayed: true });
  await updateTextMaterial(db, user, set, a.items[0].materialId, {
    version: 1,
    body: "云端编辑保留",
  });
  const again = await s.import(user, input());
  expect(again.items[0]).toMatchObject({
    materialId: a.items[0].materialId,
    status: "already_imported",
  });
  expect(
    (await getTextMaterial(db, user, set, a.items[0].materialId)).body,
  ).toBe("云端编辑保留");
  expect(
    await db.query("SELECT * FROM study_materials WHERE user_id=$1", [user]),
  ).toHaveLength(1);
  await expect(
    s.import(user, { ...command, items: [{ ...item(), body: "变化" }] }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
});
it("keeps identical records at different source indices distinct, and fingerprints changed source explicitly", async () => {
  const a = await s.import(user, { ...input(), items: [item(0), item(1)] });
  expect(a.items[0].materialId).not.toBe(a.items[1].materialId);
  const changed = await s.import(user, {
    ...input(),
    items: [{ ...item(), body: "后来更新的旧原文" }],
  });
  expect(changed.items[0].status).toBe("imported");
  expect(await db.query("SELECT * FROM study_import_items")).toHaveLength(3);
});
it("binds dedup to explicit target, rejects other accounts and trashed targets", async () => {
  const a = await s.import(user, input()),
    target = (
      await createStudySet(db, user, {
        clientRequestId: id(),
        title: "另一明确归属",
      })
    ).studySet.id;
  const b = await s.import(user, { ...input(), targetSetId: target });
  expect(b.items[0].materialId).not.toBe(a.items[0].materialId);
  await expect(
    s.import(user, { ...input(), sourceAccountId: bob }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    s.import(bob, { ...input(), sourceAccountId: bob }),
  ).rejects.toMatchObject({ code: "not_found" });
  await new TrashService(db).change(user, set, {
    clientRequestId: id(),
    version: 0,
    deleted: true,
  });
  await expect(s.import(user, input())).rejects.toMatchObject({
    code: "not_found",
  });
});
it("rejects damaged/unknown/duplicate/oversized selected records atomically", async () => {
  for (const items of [
    [item(), { ...item(1), body: 3 }],
    [{ ...item(), sourceKey: "sf-k12:cloud-draft:x" }],
    [item(), item()],
    [{ ...item(), body: "字".repeat(350000) }],
    [{ ...item(), title: "x".repeat(121) }],
  ])
    await expect(s.import(user, { ...input(), items })).rejects.toThrow();
  expect(await db.query("SELECT * FROM study_materials")).toHaveLength(0);
  expect(await db.query("SELECT * FROM study_import_requests")).toHaveLength(0);
});
it("supports additive v14 migration, read-only closure and account deletion cascade", async () => {
  await dropAdditionsAfter(db, 14);
  await migrate(db);
  await migrate(db);
  await checkMigrations(db);
  await s.import(user, input());
  process.env.STUDYC_IMPORT_ENABLED = "false";
  await expect(s.import(user, input())).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect(await db.query("SELECT * FROM study_import_items")).toHaveLength(1);
  await db.query("DELETE FROM users WHERE id=$1", [user]);
  expect(await db.query("SELECT * FROM study_import_items")).toHaveLength(0);
  expect(await db.query("SELECT * FROM study_import_requests")).toHaveLength(0);
});
it("enforces HTTP authentication, CSRF, allowed methods and actual upload bytes", async () => {
  const { createApp } = await import("../src/api/app.js"),
    app = createApp(db, {
      releaseId: "import-test",
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
  expect((await app.request("/v1/study/imports")).status).toBe(401);
  expect((await app.request("/v1/study/imports", { headers })).status).toBe(
    405,
  );
  expect(
    (
      await app.request("/v1/study/imports", {
        headers: { ...headers, "X-CSRF-Token": "wrong" },
        method: "POST",
        body: JSON.stringify(input()),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request("/v1/study/imports", {
        headers,
        method: "POST",
        body: JSON.stringify(input()),
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await app.request("/v1/study/imports", {
        headers,
        method: "POST",
        body: JSON.stringify({ x: "x".repeat(2 * 1024 * 1024) }),
      })
    ).status,
  ).toBe(413);
  process.env.STUDYC_IMPORT_ENABLED = "false";
  expect(
    await (await app.request("/v1/study/imports/status", { headers })).json(),
  ).toEqual({ enabled: false });
});
