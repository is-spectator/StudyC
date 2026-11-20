import assert from 'node:assert/strict';
import test from 'node:test';
// Imports the same decision function used by AuthGate, rather than a duplicate
// test model. React mounting and browser focus are additionally checked by CUA.
import { accountGateView } from './session-state.ts';

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
