import { randomUUID as id } from "node:crypto";
import { it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../src/db/db.js";
import { openTestDb, dropAdditionsAfter } from "./database.js";
import { migrate, checkMigrations } from "../src/db/migrations.js";
import { TrashService } from "../src/services/trash.js";
import { FolderService } from "../src/services/folders.js";
import { SearchService } from "../src/services/search.js";
import {
  createStudySet,
  createTextMaterial,
  getStudySet,
  getTextMaterial,
  listStudySets,
  updateStudySet,
  updateTextMaterial,
} from "../src/services/study-data.js";
import { FlashcardService } from "../src/services/flashcards.js";
import { NoteService } from "../src/services/notes.js";
let db: Db,
  user: string,
  bob: string,
  set: string,
  material: string,
  s: TrashService;
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
      title: "生命周期验收",
    })
  ).studySet.id;
  material = (
    await createTextMaterial(db, user, set, {
      clientRequestId: id(),
      title: "原文",
      body: "保留此文本",
    })
  ).material.id;
  s = new TrashService(db);
}, 30000);
afterEach(async () => {
  delete process.env.STUDYC_TRASH_ENABLED;
  await db.close();
});
const change = (version: number, deleted: boolean, request = id()) =>
  s.change(user, set, { clientRequestId: request, version, deleted });
it("hides parents and every scoped read/write, keeps IDs and restores original content", async () => {
  const original = await getTextMaterial(db, user, set, material);
  await change(0, true);
  expect((await listStudySets(db, user, { limit: 20 })).items).toEqual([]);
  for (const run of [
    () => getStudySet(db, user, set),
    () => getTextMaterial(db, user, set, material),
    () => updateStudySet(db, user, set, { version: 1, title: "不得保存" }),
    () =>
      createTextMaterial(db, user, set, {
        clientRequestId: id(),
        title: "不得新增",
        body: "",
      }),
    () =>
      updateTextMaterial(db, user, set, material, {
        version: 1,
        body: "不得修改",
      }),
    () => new FlashcardService(db).list(user, set),
    () => new NoteService(db).list(user, set),
  ])
    await expect(run()).rejects.toMatchObject({ code: "not_found" });
  expect(
    (await new SearchService(db).search(user, { q: "生命周期" })).items,
  ).toHaveLength(0);
  expect((await s.list(user)).items).toHaveLength(1);
  expect((await s.list(bob)).items).toHaveLength(0);
  await change(1, false);
  expect(await getTextMaterial(db, user, set, material)).toEqual(original);
  expect((await s.get(user, set)).version).toBe(2);
});
it("preserves folder association, hides counts, and restores unfiled if folder removed", async () => {
  const f = new FolderService(db),
    folder = (await f.create(user, { clientRequestId: id(), title: "归档" }))
      .folder;
  await f.move(user, set, {
    clientRequestId: id(),
    version: 0,
    folderId: folder.id,
  });
  await change(0, true);
  expect((await f.get(user, folder.id)).setCount).toBe(0);
  expect((await f.sets(user, folder.id)).items).toHaveLength(0);
  await change(1, false);
  expect((await f.getAssignment(user, set)).folderId).toBe(folder.id);
  await change(2, true);
  await f.remove(user, folder.id, {
    clientRequestId: id(),
    version: folder.version,
  });
  await change(3, false);
  expect((await f.getAssignment(user, set)).folderId).toBeNull();
});
it("does not replay stale commands across restore or advance an ABA version", async () => {
  const request = id();
  await change(0, true, request);
  await change(1, false);
  expect((await change(0, true, request)).item.deletedAt).toBeNull();
  await expect(change(0, true)).rejects.toMatchObject({
    code: "version_conflict",
  });
  await expect(change(2, true, request)).rejects.toMatchObject({
    code: "idempotency_conflict",
  });
  await expect(
    s.change(bob, set, { clientRequestId: id(), version: 2, deleted: true }),
  ).rejects.toMatchObject({ code: "not_found" });
});
it("read-only flag preserves trash listing and rejects restore without data loss", async () => {
  await change(0, true);
  process.env.STUDYC_TRASH_ENABLED = "false";
  expect((await s.list(user)).enabled).toBe(false);
  await expect(change(1, false)).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect((await s.get(user, set)).deletedAt).not.toBeNull();
});
it("adds lifecycle metadata to existing v12 data and migrates idempotently", async () => {
  await dropAdditionsAfter(db, 12);
  await migrate(db);
  await migrate(db);
  await checkMigrations(db);
  expect((await s.get(user, set)).version).toBe(0);
  expect((await getTextMaterial(db, user, set, material)).body).toBe(
    "保留此文本",
  );
});
it("hides linked calendar events and conflicts until restore, without cancelling manual events", async () => {
  const { PlanService } = await import("../src/services/plans.js"),
    { CalendarService } = await import("../src/services/calendar.js");
  const p = new PlanService(db),
    c = new CalendarService(db),
    plan = (
      await p.create(user, set, { clientRequestId: id(), title: "原计划" })
    ).plan;
  const task = (
    await p.createTask(user, set, plan.id, {
      clientRequestId: id(),
      title: "原任务",
    })
  ).task;
  const event = (
    await c.create(user, {
      clientRequestId: id(),
      title: "原日程",
      kind: "study",
      description: "",
      time: { kind: "all_day", date: "2026-12-01" },
      sourceTask: { studySetId: set, planId: plan.id, taskId: task.id },
    })
  ).event;
  expect(
    (await c.list(user, { from: "2026-12-01", to: "2026-12-01" })).items,
  ).toHaveLength(1);
  await change(0, true);
  expect(
    (await c.list(user, { from: "2026-12-01", to: "2026-12-01" })).items,
  ).toHaveLength(0);
  await expect(c.get(user, event.id)).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(p.get(user, set, plan.id)).rejects.toMatchObject({
    code: "not_found",
  });
  await change(1, false);
  expect((await c.get(user, event.id)).id).toBe(event.id);
});
it("guards HTTP methods, CSRF, account ownership and bounded lifecycle writes", async () => {
  const { createApp } = await import("../src/api/app.js"),
    app = createApp(db, {
      releaseId: "trash-test",
      rateLimitSecret: new Uint8Array(32).fill(8),
      sessionFetch: async () =>
        Response.json({ userId: user, csrfToken: "a".repeat(43) }),
    }),
    root = "/v1/study/trash",
    headers = {
      cookie: "__Host-planplan-session=test",
      "X-PlanPlan-Expected-User": user,
      "X-CSRF-Token": "a".repeat(43),
      origin: "https://study.clyna.ai",
      "content-type": "application/json",
    };
  expect((await app.request(root)).status).toBe(401);
  expect((await app.request(root, { headers, method: "DELETE" })).status).toBe(
    405,
  );
  expect(
    (
      await app.request(root + "/" + set, {
        headers: { ...headers, "X-CSRF-Token": "wrong" },
        method: "PATCH",
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(root + "/" + set, {
        headers,
        method: "PATCH",
        body: JSON.stringify({
          clientRequestId: id(),
          version: 0,
          deleted: true,
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    (await app.request("/v1/study/sets/" + set + "/materials", { headers }))
      .status,
  ).toBe(404);
  expect(
    (
      await app.request(root + "/" + set, {
        headers,
        method: "PATCH",
        body: JSON.stringify({ x: "x".repeat(17000) }),
      })
    ).status,
  ).toBe(413);
});
