import { randomUUID as id } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../src/db/db.js";
import { openTestDb, dropAdditionsAfter } from "./database.js";
import { FolderService } from "../src/services/folders.js";
import {
  createStudySet,
  createTextMaterial,
  getStudySet,
  getTextMaterial,
} from "../src/services/study-data.js";
import { FlashcardService } from "../src/services/flashcards.js";
import { migrate, checkMigrations } from "../src/db/migrations.js";
import { createApp } from "../src/api/app.js";
describe("first-level folders and independent assignment concurrency", () => {
  let db: Db,
    s: FolderService,
    user: string,
    bob: string,
    set: string,
    other: string,
    folder: string,
    target: string;
  beforeEach(async () => {
    db = await openTestDb();
    s = new FolderService(db);
    const users = await db.query<{ id: string }>(
      "INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id",
    );
    user = users[0]!.id;
    bob = users[1]!.id;
    set = (
      await createStudySet(db, user, {
        clientRequestId: id(),
        title: "原学习集",
      })
    ).studySet.id;
    other = (
      await createStudySet(db, user, {
        clientRequestId: id(),
        title: "另一个学习集",
      })
    ).studySet.id;
    folder = (await s.create(user, { clientRequestId: id(), title: "理科" }))
      .folder.id;
    target = (await s.create(user, { clientRequestId: id(), title: "复习" }))
      .folder.id;
  }, 30000);
  afterEach(async () => {
    await db?.close();
  });
  const move = (version: number, folderId: string | null) =>
    s.move(user, set, { clientRequestId: id(), version, folderId });
  it("starts existing sets in unfiled without writing assignment rows on reads", async () => {
    expect(await s.getAssignment(user, set)).toEqual({
      studySetId: set,
      folderId: null,
      folderTitle: null,
      version: 0,
    });
    expect(
      (await s.sets(user, "unfiled")).items.map((s) => s.id).sort(),
    ).toEqual([set, other].sort());
    expect(await db.query("SELECT * FROM study_folder_assignments")).toEqual(
      [],
    );
  });
  it("deduplicates create retries and rejects reused intent, nested folders and case-insensitive duplicate names", async () => {
    const input = { clientRequestId: id(), title: "新文件夹" };
    const a = await s.create(user, input);
    expect((await s.create(user, input)).folder.id).toBe(a.folder.id);
    await expect(
      s.create(user, { ...input, title: "别的" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await s.create(user, { clientRequestId: id(), title: "Math" });
    await expect(
      s.create(user, { clientRequestId: id(), title: " math " }),
    ).rejects.toMatchObject({ code: "job_conflict" });
    await expect(
      s.create(user, {
        clientRequestId: id(),
        title: "嵌套",
        parentFolderId: folder,
      }),
    ).rejects.toThrow();
    expect(
      (await s.create(bob, { clientRequestId: id(), title: "Math" })).folder.id,
    ).toBeTruthy();
  });
  it("changes only classification metadata, preserving set/material IDs, versions, body and learning events", async () => {
    const m = (
        await createTextMaterial(db, user, set, {
          clientRequestId: id(),
          title: "资料",
          body: "原文",
        })
      ).material,
      before = await getStudySet(db, user, set),
      f = new FlashcardService(db),
      d = (await f.create(user, set, { clientRequestId: id(), title: "卡组" }))
        .deck,
      c = (
        await f.addCard(user, set, d.id, {
          clientRequestId: id(),
          front: "问题",
          back: "答案",
        })
      ).card,
      a = (await f.start(user, set, d.id, { clientRequestId: id() })).session;
    await f.review(user, set, d.id, a.id, {
      clientRequestId: id(),
      version: a.version,
      position: 0,
      cardId: c.id,
      rating: "good",
    });
    const learning = await f.get(user, set, d.id);
    expect((await move(0, folder)).assignment.version).toBe(1);
    expect(await getStudySet(db, user, set)).toEqual(before);
    expect(await getTextMaterial(db, user, set, m.id)).toEqual(m);
    expect(await f.get(user, set, d.id)).toEqual(learning);
    expect((await s.sets(user, folder)).items).toMatchObject([
      { id: set, assignmentVersion: 1 },
    ]);
    expect((await s.get(user, folder)).setCount).toBe(1);
  });
  it("retains assignment versions through unfiled round trips and rejects stale ABA writes", async () => {
    let a = (await move(0, folder)).assignment;
    expect(a.version).toBe(1);
    a = (await move(a.version, null)).assignment;
    expect(a).toMatchObject({ version: 2, folderId: null });
    await expect(move(0, target)).rejects.toMatchObject({
      code: "version_conflict",
    });
    a = (await move(2, target)).assignment;
    expect(a).toMatchObject({ folderId: target, version: 3 });
  });
  it("replays a saved move without reapplying it over a later user choice", async () => {
    const input = { clientRequestId: id(), version: 0, folderId: folder };
    await s.move(user, set, input);
    await move(1, target);
    const old = await s.move(user, set, input);
    expect(old.replayed).toBe(true);
    expect(old.assignment).toMatchObject({ version: 2, folderId: target });
    await expect(
      s.move(user, set, { ...input, folderId: null }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("preserves all sets and histories when removing a folder and replays the exact removal result", async () => {
    await move(0, folder);
    await s.move(user, other, {
      clientRequestId: id(),
      version: 0,
      folderId: folder,
    });
    const input = { clientRequestId: id(), version: 1 },
      first = await s.remove(user, folder, input);
    expect(first.movedSets).toBe(2);
    expect(await s.remove(user, folder, input)).toMatchObject({
      movedSets: 2,
      replayed: true,
    });
    await expect(s.get(user, folder)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await s.getAssignment(user, set)).folderId).toBe(null);
    expect((await s.getAssignment(user, set)).version).toBe(2);
    expect((await s.sets(user, "unfiled")).items).toHaveLength(2);
    expect((await getStudySet(db, user, set)).id).toBe(set);
  });
  it("does not resurrect a deleted folder by replaying its original create request", async () => {
    const input = { clientRequestId: id(), title: "临时" };
    const f = (await s.create(user, input)).folder;
    await s.remove(user, f.id, { clientRequestId: id(), version: f.version });
    await expect(s.create(user, input)).rejects.toMatchObject({
      code: "job_conflict",
    });
    expect(
      (await s.create(user, { clientRequestId: id(), title: "临时" })).folder
        .id,
    ).not.toBe(f.id);
  });
  it("isolates folder IDs, set assignments, membership lists, mutation and cursors by owner", async () => {
    await move(0, folder);
    for (const call of [
      s.get(bob, folder),
      s.sets(bob, folder),
      s.getAssignment(bob, set),
      s.move(bob, set, { clientRequestId: id(), version: 1, folderId: null }),
      s.list(bob, folder),
    ])
      await expect(call).rejects.toMatchObject({ code: "not_found" });
    const foreign = (
      await s.create(bob, { clientRequestId: id(), title: "B文件夹" })
    ).folder;
    await expect(move(1, foreign.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await s.list(bob)).items).toHaveLength(1);
  });
  it("requires the current folder version for rename/removal and keeps stale names from overwriting updates", async () => {
    await s.rename(user, folder, {
      clientRequestId: id(),
      version: 1,
      title: "新名称",
    });
    await expect(
      s.rename(user, folder, {
        clientRequestId: id(),
        version: 1,
        title: "覆盖",
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      s.remove(user, folder, { clientRequestId: id(), version: 1 }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect((await s.get(user, folder)).title).toBe("新名称");
  });
  it("paginates owned folders/sets and rejects a cursor whose membership moved away", async () => {
    for (let i = 0; i < 21; i++)
      await s.create(user, { clientRequestId: id(), title: "文件夹 " + i });
    const first = await s.list(user),
      second = await s.list(user, first.nextCursor!);
    expect(first.items).toHaveLength(20);
    expect(
      new Set([...first.items, ...second.items].map((f) => f.id)).size,
    ).toBe(23);
    await move(0, folder);
    await expect(s.sets(user, "unfiled", set)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
  it("disables writes while leaving classifications and contents readable", async () => {
    await move(0, folder);
    const previous = process.env.STUDYC_FOLDERS_ENABLED;
    process.env.STUDYC_FOLDERS_ENABLED = "false";
    try {
      expect((await s.list(user)).enabled).toBe(false);
      expect((await s.sets(user, folder)).items).toHaveLength(1);
      await expect(move(1, null)).rejects.toMatchObject({
        code: "service_unavailable",
      });
      await expect(
        s.remove(user, folder, { clientRequestId: id(), version: 1 }),
      ).rejects.toMatchObject({ code: "service_unavailable" });
    } finally {
      if (previous === undefined) delete process.env.STUDYC_FOLDERS_ENABLED;
      else process.env.STUDYC_FOLDERS_ENABLED = previous;
    }
  });
  it("guards HTTP auth, methods, CSRF, nested input and write size", async () => {
    const app = createApp(db, {
        releaseId: "folders-http",
        rateLimitSecret: new Uint8Array(32).fill(8),
        sessionFetch: async () =>
          Response.json({ userId: user, csrfToken: "a".repeat(43) }),
      }),
      root = "/v1/study/folders",
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
          body: JSON.stringify({ x: "x".repeat(17000) }),
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
          body: JSON.stringify({ clientRequestId: id(), title: "HTTP文件夹" }),
        })
      ).status,
    ).toBe(201);
  });
  it("preserves earlier registry and learning data during v11 upgrade and detects title-guard drift", async () => {
    await dropAdditionsAfter(db, 11);
    const old = await db.query(
      "SELECT * FROM studyc_schema_migrations ORDER BY version",
    );
    await migrate(db);
    await migrate(db);
    await checkMigrations(db);
    expect(
      await db.query(
        "SELECT * FROM studyc_schema_migrations WHERE version<=11 ORDER BY version",
      ),
    ).toEqual(old);
    expect((await getStudySet(db, user, set)).id).toBe(set);
    await db.exec("DROP INDEX folders_owner_title");
    await expect(checkMigrations(db)).rejects.toThrow(/drift/);
  });
  it("cascades folder metadata on account deletion and denies deleted identities", async () => {
    await move(0, folder);
    await db.query("UPDATE users SET deleted_at=now() WHERE id=$1", [user]);
    await expect(s.getAssignment(user, set)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await db.query("DELETE FROM users WHERE id=$1", [user]);
    for (const table of [
      "study_folders",
      "study_folder_assignments",
      "study_folder_requests",
    ])
      expect(
        await db.query(`SELECT * FROM ${table} WHERE user_id=$1`, [user]),
      ).toEqual([]);
  });
});
