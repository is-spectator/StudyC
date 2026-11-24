import assert from 'node:assert/strict';
import test from 'node:test';
// Imports the same decision function used by AuthGate, rather than a duplicate
// test model. React mounting and browser focus are additionally checked by CUA.
import { accountGateView, requestWithSession } from './session-state.ts';
import { AuthApiError } from './api.ts';

const userA = { id: '11111111-1111-4111-8111-111111111111' };
const userB = { id: '22222222-2222-4222-8222-222222222222' };
const view = (status, user = userA, allowPreview = false) => accountGateView({ status, user }, allowPreview);

test('focus verification keeps the previous keyed subtree while hiding interaction', () => {
  const before = view('authenticated');
  const pending = view('verifying');
  assert.equal(pending.accountId, before.accountId);
  assert.equal(pending.hidden, true);
  assert.equal(pending.verifying, true);
});

test('verification of the same account unlocks the original subtree', () => {
  const pending = view('verifying');
  const confirmed = view('authenticated');
  assert.equal(confirmed.accountId, pending.accountId);
  assert.equal(confirmed.hidden, false);
});

test('transient offline or unavailable state retains the prior account but remains hidden', () => {
  const offline = view('unavailable');
  assert.equal(offline.accountId, userA.id);
  assert.equal(offline.hidden, true);
  assert.equal(offline.verifying, false);
  assert.equal(view('authenticated').accountId, offline.accountId);
});

test('an unavailable service without prior verification never mounts an account', () => {
  assert.equal(view('unavailable', null).accountId, null);
});

test('explicit logout or invalid session removes even a stale prior user reference', () => {
  assert.equal(view('checking').accountId, null);
  assert.equal(view('anonymous').accountId, null);
});

test('a confirmed different account changes the keyed boundary', () => {
  assert.notEqual(view('authenticated', userB).accountId, view('verifying', userA).accountId);
});

test('a preview state cannot mount without the development-only allowance', () => {
  assert.equal(view('preview', null, false).accountId, null);
  assert.equal(view('preview', null, true).accountId, 'preview');
});

function requestState() {
  const events = [];
  const state = {
    session: { current: { userId: userA.id, csrfToken: 'a'.repeat(43) } },
    epoch: { current: 1 }, preview: { current: false }, mounted: { current: true },
    clearIdentity: message => events.push(['clear', message]),
    reverify: id => events.push(['reverify', id]),
  };
  return { state, events };
}

test('business network, server, validation, and edit conflicts leave identity and drafts available', async () => {
  for (const error of [new AuthApiError('connection_lost', '离线'), new AuthApiError('internal', '服务失败', 500),
    new AuthApiError('service_unavailable', '繁忙', 503), new AuthApiError('invalid_response', '坏回复', 502),
    new AuthApiError('version_conflict', '版本冲突', 409), new AuthApiError('invalid_input', '格式错误', 400),
    new AuthApiError('origin_forbidden', '来源错误', 403)]) {
    const { state, events } = requestState();
    const original = state.session.current;
    await assert.rejects(requestWithSession('/v1/study/sets', {}, state, async () => { throw error; }), actual => actual === error);
    assert.deepEqual(events, []);
    assert.equal(state.session.current, original);
    assert.equal(state.epoch.current, 1);
    assert.equal(view('authenticated').hidden, false);
  }
});

test('only explicit 401 and account mismatch clear the current authenticated identity', async () => {
  for (const error of [new AuthApiError('unauthorized', '登录失效', 401), new AuthApiError('account_mismatch', '账户变化', 409)]) {
    const { state, events } = requestState();
    await assert.rejects(requestWithSession('/v1/study/sets', {}, state, async () => { throw error; }), actual => actual === error);
    assert.deepEqual(events, [['clear', error.message]]);
  }
});

test('explicit CSRF failure verifies the same user once and never retries the write', async () => {
  const { state, events } = requestState();
  const error = new AuthApiError('csrf_invalid', '刷新页面', 403);
  let calls = 0;
  await assert.rejects(requestWithSession('/v1/study/sets', { method: 'POST' }, state, async () => { ++calls; throw error; }), actual => actual === error);
  assert.equal(calls, 1);
  assert.deepEqual(events, [['reverify', userA.id]]);
  assert.equal(view('verifying').accountId, view('authenticated').accountId);
});

test('protected transport overwrites caller identity headers and retains the cancellation signal', async () => {
  const { state } = requestState();
  const controller = new AbortController();
  const result = await requestWithSession('/v1/study/sets', { signal: controller.signal, headers: { 'x-planplan-expected-user': userB.id, 'X-PlanPlan-Expected-User': userB.id, 'x-Csrf-token': 'fake' } }, state, async (_path, options) => {
    const headers = new Headers(options.headers);
    assert.equal(headers.get('X-PlanPlan-Expected-User'), userA.id);
    assert.equal(headers.get('X-CSRF-Token'), 'a'.repeat(43));
    assert.equal(options.signal, controller.signal);
    return { fixture: true };
  });
  assert.deepEqual(result, { fixture: true });
});

test('late success is rejected after an account or same-account epoch change, without clearing the new identity', async () => {
  for (const nextUser of [userA, userB]) {
    const { state, events } = requestState();
    let resolve;
    const pending = requestWithSession('/v1/study/sets', {}, state, () => new Promise(done => { resolve = done; }));
    ++state.epoch.current;
    state.session.current = { userId: nextUser.id, csrfToken: 'b'.repeat(43) };
    resolve({ items: ['old account data'] });
    await assert.rejects(pending, error => error.code === 'account_mismatch');
    assert.deepEqual(events, []);
    assert.equal(state.session.current.userId, nextUser.id);
  }
});

test('late authentication failure cannot clear or reverify the replacement account', async () => {
  for (const error of [new AuthApiError('unauthorized', '旧会话', 401), new AuthApiError('csrf_invalid', '旧CSRF', 403)]) {
    const { state, events } = requestState();
    let reject;
    const pending = requestWithSession('/v1/study/sets', {}, state, () => new Promise((_resolve, fail) => { reject = fail; }));
    ++state.epoch.current;
    state.session.current = { userId: userB.id, csrfToken: 'b'.repeat(43) };
    reject(error);
    await assert.rejects(pending, actual => actual === error);
    assert.deepEqual(events, []);
  }
});

test('cancelled and unmounted requests cannot mutate the current identity', async () => {
  const { state, events } = requestState();
  const controller = new AbortController();
  await assert.rejects(requestWithSession('/v1/study/sets', { signal: controller.signal }, state, async () => {
    controller.abort();
    throw new AuthApiError('unauthorized', 'late 401', 401);
  }), error => error.name === 'AbortError');
  state.mounted.current = false;
  await assert.rejects(requestWithSession('/v1/study/sets', {}, state, async () => assert.fail('unmounted request')), error => error.name === 'AbortError');
  assert.deepEqual(events, []);
});
