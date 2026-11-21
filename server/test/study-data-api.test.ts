import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openTestDb } from './database.js';
import type { Db, Transaction } from '../src/db/db.js';
import { createApp } from '../src/api/app.js';
import { SharedRateLimiter } from '../src/runtime/rate-limit.js';

const origin = 'https://study.clyna.ai';
const csrfToken = 's'.repeat(43);
const rateSecret = new TextEncoder().encode('studyc-isolated-test-shared-rate-secret');
type Browser = { userId: string; headers: Record<string, string> };
type App = ReturnType<typeof createApp>;
const setsPath = '/v1/study/sets';
const materialPath = (setId: string) => `${setsPath}/${setId}/materials`;
const write = (app: App, browser: Browser, path: string, body: unknown, method = 'POST', headers: Record<string, string> = {}) => app.request(path, {
 method, headers: { ...browser.headers, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const read = (app: App, browser: Browser, path: string) => app.request(path, { headers: browser.headers });
function makeApp(db: Db) {
 const sessionFetch: typeof fetch = async (_url, init) => {
  const cookie = new Headers(init?.headers).get('cookie') ?? '';
  const userId = cookie.split('=')[1];
  const [user] = await db.query<{id:string}>('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL',[userId]);
  return user ? Response.json({userId:user.id,csrfToken}) : Response.json({error:{code:'unauthorized'}},{status:401});
 };
 return createApp(db,{releaseId:'test-studyc',rateLimitSecret:rateSecret,sessionFetch});
}
async function browser(db: Db): Promise<Browser> {
 const [user] = await db.query<{id:string}>('INSERT INTO users DEFAULT VALUES RETURNING id');
 return {userId:user!.id,headers:{origin,cookie:`__Host-planplan-session=${user!.id}`,'X-PlanPlan-Expected-User':user!.id,'X-CSRF-Token':csrfToken}};
}
// Models the external identity owner's lifecycle. StudyC does not expose this operation.
async function requestAccountDeletion(db: Db,userId:string) {
 await db.tx(async q=>{await q.query('UPDATE users SET deleted_at=now() WHERE id=$1',[userId]);await q.query('DELETE FROM users WHERE id=$1',[userId]);},userId);
 return {status:'completed'};
}
async function createSet(app: App, user: Browser, title = '数学') {
  const response = await write(app, user, setsPath, { clientRequestId: randomUUID(), title });
  expect(response.status).toBe(201);
  return (await response.json()).studySet;
}
async function createMaterial(app: App, user: Browser, setId: string, body = '自有资料\n第二行😀', title = '笔记') {
  const response = await write(app, user, materialPath(setId), { clientRequestId: randomUUID(), title, body });
  expect(response.status).toBe(201);
  return (await response.json()).material;
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toMatchObject({ error: { code } });
}

describe('StudyC authenticated study sets and text materials (AC-01–08, AC-11–12)', () => {
  let db: Db;
  let app: App;
  let alice: Browser;
  let bob: Browser;
  beforeAll(async () => { db = await openTestDb(); app = makeApp(db); }, 30_000);
  beforeEach(async () => { alice = await browser(db); bob = await browser(db); });
  afterAll(async () => { await db.close(); });

  it('AC-01 creates independent same-title sets and renames by ID with server-owned fields', async () => {
    const first = await createSet(app, alice, '  数学  ');
    const second = await createSet(app, alice, '数学');
    expect(first.id).not.toBe(second.id);
    expect(first.title).toBe('数学');
    expect(Object.keys(first).sort()).toEqual(['id', 'title', 'version', 'createdAt', 'updatedAt'].sort());
    expect(first.version).toBe(1);
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const updated = await write(app, alice, `${setsPath}/${first.id}`, { version: 1, title: '几何' }, 'PATCH');
    expect(updated.status).toBe(200);
    expect((await updated.json()).studySet).toMatchObject({ id: first.id, title: '几何', version: 2, createdAt: first.createdAt });
    expect((await (await read(app, alice, `${setsPath}/${second.id}`)).json()).studySet.title).toBe('数学');
    const list = await read(app, alice, setsPath);
    expect(list.headers.get('cache-control')).toBe('private, no-store');
    expect((await list.json()).items.map((item: { id: string }) => item.id)).toEqual([second.id, first.id]);
  });

  it('AC-02 preserves literal plain text, blank notes, independent membership and metadata-only lists', async () => {
    const a1 = await createSet(app, alice);
    const a2 = await createSet(app, alice, '历史');
    const body = '线段共有21条。\n  保留空格 😀\r\n<script>只是文本</script>';
    const material = await createMaterial(app, alice, a1.id, body, '  几何笔记  ');
    const other = await createMaterial(app, alice, a2.id, '这是一段历史资料。');
    expect(material).toMatchObject({ studySetId: a1.id, title: '几何笔记', body, format: 'plain_text', version: 1 });
    expect(Object.keys(material).sort()).toEqual(['id', 'studySetId', 'title', 'body', 'format', 'version', 'createdAt', 'updatedAt'].sort());
    expect((await (await read(app, alice, `${materialPath(a1.id)}/${material.id}`)).json()).material.body).toBe(body);
    expect((await (await read(app, alice, materialPath(a2.id))).json()).items.map((item: { id: string }) => item.id)).toEqual([other.id]);
    const listed = (await (await read(app, alice, materialPath(a1.id))).json()).items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('body');
    const empty = await createMaterial(app, alice, a1.id, '');
    expect(empty.body).toBe('');
    const update = await write(app, alice, `${materialPath(a1.id)}/${material.id}`, { version: 1, body: '' }, 'PATCH');
    expect(update.status).toBe(200);
    expect((await update.json()).material).toMatchObject({ body: '', title: '几何笔记', version: 2 });
  });

  it('AC-03 rejects other owners and wrong parent paths for every list/get/write operation', async () => {
    const a1 = await createSet(app, alice);
    const a2 = await createSet(app, alice);
    const b1 = await createSet(app, bob);
    const b2 = await createSet(app, bob);
    const note = await createMaterial(app, alice, a1.id);
    const foreignPaths = [`${setsPath}/${a1.id}`, materialPath(a1.id), `${materialPath(a1.id)}/${note.id}`];
    for (const path of foreignPaths) await error(await read(app, bob, path), 404, 'not_found');
    await error(await write(app, bob, `${setsPath}/${a1.id}`, { version: 1, title: 'hijack' }, 'PATCH'), 404, 'not_found');
    await error(await write(app, bob, materialPath(a1.id), { clientRequestId: randomUUID(), title: 'hijack', body: '' }), 404, 'not_found');
    await error(await write(app, bob, `${materialPath(a1.id)}/${note.id}`, { version: 1, body: 'hijack' }, 'PATCH'), 404, 'not_found');
    await error(await read(app, alice, `${materialPath(a2.id)}/${note.id}`), 404, 'not_found');
    await error(await write(app, alice, `${materialPath(a2.id)}/${note.id}`, { version: 1, body: 'wrong parent' }, 'PATCH'), 404, 'not_found');
    await error(await read(app, alice, materialPath(randomUUID())), 404, 'not_found');
    expect(new Set((await (await read(app, bob, setsPath)).json()).items.map((item: { id: string }) => item.id))).toEqual(new Set([b1.id, b2.id]));
    expect((await (await read(app, alice, `${materialPath(a1.id)}/${note.id}`)).json()).material.body).toBe(note.body);
  });

  it('AC-04 enforces Cookie, expected account, Origin and CSRF without accepting owner fields', async () => {
    await error(await app.request(setsPath), 401, 'unauthorized');
    for (const expected of ['', bob.userId]) {
      const wrong = { ...alice, headers: { ...alice.headers, 'X-PlanPlan-Expected-User': expected } };
      await error(await read(app, wrong, setsPath), 409, 'account_mismatch');
      await error(await write(app, wrong, setsPath, { clientRequestId: randomUUID(), title: 'x' }), 409, 'account_mismatch');
    }
    const badHeaders: Record<string, string>[] = [{ 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'bad' }, { origin: '' }, { origin: 'https://other.test' }];
    for (const headers of badHeaders) {
      await error(await write(app, alice, setsPath, { clientRequestId: randomUUID(), title: 'x' }, 'POST', headers), 403,
        'origin' in headers ? 'origin_forbidden' : 'csrf_invalid');
    }
    for (const ownerField of ['ownerId', 'owner_id', 'userId', 'user_id', 'id', 'createdAt']) {
      await error(await write(app, alice, setsPath, { clientRequestId: randomUUID(), title: 'x', [ownerField]: bob.userId }), 400, 'invalid_input');
    }
    expect((await (await read(app, alice, setsPath)).json()).items).toEqual([]);
  });

  it('AC-05 deduplicates simultaneous creates and returns the current version after a rename', async () => {
    const input = { clientRequestId: randomUUID(), title: '  数学  ' };
    const responses = await Promise.all([write(app, alice, setsPath, input), write(app, alice, setsPath, input)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
    const items = await Promise.all(responses.map(async r => (await r.json()).studySet));
    expect(items[0].id).toBe(items[1].id);
    const id = items[0].id;
    expect((await write(app, alice, `${setsPath}/${id}`, { version: 1, title: '改名' }, 'PATCH')).status).toBe(200);
    const replay = await write(app, alice, setsPath, { title: '数学', clientRequestId: input.clientRequestId.toUpperCase() });
    expect(replay.status).toBe(200);
    expect((await replay.json()).studySet).toMatchObject({ id, title: '改名', version: 2 });
    await error(await write(app, alice, setsPath, { ...input, title: '另一意图' }), 409, 'idempotency_conflict');
    const independent = await write(app, bob, setsPath, input);
    expect(independent.status).toBe(201);
    expect((await independent.json()).studySet.id).not.toBe(id);
    expect((await (await read(app, alice, setsPath)).json()).items).toHaveLength(1);
  });

  it('AC-05 material idempotency binds the original text and parent, independently per owner', async () => {
    const a1 = await createSet(app, alice);
    const a2 = await createSet(app, alice);
    const b1 = await createSet(app, bob);
    const input = { clientRequestId: randomUUID(), title: ' 笔记 ', body: '同一正文\n ' };
    const responses = await Promise.all([write(app, alice, materialPath(a1.id), input), write(app, alice, materialPath(a1.id), input)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
    const ids = await Promise.all(responses.map(async r => (await r.json()).material.id));
    expect(ids[0]).toBe(ids[1]);
    await error(await write(app, alice, materialPath(a1.id), { ...input, body: '同一正文\n' }), 409, 'idempotency_conflict');
    await error(await write(app, alice, materialPath(a2.id), input), 409, 'idempotency_conflict');
    const own = await write(app, bob, materialPath(b1.id), input);
    expect(own.status).toBe(201);
    expect((await own.json()).material.id).not.toBe(ids[0]);
    expect((await write(app, alice, `${materialPath(a1.id)}/${ids[0]}`, { version: 1, body: '新正文' }, 'PATCH')).status).toBe(200);
    const replay = await write(app, alice, materialPath(a1.id), { body: input.body, title: '笔记', clientRequestId: input.clientRequestId });
    expect(replay.status).toBe(200);
    expect((await replay.json()).material).toMatchObject({ id: ids[0], body: '新正文', version: 2 });
  });

  it('AC-06 allows exactly one concurrent update at a version for sets and materials', async () => {
    const set = await createSet(app, alice);
    const note = await createMaterial(app, alice, set.id);
    for (const [path, left, right] of [
      [`${setsPath}/${set.id}`, { version: 1, title: '左' }, { version: 1, title: '右' }],
      [`${materialPath(set.id)}/${note.id}`, { version: 1, body: '左正文' }, { version: 1, body: '右正文' }],
    ] as const) {
      const outcomes = await Promise.all([write(app, alice, path, left, 'PATCH'), write(app, alice, path, right, 'PATCH')]);
      expect(outcomes.map(r => r.status).sort()).toEqual([200, 409]);
      const failed = outcomes.find(r => r.status === 409)!;
      expect((await failed.json()).error.code).toBe('version_conflict');
      const saved = await (await read(app, alice, path)).json();
      const resource = saved.studySet ?? saved.material;
      expect(resource.version).toBe(2);
      expect('body' in resource ? ['左正文', '右正文'] : ['左', '右']).toContain(resource.body ?? resource.title);
    }
  });

  it('AC-07 validates codepoint titles, IDs, strict fields, paging and update shapes', async () => {
    const set = await createSet(app, alice, '😀'.repeat(60));
    const note = await createMaterial(app, alice, set.id, '', '😀'.repeat(120));
    for (const title of ['', ' \n ', '😀'.repeat(61), '\u0000', '\ud800']) {
      await error(await write(app, alice, setsPath, { clientRequestId: randomUUID(), title }), 400, 'invalid_input');
    }
    for (const input of [
      { title: 'missing request ID' }, { clientRequestId: 'bad', title: 'x' },
      { clientRequestId: randomUUID(), title: 'x', version: 1 },
    ]) await error(await write(app, alice, setsPath, input), 400, 'invalid_input');
    for (const input of [{ version: 1 }, { version: 0, body: 'x' }, { version: 1.5, title: 'x' }, { version: 1, body: null }, { version: 1, body: '\u0000' }, { version: 1, body: '\ud800' }, { version: 1, title: '😀'.repeat(121) }]) {
      await error(await write(app, alice, `${materialPath(set.id)}/${note.id}`, input, 'PATCH'), 400, 'invalid_input');
    }
    for (const suffix of ['?limit=0', '?limit=101', '?limit=1.5', '?cursor=garbage']) await error(await read(app, alice, setsPath + suffix), 400, 'invalid_input');
    await error(await read(app, alice, `${setsPath}/not-a-uuid`), 400, 'invalid_input');
    await error(await read(app, alice, `${materialPath(set.id)}/bad`), 400, 'invalid_input');
    await error(await write(app, alice, setsPath, { clientRequestId: randomUUID(), title: 'x' }, 'POST', { 'content-type': 'text/plain' }), 400, 'invalid_input');
  });

  it('AC-07 applies UTF-8 body and escaped JSON limits separately, including PATCH', async () => {
    const set = await createSet(app, alice);
    const bytes = 1024 * 1024;
    const boundary = '汉'.repeat(Math.floor(bytes / 3)) + 'a'.repeat(bytes % 3);
    expect(Buffer.byteLength(boundary, 'utf8')).toBe(bytes);
    const note = await createMaterial(app, alice, set.id, boundary);
    expect(Buffer.byteLength(note.body, 'utf8')).toBe(bytes);
    await error(await write(app, alice, materialPath(set.id), { clientRequestId: randomUUID(), title: '过大', body: boundary + 'a' }), 413, 'payload_too_large');
    await error(await write(app, alice, `${materialPath(set.id)}/${note.id}`, { version: 1, body: boundary + 'a' }, 'PATCH'), 413, 'payload_too_large');
    // The decoded text is below 1 MiB, but JSON escaping expands it past 2 MiB.
    await error(await write(app, alice, materialPath(set.id), { clientRequestId: randomUUID(), title: '转义', body: '\u0001'.repeat(400_000) }), 413, 'payload_too_large');
    expect((await (await read(app, alice, materialPath(set.id))).json()).items).toHaveLength(1);
  }, 20_000);

  it('AC-07 bounds streamed requests without trusting absent or misleading Content-Length', async () => {
    const set = await createSet(app, alice);
    const payload = new TextEncoder().encode(JSON.stringify({ clientRequestId: randomUUID(), title: '流式', body: 'x'.repeat(2 * 1024 * 1024) }));
    for (const contentLength of [undefined, '2']) {
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset >= payload.length) { controller.close(); return; }
        controller.enqueue(payload.slice(offset, offset + 64 * 1024)); offset += 64 * 1024;
      } });
      const request = new Request(`http://localhost${materialPath(set.id)}`, {
        method: 'POST', headers: { ...alice.headers, 'content-type': 'application/json', ...(contentLength ? { 'content-length': contentLength } : {}) },
        body: stream, duplex: 'half',
      } as RequestInit);
      await error(await app.request(request), 413, 'payload_too_large');
    }
    expect((await (await read(app, alice, materialPath(set.id))).json()).items).toEqual([]);
  }, 20_000);

  it('AC-08 paginates 101 tied timestamps without omissions and rejects foreign-scope cursors', async () => {
    for (let i = 0; i < 101; i++) await createSet(app, alice, `集${i}`);
    // Microseconds intentionally differ from JS millisecond precision; cursor boundaries must not truncate.
    await db.query("UPDATE study_sets SET created_at = '2026-11-20T03:00:00.123456Z' WHERE user_id = $1", [alice.userId]);
    const first = await (await read(app, alice, `${setsPath}?limit=50`)).json();
    expect(first.items).toHaveLength(50);
    expect(typeof first.nextCursor).toBe('string');
    await error(await read(app, bob, `${setsPath}?cursor=${encodeURIComponent(first.nextCursor)}`), 400, 'invalid_input');
    const setIds: string[] = first.items.map((item: { id: string }) => item.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await (await read(app, alice, `${setsPath}?limit=50&cursor=${encodeURIComponent(cursor)}`)).json();
      setIds.push(...page.items.map((item: { id: string }) => item.id)); cursor = page.nextCursor;
    }
    expect(setIds).toHaveLength(101);
    expect(new Set(setIds).size).toBe(101);
    expect(setIds).toEqual([...setIds].sort().reverse());
    await db.query('DELETE FROM request_rate_limits'); // Separate fixture creation from rate-window acceptance.
    for (let i = 0; i < 101; i++) await createMaterial(app, alice, setIds[0]!, `正文${i}`);
    await db.query("UPDATE study_materials SET created_at = '2026-11-20T03:00:00.123456Z' WHERE user_id = $1", [alice.userId]);
    const page1 = await (await read(app, alice, `${materialPath(setIds[0]!)}?limit=50`)).json();
    const seen = page1.items.map((item: { id: string }) => item.id);
    await error(await read(app, alice, `${materialPath(setIds[1]!)}?cursor=${encodeURIComponent(page1.nextCursor)}`), 400, 'invalid_input');
    await error(await read(app, alice, `${setsPath}?cursor=${encodeURIComponent(page1.nextCursor)}`), 400, 'invalid_input');
    cursor = page1.nextCursor;
    while (cursor) {
      const page = await (await read(app, alice, `${materialPath(setIds[0]!)}?cursor=${encodeURIComponent(cursor)}`)).json();
      expect(page.items.every((item: Record<string, unknown>) => !('body' in item))).toBe(true);
      seen.push(...page.items.map((item: { id: string }) => item.id)); cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(101);
    expect(new Set(seen).size).toBe(101);
  }, 30_000);

  it('AC-11 cascades account deletion and blocks a write authenticated before deletion', async () => {
    const set = await createSet(app, alice);
    await createMaterial(app, alice, set.id);
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const intercepted: Db = {
      query: db.query.bind(db), exec: db.exec.bind(db), close: async () => {},
      tx: async (fn, lockKey) => {
        if (lockKey === alice.userId) { entered(); await resume; }
        return db.tx(fn, lockKey);
      },
    };
    const racingApp = makeApp(intercepted);
    const pending = write(racingApp, alice, materialPath(set.id), { clientRequestId: randomUUID(), title: '迟到写入', body: '不能留下' });
    await paused;
    try {
      const job = await requestAccountDeletion(db, alice.userId);
      expect(job.status).toBe('completed');
    } finally { release(); }
    await error(await pending, 401, 'unauthorized');
    expect(await db.query('SELECT id FROM study_sets WHERE user_id=$1', [alice.userId])).toEqual([]);
    expect(await db.query('SELECT id FROM study_materials WHERE user_id=$1', [alice.userId])).toEqual([]);
    await error(await read(app, alice, setsPath), 401, 'unauthorized');
    expect((await read(app, bob, setsPath)).status).toBe(200);
  }, 20_000);

  it('AC-03/11 enforces ownership and soft-deletion guards even when SQL bypasses the API', async () => {
    const set = await createSet(app, alice, '保留标题');
    const note = await createMaterial(app, alice, set.id, '保留正文');
    const digest = '0'.repeat(64);
    const insertMaterial = (userId: string) => db.query(`INSERT INTO study_materials
      (user_id, study_set_id, title, body, client_request_id, creation_digest)
      VALUES ($1, $2, '直接写入', '未授权正文', $3, $4)`, [userId, set.id, randomUUID(), digest]);
    // Both users and the parent exist: only the composite ownership FK should reject this.
    await expect(insertMaterial(bob.userId)).rejects.toMatchObject({ code: '23503' });
    await expect(db.query('UPDATE study_materials SET user_id=$1 WHERE id=$2', [bob.userId, note.id])).rejects.toMatchObject({ code: '23503' });

    // This models the pending-deletion state before the existing lifecycle job physically removes rows.
    await db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [alice.userId]);
    await expect(db.query(`INSERT INTO study_sets (user_id,title,client_request_id,creation_digest)
      VALUES ($1,'迟到学习集',$2,$3)`, [alice.userId, randomUUID(), digest])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("UPDATE study_sets SET title='迟到改名' WHERE id=$1", [set.id])).rejects.toMatchObject({ code: '42501' });
    await expect(insertMaterial(alice.userId)).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("UPDATE study_materials SET body='迟到修改' WHERE id=$1", [note.id])).rejects.toMatchObject({ code: '42501' });
    expect(await db.query('SELECT id,title FROM study_sets WHERE user_id=$1', [alice.userId])).toEqual([{ id: set.id, title: '保留标题' }]);
    expect(await db.query('SELECT id,user_id,body FROM study_materials WHERE study_set_id=$1', [set.id])).toEqual([{ id: note.id, user_id: alice.userId, body: '保留正文' }]);
    expect((await createSet(app, bob)).version).toBe(1);
  });

  it('AC-12 shares the 120-write window with PlanPlan, including idempotent retries', async () => {
    const input = { clientRequestId: randomUUID(), title: '窗口' };
    expect((await write(app, alice, setsPath, input)).status).toBe(201);
    for (let i = 0; i < 119; i++) {
      await new SharedRateLimiter(db, rateSecret).consume('write', alice.userId, 120);
    }
    await error(await write(app, alice, setsPath, input), 429, 'rate_limited');
    await expect(new SharedRateLimiter(db, rateSecret).consume('write', alice.userId, 120)).rejects.toMatchObject({ code: 'rate_limited' });
    expect((await read(app, alice, setsPath)).status).toBe(200);
    expect((await write(app, bob, setsPath, input)).status).toBe(201);
  }, 30_000);

  it('AC-12 rolls back a database failure after insertion and keeps error output/logs free of content', async () => {
    const marker = 'private-study-text-must-never-be-logged';
    const set = await createSet(app, alice);
    let injected = false;
    const faulty: Db = {
      query: db.query.bind(db), exec: db.exec.bind(db), close: async () => {},
      tx: (fn, lockKey) => db.tx(async q => {
        const wrapped: Transaction = {
          exec: q.exec.bind(q),
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await q.query<T>(sql, params);
            if (/INSERT\s+INTO\s+study_materials/i.test(sql)) { injected = true; throw new Error(marker); }
            return result;
          },
        };
        return fn(wrapped);
      }, lockKey),
    };
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    try {
      const result = await write(makeApp(faulty), alice, materialPath(set.id), { clientRequestId: randomUUID(), title: '失败', body: marker });
      expect(injected).toBe(true);
      expect(result.status).toBe(500);
      expect(await result.text()).not.toContain(marker);
      expect(JSON.stringify(spies.map(spy => spy.mock.calls))).not.toContain(marker);
    } finally { spies.forEach(spy => spy.mockRestore()); }
    expect((await (await read(app, alice, materialPath(set.id))).json()).items).toEqual([]);
  });
});
