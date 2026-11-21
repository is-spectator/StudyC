import { lstat, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { reconcileStoredFiles } from '../src/services/study-files.js';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';

const origin = 'https://study.clyna.ai';
const csrf = 'p'.repeat(43);
const secret = new TextEncoder().encode('studyc-pdf-test-shared-rate-secret!!');

function textPdf(pages: string[]): Uint8Array {
  const fontId = 3 + pages.length * 2;
  const kids: string[] = [];
  const pageObjects: string[] = [];
  const contentObjects: string[] = [];
  pages.forEach((text, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const stream = `BT /F1 18 Tf 36 90 Td (${text}) Tj ET`;
    kids.push(`${pageId} 0 R`);
    pageObjects.push(`${pageId} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>endobj`);
    contentObjects.push(`${contentId} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj`);
  });
  return new TextEncoder().encode([
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    `2 0 obj<</Type/Pages/Count ${pages.length}/Kids[${kids.join(' ')}]>>endobj`,
    ...pageObjects,
    ...contentObjects,
    `${fontId} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`,
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n'));
}

const encryptedPdf = new TextEncoder().encode(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R/Encrypt 6 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R>>endobj
4 0 obj<</Length 8>>stream
BT ET
endstream
endobj
6 0 obj<</Filter/Standard/V 1/R 2/O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)/U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)/P -4>>endobj
trailer<</Root 1 0 R/Encrypt 6 0 R>>
%%EOF`);

function form(bytes: Uint8Array, requestId: string, filename: string) {
  const data = new FormData();
  data.set('clientRequestId', requestId);
  data.set('file', new File([Buffer.from(bytes)], filename, { type: 'application/pdf' }));
  return data;
}

describe('PDF upload, text extraction, and private download', () => {
  let db: Db;
  let directory: string;
  let app: ReturnType<typeof createApp>;
  const headersFor = (userId: string) => ({ origin, cookie: `__Host-planplan-session=${userId}`, 'X-PlanPlan-Expected-User': userId, 'X-CSRF-Token': csrf });

  beforeAll(async () => {
    db = await openTestDb();
    directory = await mkdtemp(join(tmpdir(), 'studyc-pdf-'));
    const sessionFetch: typeof fetch = async (_url, init) => {
      const cookie = new Headers(init?.headers).get('cookie') ?? '';
      const userId = cookie.split('=')[1] ?? '';
      const [user] = await db.query<{ id: string }>('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]);
      return user ? Response.json({ userId: user.id, csrfToken: csrf }) : new Response('{}', { status: 401 });
    };
    app = createApp(db, { releaseId: 'pdf-test', rateLimitSecret: secret, sessionFetch, fileRoot: directory });
  });
  afterAll(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });

  async function user() {
    const [row] = await db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
    return row!.id;
  }
  async function set(userId: string) {
    const response = await app.request('/v1/study/sets', { method: 'POST', headers: { ...headersFor(userId), 'content-type': 'application/json' },
      body: JSON.stringify({ clientRequestId: randomUUID(), title: '数学' }) });
    expect(response.status).toBe(201);
    return (await response.json()).studySet.id as string;
  }

  it('extracts text pages into a private source and a readable material', async () => {
    const owner = await user();
    const setId = await set(owner);
    const requestId = randomUUID();
    const response = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner),
      body: form(textPdf(['Hello PDF', 'Second page']), requestId, '../../秘密/线段计数.pdf') });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.file.displayName).toBe('线段计数.pdf');
    expect(body.file.displayName).not.toContain('/');
    expect(body.file.status).toBe('ready');
    expect(body.file.pageCount).toBe(2);
    expect(body.file.pages.map((page: { page: number }) => page.page)).toEqual([1, 2]);
    const material = await app.request(`/v1/study/sets/${setId}/materials/${body.file.materialId}`, { headers: headersFor(owner) });
    const text = (await material.json()).material.body as string;
    expect(text).toContain('[第 1 页]');
    expect(text).toContain('Hello PDF');
    expect(text).toContain('[第 2 页]');
    expect(text).toContain('Second page');
    for (const page of body.file.pages as { page: number; start: number; end: number }[]) {
      expect(text.slice(page.start, page.end)).toContain(`[第 ${page.page} 页]`);
    }
    const download = await app.request(`/v1/study/sets/${setId}/files/${body.file.id}/content`, { headers: headersFor(owner) });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toContain('filename*=UTF-8');
    expect(new TextDecoder().decode(await download.arrayBuffer())).toContain('Hello PDF');
    const replay = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner),
      body: form(textPdf(['Hello PDF', 'Second page']), requestId, '线段计数.pdf') });
    expect(replay.status).toBe(200);
    expect((await replay.json()).file.id).toBe(body.file.id);
    expect(await db.query('SELECT count(*)::int AS n FROM study_source_files WHERE user_id=$1', [owner])).toEqual([{ n: 1 }]);
  });

  it('rejects another account, a changed retry, and a non-PDF payload without saving bytes', async () => {
    const owner = await user();
    const other = await user();
    const setId = await set(owner);
    const bytes = textPdf(['Only mine']);
    const created = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner), body: form(bytes, randomUUID(), 'mine.pdf') });
    const file = (await created.json()).file;
    for (const path of [`/v1/study/sets/${setId}/files`, `/v1/study/sets/${setId}/files/${file.id}/content`]) {
      const response = await app.request(path, { headers: headersFor(other) });
      expect(response.status).toBe(404);
      if (path.endsWith('/content')) expect(await response.text()).not.toContain('Only mine');
    }
    const changed = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner), body: form(textPdf(['Changed']), file.id, 'mine.pdf') });
    expect(changed.status).not.toBe(409);
    const requestId = randomUUID();
    const first = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner), body: form(bytes, requestId, 'mine.pdf') });
    expect([200, 201]).toContain(first.status);
    const conflict = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner), body: form(textPdf(['Different']), requestId, 'mine.pdf') });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('idempotency_conflict');
    const fake = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner),
      body: form(new TextEncoder().encode('\x89PNG not a pdf'), randomUUID(), 'notes.pdf') });
    expect(fake.status).toBe(400);
    expect((await fake.json()).error.code).toBe('invalid_input');
    expect(await db.query("SELECT count(*)::int AS n FROM study_source_files WHERE display_name='notes.pdf'")).toEqual([{ n: 0 }]);
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    oversized.set(new TextEncoder().encode('%PDF-'), 0);
    const tooBig = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner), body: form(oversized, randomUUID(), 'big.pdf') });
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error.code).toBe('payload_too_large');
    expect(await db.query("SELECT count(*)::int AS n FROM study_source_files WHERE display_name='big.pdf'")).toEqual([{ n: 0 }]);
    const anonymous = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    expect(anonymous.status).toBe(401);
  });

  it('persists scanned, encrypted, and corrupt PDFs as failures without a text material', async () => {
    const owner = await user();
    const setId = await set(owner);
    const cases = [
      [textPdf(['   ']), 'no_extractable_text'],
      [encryptedPdf, 'encrypted_pdf'],
      [new TextEncoder().encode('%PDF-1.4\nthis is not a document'), 'invalid_pdf'],
      [textPdf(Array.from({ length: 31 }, () => 'page')), 'too_many_pages'],
    ] as const;
    for (const [bytes, code] of cases) {
      const requestId = randomUUID();
      const response = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner), body: form(bytes, requestId, `${code}.pdf`) });
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error.code).toBe(code);
      expect(body.file.materialId).toBeNull();
      expect(body.file.status).toBe(code);
      expect(JSON.stringify(body)).not.toContain('BT /F1');
      const replay = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner), body: form(bytes, requestId, `${code}.pdf`) });
      expect(replay.status).toBe(200);
      expect((await replay.json()).error.code).toBe(code);
    }
    const listed = await app.request(`/v1/study/sets/${setId}/files`, { headers: headersFor(owner) });
    const items = (await listed.json()).items as { id: string; status: string }[];
    expect(items.map(item => item.status).sort()).toEqual(['encrypted_pdf', 'invalid_pdf', 'no_extractable_text', 'too_many_pages']);
    const blocked = items.find(item => item.status === 'encrypted_pdf');
    const hidden = await app.request(`/v1/study/sets/${setId}/files/${blocked!.id}/content`, { headers: headersFor(owner) });
    expect(hidden.status).toBe(404);
    expect(await db.query('SELECT count(*)::int AS n FROM study_materials WHERE user_id=$1', [owner])).toEqual([{ n: 0 }]);
    expect(await db.query('SELECT count(*)::int AS n FROM study_source_files WHERE user_id=$1', [owner])).toEqual([{ n: 4 }]);
  });

  it('keeps the document page count when an earlier page has no text', async () => {
    const owner = await user();
    const setId = await set(owner);
    const response = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner),
      body: form(textPdf(['', 'Only second']), randomUUID(), 'mixed.pdf') });
    expect(response.status).toBe(201);
    const file = (await response.json()).file;
    expect(file.pageCount).toBe(2);
    expect(file.pages.map((page: { page: number }) => page.page)).toEqual([2]);
    const material = await app.request(`/v1/study/sets/${setId}/materials/${file.materialId}`, { headers: headersFor(owner) });
    const text = (await material.json()).material.body as string;
    expect(text).toContain('[第 2 页]');
    expect(text).toContain('Only second');
    expect(text).not.toContain('[第 1 页]');
  });

  it('removes a deleted account directory and only aged files that have no row', async () => {
    const owner = await user();
    const setId = await set(owner);
    const created = await app.request(`/v1/study/sets/${setId}/files`, { method: 'POST', headers: headersFor(owner),
      body: form(textPdf(['Keep me']), randomUUID(), 'keep.pdf') });
    expect(created.status).toBe(201);
    const file = (await created.json()).file;
    const stored = join(directory, owner, file.id);
    expect((await lstat(stored)).isFile()).toBe(true);
    const orphan = join(directory, owner, randomUUID());
    await writeFile(orphan, Buffer.from('%PDF-1.4 orphan'));
    await reconcileStoredFiles(db, directory);
    expect((await lstat(orphan)).isFile()).toBe(true);
    expect((await lstat(stored)).isFile()).toBe(true);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(orphan, old, old);
    await reconcileStoredFiles(db, directory);
    await expect(lstat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(stored)).isFile()).toBe(true);
    await db.tx(async query => {
      await query.query('UPDATE users SET deleted_at = now() WHERE id = $1', [owner]);
      await query.query('DELETE FROM users WHERE id = $1', [owner]);
    }, owner);
    await reconcileStoredFiles(db, directory);
    await expect(lstat(join(directory, owner))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
