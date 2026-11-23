import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { z } from 'zod';
import { createApp } from '../src/api/app.js';
import type { StudyEnv } from '../src/api/auth.js';
import type { Db } from '../src/db/db.js';
import { DomainError } from '../src/services/errors.js';
import { StudyError, StudyInputError } from '../src/services/study-data.js';

// Authentication is tested independently of database business rules. The actual
// StudyC persistence suite exercises the real registered route implementations.
vi.mock('../src/api/study.js', () => ({
  registerStudyRoutes(app: Hono<StudyEnv>) {
    app.get('/v1/study/sets', c => c.json({ userId: c.get('userId') }));
    app.post('/v1/study/sets', c => c.json({ userId: c.get('userId') }));
    app.patch('/v1/study/sets/:setId', c => c.json({ userId: c.get('userId') }));
  },
}));

const userId = '3d0cc394-3a61-4ff2-8db4-5e77237d6538';
const otherId = '2ba4c568-88c9-4a8c-8647-76f86e578c84';
const csrfToken = 'a'.repeat(43);
const cookie = '__Host-planplan-session=fixture-token';
const origin = 'https://study.clyna.ai';
const session = () => Response.json({ userId, csrfToken });
const credentials = () => ({ Cookie: cookie, 'X-PlanPlan-Expected-User': userId });
const writeCredentials = () => ({ ...credentials(), Origin: origin, 'X-CSRF-Token': csrfToken });

function fixture(transport: typeof fetch = async () => session()) {
  const db = { query: vi.fn(async () => []), tx: vi.fn(), exec: vi.fn(), close: vi.fn() } as unknown as Db;
  const sessionFetch = vi.fn(transport);
  const app = createApp(db, { releaseId: 'synthetic-release', rateLimitSecret: new Uint8Array(32).fill(7), sessionFetch });
  return { app, sessionFetch, db };
}

