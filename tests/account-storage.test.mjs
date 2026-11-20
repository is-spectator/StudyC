import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/account-storage.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const KEY = 'sf-k12:uploads';

function createHarness(seed = []) {
  const values = new Map(seed);
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const context = { exports: {}, localStorage: storage };
  vm.runInNewContext(compiled, context, { filename: fileURLToPath(new URL('../src/lib/account-storage.ts', import.meta.url)) });
  return { ...context.exports, values, context };
}

test('anonymous access fails closed and does not migrate or overwrite legacy data', () => {
  const h = createHarness([[KEY, 'legacy-anonymous'], ['studyfetch:k12:topic', 'legacy-topic']]);
  assert.equal(h.appStorage.getItem(KEY), null);
  h.appStorage.setItem(KEY, 'anonymous-change');
  h.appStorage.removeItem(KEY);
  assert.deepEqual([...h.appStorage.keys()], []);
  h.setStorageAccount(ACCOUNT_A);
  assert.equal(h.appStorage.getItem(KEY), null);
  assert.equal(h.appStorage.getItem('studyfetch:k12:topic'), null);
  assert.equal(h.values.get(KEY), 'legacy-anonymous');
  assert.equal(h.values.get('studyfetch:k12:topic'), 'legacy-topic');
});

test('accounts have independent read/write/delete namespaces and survive logout', () => {
  const h = createHarness();
  h.setStorageAccount(ACCOUNT_A);
  h.appStorage.setItem(KEY, 'A notes');
  h.setStorageAccount(null);
  assert.equal(h.appStorage.getItem(KEY), null);
  h.appStorage.setItem(KEY, 'logged-out write');
  h.appStorage.removeItem(KEY);
  h.setStorageAccount(ACCOUNT_B);
  assert.equal(h.appStorage.getItem(KEY), null);
  h.appStorage.setItem(KEY, 'B notes');
  h.appStorage.removeItem(KEY);
  assert.equal(h.appStorage.getItem(KEY), null);
  h.setStorageAccount(ACCOUNT_A);
  assert.equal(h.appStorage.getItem(KEY), 'A notes');
});

test('all three app key families isolate, while export excludes other accounts and unrelated data', () => {
  const h = createHarness([['sf-k12:legacy', 'do not export'], ['unrelated', 'other app']]);
  const keys = ['sf-k12:notes', 'studyfetch:k12:source', 'studyfetch-k12:created-deck'];
  h.setStorageAccount(ACCOUNT_A);
  for (const key of keys) h.appStorage.setItem(key, `A ${key}`);
  h.appStorage.setItem('unrelated', 'blocked');
  h.setStorageAccount(ACCOUNT_B);
  h.appStorage.setItem('sf-k12:private', 'B private');
  assert.deepEqual([...h.appStorage.keys()], ['sf-k12:private']);
  h.setStorageAccount(ACCOUNT_A);
  assert.deepEqual([...h.appStorage.keys()].sort(), [...keys].sort());
  assert.equal(h.appStorage.getItem('sf-k12:private'), null);
  assert.equal(h.appStorage.getItem('unrelated'), null);
  assert.equal(h.values.get('unrelated'), 'other app');
});

test('explicit preview data never becomes signed-in account data', () => {
  const h = createHarness();
  h.setStorageAccount('preview');
  h.appStorage.setItem(KEY, 'preview notes');
  h.setStorageAccount(ACCOUNT_A);
  assert.equal(h.appStorage.getItem(KEY), null);
  h.appStorage.setItem(KEY, 'A notes');
  h.setStorageAccount('preview');
  assert.equal(h.appStorage.getItem(KEY), 'preview notes');
});

test('UUID casing is canonical and malformed identities clear access', () => {
  const h = createHarness();
  const id = 'abcdefab-1234-4567-89ab-abcdefabcdef';
  h.setStorageAccount(id.toUpperCase());
  h.appStorage.setItem(KEY, 'same UUID');
  h.setStorageAccount(id);
  assert.equal(h.appStorage.getItem(KEY), 'same UUID');
  for (const invalid of ['', 'anonymous', 'preview:sf-k12:uploads', `${id} `, undefined, 42]) {
    assert.throws(() => h.setStorageAccount(invalid), /authenticated UUID/);
    assert.equal(h.appStorage.getItem(KEY), null);
    h.appStorage.setItem(KEY, 'must not write');
  }
  h.setStorageAccount(id);
  assert.equal(h.appStorage.getItem(KEY), 'same UUID');
});

test('an upload started under A becomes stale after logout or account switch', () => {
  const h = createHarness();
  assert.equal(h.captureStorageSession()(), false);
  h.setStorageAccount(ACCOUNT_A);
  const aOperation = h.captureStorageSession();
  h.setStorageAccount(ACCOUNT_A);
  assert.equal(aOperation(), true);
  h.setStorageAccount(ACCOUNT_B);
  assert.equal(aOperation(), false);
  h.setStorageAccount(ACCOUNT_A);
  assert.equal(aOperation(), false);
  const anotherAOperation = h.captureStorageSession();
  h.setStorageAccount(null);
  assert.equal(anotherAOperation(), false);
});

test('unavailable browser storage safely returns no data', () => {
  const h = createHarness();
  Object.defineProperty(h.context, 'localStorage', { get() { throw new Error('Storage denied'); } });
  h.setStorageAccount(ACCOUNT_A);
  assert.equal(h.appStorage.getItem(KEY), null);
  assert.deepEqual([...h.appStorage.keys()], []);
  assert.doesNotThrow(() => h.appStorage.setItem(KEY, 'unavailable'));
  assert.doesNotThrow(() => h.appStorage.removeItem(KEY));
});

test('product code uses account storage instead of raw localStorage', () => {
  for (const name of ['App.tsx', 'data.ts', 'features/Onboarding.tsx', 'features/WorkspacePages.tsx', 'features/Library.tsx', 'features/StudyTools.tsx']) {
    const text = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\blocalStorage\b/, name);
  }
});
