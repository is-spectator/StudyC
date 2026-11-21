import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('./routes.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parseStudyRoute, studySetPath, materialPath } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const a = '11111111-1111-4111-8111-111111111111';
const b = 'ABCDEFAB-2222-4222-8222-222222222222';

test('old fixed/onboarding entries open the set list without inventing an entity', () => {
  for (const path of ['/', '/platform', '/platform/', '/platform/studysets', '/platform/onboarding?currentStep=studying', '/platform/studyset/main', '/platform/studyset/main/material/old']) {
    assert.deepEqual(parseStudyRoute(path), { kind: 'sets' });
  }
});
test('actual entity IDs survive direct links, trailing slashes and query strings', () => {
  assert.deepEqual(parseStudyRoute(`/platform/studyset/${a}`), { kind: 'set', studySetId: a });
  assert.deepEqual(parseStudyRoute(`/platform/studyset/${a}/materials/`), { kind: 'set', studySetId: a });
  assert.deepEqual(parseStudyRoute(`/platform/studyset/${a}/material/new`), { kind: 'material', studySetId: a });
  assert.deepEqual(parseStudyRoute(`/platform/studyset/${a}/material/${b}?x=1`), { kind: 'material', studySetId: a, materialId: b.toLowerCase() });
});
test('unsupported cloud tools have explicit unavailable routes and retain their set scope', () => {
  assert.deepEqual(parseStudyRoute(`/platform/studyset/${a}/flashcards/create`), { kind: 'unavailable', title: '闪卡', studySetId: a });
  assert.deepEqual(parseStudyRoute('/platform/calendar'), { kind: 'unavailable', title: '日历' });
  assert.deepEqual(parseStudyRoute('/platform/local-data'), { kind: 'local-data' });
});
test('malformed and external paths never become a fallback learning set', () => {
  for (const path of ['/platform/studyset/not-an-id', `/platform/studyset/${a}/material/main`, `//evil.test/platform/studyset/${a}`, 'https://evil.test/platform', `/platform/studyset/${a}/unknown`, `/platform/studyset/${a}/constructor`, `/platform/studyset/${a}/__proto__`, '/platform\\studysets', '/platform/studyset/%31bad']) {
    assert.deepEqual(parseStudyRoute(path), { kind: 'not-found' });
  }
});
test('path builders use validated IDs, including distinct same-title entities', () => {
  assert.equal(studySetPath(b), `/platform/studyset/${b.toLowerCase()}`);
  assert.equal(materialPath(a), `/platform/studyset/${a}/material/new`);
  assert.equal(materialPath(a, b), `/platform/studyset/${a}/material/${b.toLowerCase()}`);
  assert.throws(() => studySetPath('main'), TypeError);
  assert.throws(() => materialPath(a, '../other'), TypeError);
});
