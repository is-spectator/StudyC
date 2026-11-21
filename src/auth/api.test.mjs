import assert from 'node:assert/strict';
import test from 'node:test';
import { authApi, AuthApiError, parseSession, parseUser, sessionHeaders } from './api.ts';

const userId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const csrfToken = 'a'.repeat(43);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('auth uses same-origin cookies without storing or exposing a bearer token', async () => {
  let request;
  const result = await authApi('/v1/auth/web/email/login', { method: 'POST', body: { email: 'test@example.test', password: 'synthetic password' } }, async (path, options) => {
    request = { path, ...options };
    return json({ userId });
  });
  assert.deepEqual(result, { userId });
  assert.equal(request.path, '/v1/auth/web/email/login');
  assert.equal(request.credentials, 'same-origin');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.equal(request.headers.has('Authorization'), false);
});

test('cross-origin paths and manually supplied credentials are rejected before fetch', async () => {
  const fetcher = async () => { assert.fail('must not send this request'); };
  for (const path of ['https://other.example/v1/me', '//other.example/v1/me', '/v1/\\other']) {
    await assert.rejects(authApi(path, {}, fetcher), error => error instanceof AuthApiError && error.code === 'invalid_request');
  }
  await assert.rejects(authApi('/v1/me', { headers: { authorization: 'Bearer test' } }, fetcher), error => error.code === 'credential_conflict');
});

test('protected requests retain expected-user and CSRF headers', async () => {
  await authApi('/v1/logout', { method: 'POST', headers: sessionHeaders({ userId, csrfToken }) }, async (_path, options) => {
    assert.equal(options.headers.get('X-PlanPlan-Expected-User'), userId);
    assert.equal(options.headers.get('X-CSRF-Token'), csrfToken);
    return json({ ok: true });
  });
});

test('PlanPlan error code, safe message, and status remain available to the gate', async () => {
  await assert.rejects(authApi('/v1/me', {}, async () => json({ error: { code: 'account_mismatch', message: '账户已切换', details: {} } }, 409)), error => error.code === 'account_mismatch' && error.status === 409 && error.message === '账户已切换');
});

test('network failure never produces a successful or anonymous account response', async () => {
  await assert.rejects(authApi('/v1/auth/web/session', {}, async () => { throw new Error('private transport detail'); }), error => error.code === 'connection_lost' && !error.message.includes('private transport detail'));
});

test('HTML fallback cannot be interpreted as a successful session', async () => {
  await assert.rejects(authApi('/v1/auth/web/session', {}, async () => new Response('<html>app shell</html>')), error => error.code === 'invalid_response');
});

test('session requires a real UUID and well-formed CSRF token', () => {
  assert.deepEqual(parseSession({ userId, csrfToken }), { userId, csrfToken });
  assert.throws(() => parseSession({ userId: 'preview', csrfToken }), /登录状态/);
  assert.throws(() => parseSession({ userId, csrfToken: '' }), /登录状态/);
});

test('a mismatched /me response cannot activate another account storage scope', () => {
  assert.equal(parseUser({ id: userId }, userId).id, userId);
  assert.throws(() => parseUser({ id: secondId }, userId), error => error.code === 'account_mismatch');
});

test('user cancellation remains AbortError during fetch and response decoding', async () => {
  const abort = new DOMException('synthetic cancellation', 'AbortError');
  await assert.rejects(authApi('/v1/study/sets', {}, async () => { throw abort; }), error => error === abort);
  await assert.rejects(authApi('/v1/study/sets', {}, async () => ({ status: 200, ok: true, json: async () => { throw abort; } })), error => error === abort);
});

test('an aborted signal prevents sending and rejects late responses from an uncancellable transport', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(authApi('/v1/study/sets', { signal: controller.signal }, async () => assert.fail('must not send')), error => error.name === 'AbortError');
  const late = new AbortController();
  await assert.rejects(authApi('/v1/study/sets', { signal: late.signal }, async () => {
    late.abort('navigation');
    return json({ items: [], nextCursor: null });
  }), error => error.name === 'AbortError' && !error.message.includes('navigation'));
});

test('timeouts and malformed business responses are explicit service errors, without transport details', async () => {
  await assert.rejects(authApi('/v1/study/sets', {}, async () => { throw new DOMException('private detail', 'TimeoutError'); }), error => error instanceof AuthApiError && error.code === 'connection_lost' && error.message.includes('学习服务') && !error.message.includes('private detail'));
  await assert.rejects(authApi('/v1/study/sets', {}, async () => new Response('<html>upstream failure</html>', { status: 502 })), error => error instanceof AuthApiError && error.code === 'invalid_response' && error.status === 502 && error.message.includes('学习服务'));
});
