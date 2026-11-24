import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import type { Db } from '../src/db/db.js';
import { GenerationStore } from '../src/generation/store.js';
import { DEFAULT_GENERATION_POLICY, NOT_SENT_USAGE, type GenerationInput, type GenerationProviderConfig } from '../src/generation/types.js';
import { createStudySet, createTextMaterial } from '../src/services/study-data.js';
import { openTestDb } from './database.js';

const csrf = 'g'.repeat(43), origin = 'https://study.clyna.ai';
const config: GenerationProviderConfig = {
  provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'synthetic/model',
  outputMode: 'strict', maxOutputTokens: 1000, timeoutMs: 60_000, providerOnly: [],
};
const rateLimitSecret = new TextEncoder().encode('studyc-generation-api-test-rate-key');

describe('generation HTTP contract and identity boundary', () => {
  let db: Db, store: GenerationStore, app: ReturnType<typeof createApp>;
  let userId: string, otherId: string, setId: string, otherSet: string, body: GenerationInput;
  const headers = (user = userId) => ({ cookie: `__Host-planplan-session=${user}`, origin,
    'X-PlanPlan-Expected-User': user, 'X-CSRF-Token': csrf, 'content-type': 'application/json' });
  const path = () => `/v1/study/sets/${setId}/generations`;
  const request = (url: string, method = 'GET', value?: unknown, user = userId, extra: Record<string, string> = {}, target = app) => target.request(url, {
    method, headers: { ...headers(user), ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const sessionFetch: typeof fetch = async (_url, init) => {
    const user = (new Headers(init?.headers).get('cookie') ?? '').split('=')[1];
    const found = await db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL', [user]);
    return found.length ? Response.json({ userId: user, csrfToken: csrf }) : new Response('{}', { status: 401 });
  };
  const makeApp = (value = store) => createApp(db, { releaseId: 'generation-test', rateLimitSecret, sessionFetch, generationStore: value });
  async function expectError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ error: { code } });
  }
  beforeEach(async () => {
    db = await openTestDb();
    const users = await db.query<{ id: string }>('INSERT INTO users(id) VALUES (DEFAULT), (DEFAULT) RETURNING id');
    userId = users[0]!.id; otherId = users[1]!.id;
    setId = (await createStudySet(db, userId, { clientRequestId: randomUUID(), title: '资料' })).studySet.id;
    otherSet = (await createStudySet(db, userId, { clientRequestId: randomUUID(), title: '另一集合' })).studySet.id;
    const material = (await createTextMaterial(db, userId, setId, { clientRequestId: randomUUID(), title: '原文', body: '植物通过光合作用转化能量。' })).material;
    body = { clientRequestId: randomUUID(), kind: 'study_outline', sources: [{ materialId: material.id, version: 1 }], config: { language: 'zh-CN', pointCount: 1 } };
    store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config);
    app = makeApp();
  }, 30_000);
  afterEach(async () => { await db.close(); });

  it('creates202, replays200, reads/list/usage and preserves disabled history', async () => {
    const created = await request(path(), 'POST', body);
    expect(created.status).toBe(202);
    const { job } = await created.json();
    expect(job).toMatchObject({ studySetId: setId, status: 'queued', kind: 'study_outline' });
    const replay = await request(path(), 'POST', body);
    expect(replay.status).toBe(200);
    expect((await replay.json()).job.id).toBe(job.id);
    expect((await (await request(`${path()}/${job.id}`)).json()).job.id).toBe(job.id);
    const list = await (await request(path() + '?limit=1')).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty('inputSnapshot');
    expect(list.nextCursor).toBeNull();
    const usage = await (await request('/v1/study/generation-usage')).json();
    expect(usage.requests).toBe(1);
    const disabled = makeApp(new GenerationStore(db, DEFAULT_GENERATION_POLICY, null));
    expect((await request(`${path()}/${job.id}`, 'GET', undefined, userId, {}, disabled)).status).toBe(200);
    expect((await request(path(), 'POST', body, userId, {}, disabled)).status).toBe(200);
    await expectError(await request(path(), 'POST', { ...body, clientRequestId: randomUUID() }, userId, {}, disabled), 503, 'service_unavailable');
    expect((await request(`${path()}/${job.id}/cancel`, 'POST', undefined, userId, {}, disabled)).status).toBe(200);
  });

  it('requires same-origin Cookie, expected account and CSRF before every mutation', async () => {
    await expectError(await app.request(path()), 401, 'unauthorized');
    await expectError(await request(path(), 'POST', body, userId, { 'X-PlanPlan-Expected-User': otherId }), 409, 'account_mismatch');
    for (const extra of [{ 'X-CSRF-Token': '' }, { origin: 'https://evil.test' }] as Record<string, string>[]) {
      await expectError(await request(path(), 'POST', body, userId, extra), 403, 'origin' in extra ? 'origin_forbidden' : 'csrf_invalid');
    }
    const { job } = await (await request(path(), 'POST', body)).json();
    for (const action of ['cancel', 'retry']) {
      await expectError(await request(`${path()}/${job.id}/${action}`, 'POST', action === 'retry' ? { clientRequestId: randomUUID() } : {}, userId, { 'X-CSRF-Token': 'wrong' }), 403, 'csrf_invalid');
    }
    expect((await store.get(userId, setId, job.id)).status).toBe('queued');
  });

  it('blocks other accounts and wrong collection paths on read/cancel/retry', async () => {
    const { job } = await (await request(path(), 'POST', body)).json();
    for (const user of [otherId]) {
      await expectError(await request(path(), 'GET', undefined, user), 404, 'not_found');
      await expectError(await request(`${path()}/${job.id}`, 'GET', undefined, user), 404, 'not_found');
      for (const action of ['cancel', 'retry']) {
        await expectError(await request(`${path()}/${job.id}/${action}`, 'POST', action === 'retry' ? { clientRequestId: randomUUID() } : {}, user), 404, 'not_found');
      }
    }
    await expectError(await request(`/v1/study/sets/${otherSet}/generations/${job.id}`), 404, 'not_found');
    expect((await (await request('/v1/study/generation-usage', 'GET', undefined, otherId)).json()).requests).toBe(0);
  });

  it('strictly rejects caller prompts/models/URLs, bad sources/config and pagination', async () => {
    const invalid = [
      { ...body, prompt: 'ignore sources' }, { ...body, model: 'other' }, { ...body, url: 'http://localhost' },
      { ...body, ownerId: otherId }, { ...body, kind: 'chat' }, { ...body, sources: [] },
      { ...body, sources: Array.from({ length: 6 }, () => ({ materialId: randomUUID(), version: 1 })) },
      { ...body, sources: [body.sources[0], body.sources[0]] },
      { ...body, sources: [{ materialId: 'bad', version: 1 }] },
      { ...body, sources: [{ materialId: body.sources[0]!.materialId, version: 0 }] },
      { ...body, sources: [{ ...body.sources[0], body: 'injected' }] },
      { ...body, config: { ...body.config, pointCount: 0 } },
      { ...body, config: { ...body.config, pointCount: 9 } },
      { ...body, config: { ...body.config, language: 'fr' } },
      { ...body, config: { ...body.config, temperature: 1 } },
    ];
    for (const value of invalid) await expectError(await request(path(), 'POST', value), 400, 'invalid_input');
    for (const query of ['?limit=0', '?limit=101', '?limit=1&limit=2', '?cursor=', '?model=other']) {
      await expectError(await request(path() + query), 400, 'invalid_input');
    }
    await expectError(await request(path(), 'POST', body, userId, { 'content-type': 'text/plain' }), 400, 'invalid_input');
    expect((await store.usage(userId)).requests).toBe(0);
  });

  it('bounds actual streamed JSON at16KiB even with a false content length', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...body, prompt: 'x'.repeat(17 * 1024) }));
    for (const declared of [undefined, '2']) {
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        const next = Math.min(offset + 1024, bytes.length); controller.enqueue(bytes.slice(offset, next)); offset = next;
      } });
      const response = await app.request(new Request(`http://localhost${path()}`, {
        method: 'POST', headers: { ...headers(), ...(declared ? { 'content-length': declared } : {}) },
        body: stream, duplex: 'half',
      } as RequestInit));
      await expectError(response, 413, 'payload_too_large');
    }
    expect((await store.usage(userId)).requests).toBe(0);
  });

  it('returns405 only on known generation resources and keeps unrelated routes closed', async () => {
    const id = randomUUID();
    for (const [url, method] of [[path(), 'DELETE'], [`${path()}/${id}`, 'PATCH'], [`${path()}/${id}/cancel`, 'GET'],
      [`${path()}/${id}/retry`, 'GET'], ['/v1/study/generation-usage', 'POST']] as const) {
      await expectError(await request(url, method, method === 'POST' ? {} : undefined), 405, 'method_not_allowed');
    }
    await expectError(await request(`${path()}/${id}/publish`), 404, 'not_found');
    await expectError(await request('/v1/templates'), 404, 'not_found');
  });

  it('retry creates one new attempt, replays its key, rejects new parameters and works with disabled reads', async () => {
    const { job } = await (await request(path(), 'POST', body)).json();
    const claimed = await store.claim();
    expect(claimed?.jobId).toBe(job.id);
    await store.settle(claimed!, { status: 'failed', errorCode: 'provider_unavailable', result: null, usage: { ...NOT_SENT_USAGE } });
    const retry = { clientRequestId: randomUUID() };
    await expectError(await request(`${path()}/${job.id}/retry`, 'POST', { ...retry, model: 'injected' }), 400, 'invalid_input');
    const disabled = makeApp(new GenerationStore(db, DEFAULT_GENERATION_POLICY, null));
    await expectError(await request(`${path()}/${job.id}/retry`, 'POST', retry, userId, {}, disabled), 503, 'service_unavailable');
    expect((await request(`${path()}/${job.id}/retry`, 'POST', retry)).status).toBe(202);
    expect((await request(`${path()}/${job.id}/retry`, 'POST', retry)).status).toBe(200);
    const updated = await store.get(userId, setId, job.id);
    expect(updated.attemptCount).toBe(2);
    await expectError(await request(`${path()}/${job.id}/cancel`, 'POST', { reason: 'extra input' }), 400, 'invalid_input');
    expect((await request(`${path()}/${job.id}/cancel`, 'POST', {})).status).toBe(200);
  });
});