async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = await response.json();
  expect(body.error.code).toBe(code);
  expect(JSON.stringify(body)).not.toContain('private-upstream-detail');
  return body;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('independent StudyC session verification', () => {
  it('obtains identity only from the fixed local session endpoint and forwards only its secure cookie', async () => {
    const { app, sessionFetch, db } = fixture();
    const response = await app.request('/v1/study/sets', {
      headers: { ...credentials(), Cookie: `analytics=private-upstream-detail; ${cookie}`, 'X-User-ID': otherId, Origin: 'https://elsewhere.invalid' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(sessionFetch).toHaveBeenCalledTimes(1);
    const [url, init] = sessionFetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8789/v1/auth/web/session');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('cookie')).toBe(cookie);
    expect([...new Headers(init?.headers).keys()].sort()).toEqual(['accept', 'cookie']);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('guards every quiz path shape without admitting extra routes or touching the database', async () => {
    const { app, db } = fixture();
    const root = `/v1/study/sets/${userId}/quizzes`;
    const paths: [string, string[]][] = [
      [root, ['GET', 'POST']], [`${root}/${otherId}`, ['GET']],
      [`${root}/${otherId}/attempts`, ['GET', 'POST']], [`${root}/${otherId}/attempts/${userId}`, ['GET']],
      [`${root}/${otherId}/attempts/${userId}/answers`, ['POST']], [`${root}/${otherId}/attempts/${userId}/submit`, ['POST']],
    ];
    for (const [path, allowed] of paths) for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
      if (allowed.includes(method)) continue;
      const response = await app.request(path, { method, headers: writeCredentials() });
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(db.query).not.toHaveBeenCalled(); expect(db.tx).not.toHaveBeenCalled();
    await failure(await app.request(`${root}/${otherId}/attempts/${userId}/unknown`, { headers: credentials() }), 404, 'not_found');
  });

  it.each([
    ['anonymous', {}],
    ['bearer-only', { Authorization: 'Bearer fixture-token' }],
    ['local-cookie', { Cookie: 'planplan-local-session=fixture-token' }],
    ['empty-cookie', { Cookie: '__Host-planplan-session=' }],
    ['noncanonical-cookie', { Cookie: '__Host-planplan-session=bad%3Bvalue' }],
  ])('rejects %s without contacting the identity service', async (_name, headers) => {
    const { app, sessionFetch } = fixture();
    await failure(await app.request('/v1/study/sets', { headers }), 401, 'unauthorized');
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...credentials(), Authorization: 'Bearer fixture-token' },
    { ...credentials(), Authorization: '' },
    { ...credentials(), Cookie: `${cookie}; planplan-local-session=another` },
    { ...credentials(), Cookie: `${cookie}; ${cookie}` },
  ])('rejects ambiguous credentials before an upstream request', async headers => {
    const { app, sessionFetch } = fixture();
    await failure(await app.request('/v1/study/sets', { headers }), 401, 'credential_conflict');
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it.each([undefined, otherId])('requires the expected account on reads and writes', async expected => {
    const { app } = fixture();
    for (const method of ['GET', 'POST', 'PATCH']) {
      const headers = new Headers(writeCredentials());
      if (expected) headers.set('X-PlanPlan-Expected-User', expected); else headers.delete('X-PlanPlan-Expected-User');
      await failure(await app.request(method === 'PATCH' ? `/v1/study/sets/${userId}` : '/v1/study/sets', { method, headers }), 409, 'account_mismatch');
    }
  });

  it.each(['POST', 'PATCH'])('%s accepts the exact origin and current upstream CSRF token', async method => {
    const { app } = fixture();
    const response = await app.request(method === 'POST' ? '/v1/study/sets' : `/v1/study/sets/${userId}`, { method, headers: writeCredentials() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId });
  });

  it.each([undefined, 'https://clyna.ai', 'https://study.clyna.ai.evil.invalid', 'https://study.clyna.ai/'])('rejects non-exact write origins', async value => {
    const { app } = fixture();
    const headers = new Headers(writeCredentials());
    if (value) headers.set('Origin', value); else headers.delete('Origin');
    for (const method of ['POST', 'PATCH']) {
      await failure(await app.request(method === 'POST' ? '/v1/study/sets' : `/v1/study/sets/${userId}`, { method, headers }), 403, 'origin_forbidden');
    }
  });

  it.each([undefined, 'wrong', `${csrfToken}a`])('rejects absent or mismatched CSRF without a length exception', async value => {
    const { app } = fixture();
    const headers = new Headers(writeCredentials());
    if (value) headers.set('X-CSRF-Token', value); else headers.delete('X-CSRF-Token');
    for (const method of ['POST', 'PATCH']) {
      await failure(await app.request(method === 'POST' ? '/v1/study/sets' : `/v1/study/sets/${userId}`, { method, headers }), 403, 'csrf_invalid');
    }
  });

  it('does not cache login state across logout or token revocation', async () => {
    const { app, sessionFetch } = fixture();
    expect((await app.request('/v1/study/sets', { headers: credentials() })).status).toBe(200);
    sessionFetch.mockResolvedValueOnce(Response.json({ error: 'private-upstream-detail' }, { status: 401 }));
    await failure(await app.request('/v1/study/sets', { headers: credentials() }), 401, 'unauthorized');
    expect(sessionFetch).toHaveBeenCalledTimes(2);
  });

  it.each([302, 403, 500, 503])('fails closed on unexpected upstream status %s', async status => {
    const { app } = fixture(async () => new Response('private-upstream-detail', { status }));
    await failure(await app.request('/v1/study/sets', { headers: credentials() }), 503, 'service_unavailable');
  });

  it.each([
    'not JSON private-upstream-detail',
    JSON.stringify({ userId: 'untrusted-user', csrfToken }),
    JSON.stringify({ userId, csrfToken: 'bad' }),
    JSON.stringify({ userId }),
    JSON.stringify([{ userId, csrfToken }]),
    'x'.repeat(4097),
  ])('fails closed on malformed or oversized upstream session data', async body => {
    const { app } = fixture(async () => new Response(body));
    await failure(await app.request('/v1/study/sets', { headers: credentials() }), 503, 'service_unavailable');
  });

  it('does not expose an upstream network error', async () => {
    const { app } = fixture(async () => { throw new Error('private-upstream-detail'); });
    await failure(await app.request('/v1/study/sets', { headers: credentials() }), 503, 'service_unavailable');
  });

  it.each(['headers', 'body'])('bounds the complete session request when upstream stalls at %s', async stage => {
    vi.useFakeTimers();
    const { app, sessionFetch } = fixture(async () => stage === 'headers'
      ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ start() {} })));
    const pending = app.request('/v1/study/sets', { headers: credentials() });
    await vi.advanceTimersByTimeAsync(2001);
    await failure(await pending, 503, 'service_unavailable');
    expect(sessionFetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });
});

describe('standalone StudyC app boundary', () => {
  it('keeps health/readiness independent and does not expose PlanPlan or registration routes', async () => {
    const { app, db, sessionFetch } = fixture();
    expect(await (await app.request('/healthz')).json()).toEqual({ ok: true, service: 'studyc' });
    expect(db.query).not.toHaveBeenCalled();
    expect(await (await app.request('/readyz')).json()).toEqual({ ok: true, release: 'synthetic-release', service: 'studyc' });
    await app.request('/readyz');
    expect(db.query).toHaveBeenCalledTimes(1);
    for (const path of ['/v1/plans', '/v1/templates', '/v1/auth/web/session', '/v1/auth/web/email/register']) {
      await failure(await app.request(path, { headers: credentials() }), 404, 'not_found');
    }
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it('fails readiness when the StudyC database is unavailable', async () => {
    const { app, db } = fixture();
    vi.mocked(db.query).mockRejectedValueOnce(new Error('private-upstream-detail'));
    const response = await app.request('/readyz');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, release: 'synthetic-release', service: 'studyc' });
  });

  it('rejects unsupported methods on the study route after authentication', async () => {
    const { app } = fixture();
    await failure(await app.request('/v1/study/sets', { method: 'DELETE', headers: credentials() }), 405, 'method_not_allowed');
    await failure(await app.request('/v1/study/sets', { method: 'OPTIONS', headers: credentials() }), 405, 'method_not_allowed');
    const head = await app.request('/v1/study/sets', { method: 'HEAD', headers: credentials() });
    expect(head.status).toBe(405);
    expect(head.headers.get('cache-control')).toBe('private, no-store');
  });

  it('guards every flashcard path shape and rejects unsupported methods before database access', async () => {
    const { app, db } = fixture();
    const root = `/v1/study/sets/${userId}/flashcard-decks`;
    const paths: [string, string[]][] = [
      [root, ['GET', 'POST']], [`${root}/${otherId}`, ['GET', 'PATCH']],
      [`${root}/materialize`, ['POST']], [`${root}/${otherId}/cards`, ['POST']],
      [`${root}/${otherId}/cards/${userId}`, ['PATCH']], [`${root}/${otherId}/sessions`, ['POST']],
      [`${root}/${otherId}/sessions/${userId}`, ['GET']], [`${root}/${otherId}/sessions/${userId}/reviews`, ['POST']],
    ];
    for (const [path, allowed] of paths) {
      for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
        if (allowed.includes(method)) continue;
        const response = await app.request(path, { method, headers: writeCredentials() });
        expect(response.status, `${method} ${path}`).toBe(405);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
      }
    }
    expect(db.query).not.toHaveBeenCalled();
    expect(db.tx).not.toHaveBeenCalled();
    await failure(await app.request(`${root}/${otherId}/sessions/${userId}/unknown`, { headers: credentials() }), 404, 'not_found');
  });

  it.each([
    [new DomainError('not_found', 'missing'), 404, 'not_found'],
    [new DomainError('version_conflict', 'conflict'), 409, 'version_conflict'],
    [new DomainError('rate_limited', 'busy'), 429, 'rate_limited'],
    [new DomainError('invalid_input', 'invalid'), 422, 'invalid_input'],
    [new StudyError('idempotency_conflict', 'conflict'), 409, 'idempotency_conflict'],
    [new StudyError('payload_too_large', 'oversized'), 413, 'payload_too_large'],
    [new StudyInputError(), 400, 'invalid_input'],
    [new SyntaxError('private-upstream-detail'), 400, 'invalid_input'],
    [z.string().safeParse(1).error!, 400, 'invalid_input'],
    [new Error('private-upstream-detail'), 500, 'internal'],
  ] as const)('preserves the API error contract %#', async (error, status, code) => {
    const { app } = fixture();
    app.get('/test-error', () => { throw error; });
    await failure(await app.request('/test-error'), status, code);
  });
});
