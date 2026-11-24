import assert from 'node:assert/strict';
import test from 'node:test';
import { authApi, AuthApiError } from '../auth/api.ts';
import { createStudyApi, validateStudyTitle, validateTextBody, TEXT_BODY_MAX_BYTES } from './api.ts';

const setId = 'a1111111-1111-4111-8111-111111111111';
const otherSet = 'b2222222-2222-4222-8222-222222222222';
const materialId = 'c3333333-3333-4333-8333-333333333333';
const requestId = 'd4444444-4444-4444-8444-444444444444';
const time = '2026-11-21T01:02:03.000Z';
const studySet = { id: setId, title: '学习集', version: 1, createdAt: time, updatedAt: time };
const summary = { ...studySet, id: materialId, title: '资料', studySetId: setId, format: 'plain_text' };
const material = { ...summary, body: '保留正文\n中文与 emoji 😀' };
const cursor = 'eyJ2IjoxfQ';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const invalidResponse = error => error instanceof AuthApiError && error.code === 'invalid_response' && error.status === 502;

test('all eight API operations use the scoped contract and unwrap their response', async () => {
  const controller = new AbortController(), signal = controller.signal;
  const cases = [
    [api => api.listSets(undefined, signal), '/v1/study/sets', 'GET', undefined, { items: [studySet], nextCursor: null }, { items: [studySet], nextCursor: null }],
    [api => api.getSet(setId.toUpperCase(), signal), `/v1/study/sets/${setId}`, 'GET', undefined, { studySet }, studySet],
    [api => api.createSet({ clientRequestId: requestId, title: ' 学习集 ' }, signal), '/v1/study/sets', 'POST', { clientRequestId: requestId, title: '学习集' }, { studySet }, studySet],
    [api => api.renameSet(setId, { title: '学习集', version: 1 }, signal), `/v1/study/sets/${setId}`, 'PATCH', { title: '学习集', version: 1 }, { studySet }, studySet],
    [api => api.listMaterials(setId, undefined, signal), `/v1/study/sets/${setId}/materials`, 'GET', undefined, { items: [summary], nextCursor: null }, { items: [summary], nextCursor: null }],
    [api => api.getMaterial(setId, materialId, signal), `/v1/study/sets/${setId}/materials/${materialId}`, 'GET', undefined, { material }, material],
    [api => api.createMaterial(setId, { clientRequestId: requestId, title: '资料', body: material.body }, signal), `/v1/study/sets/${setId}/materials`, 'POST', { clientRequestId: requestId, title: '资料', body: material.body }, { material }, material],
    [api => api.updateMaterial(setId, materialId, { version: 1, title: '资料', body: material.body }, signal), `/v1/study/sets/${setId}/materials/${materialId}`, 'PATCH', { version: 1, title: '资料', body: material.body }, { material }, material],
  ];
  for (const [call, expectedPath, expectedMethod, expectedBody, response, expected] of cases) {
    let calls = 0;
    const api = createStudyApi(async (path, options) => {
      ++calls;
      assert.equal(path, expectedPath);
      assert.equal(options.method ?? 'GET', expectedMethod);
      assert.deepEqual(options.body, expectedBody);
      assert.equal(options.signal, signal);
      return response;
    });
    assert.deepEqual(await call(api), expected);
    assert.equal(calls, 1);
  }
});

test('pagination keeps its opaque cursor, and material lists do not expose a body', async () => {
  const paths = [];
  const api = createStudyApi(async path => {
    paths.push(path);
    return path.includes('/materials') ? { items: [{ ...material }], nextCursor: cursor } : { items: [studySet], nextCursor: cursor };
  });
  assert.equal((await api.listSets(cursor)).nextCursor, cursor);
  const page = await api.listMaterials(setId, cursor);
  assert.deepEqual(page.items, [summary]);
  assert.equal('body' in page.items[0], false);
  assert.deepEqual(paths, [`/v1/study/sets?cursor=${cursor}`, `/v1/study/sets/${setId}/materials?cursor=${cursor}`]);
});

test('malformed or traversal UUID paths are rejected before any request', async () => {
  const api = createStudyApi(async () => assert.fail('invalid path must not reach transport'));
  for (const value of ['main', '../auth/web/session', setId + '/materials', setId + '?id=x',
    '00000000-0000-0000-0000-000000000000', setId.replace('-4111-', '-0111-'), setId.replace('-8111-', '-7111-')]) {
    await assert.rejects(api.getSet(value), error => error.code === 'invalid_request');
    await assert.rejects(api.getMaterial(setId, value), error => error.code === 'invalid_request');
    await assert.rejects(api.listMaterials(value), error => error.code === 'invalid_request');
  }
  await assert.rejects(api.createSet({ clientRequestId: 'invalid', title: '学习集' }), error => error.code === 'invalid_request');
});

test('invalid cursors cannot add query parameters or start an unbounded pagination loop', async () => {
  const api = createStudyApi(async () => assert.fail('invalid cursor must not reach transport'));
  for (const value of ['', '&limit=100', 'has space', 'a'.repeat(1025)]) {
    await assert.rejects(api.listSets(value), error => error.code === 'invalid_request');
    await assert.rejects(api.listMaterials(setId, value), error => error.code === 'invalid_request');
  }
});

test('title validation trims and counts Unicode code points using each title limit', () => {
  assert.equal(validateStudyTitle('  中文 😀  '), '中文 😀');
  assert.equal(validateStudyTitle('😀'.repeat(60)), '😀'.repeat(60));
  assert.equal(validateStudyTitle('资'.repeat(120), 120).length, 120);
  for (const value of ['', ' \n ', 'a'.repeat(61), 'bad\0title', '\uD800']) assert.throws(() => validateStudyTitle(value), error => error.code === 'invalid_input');
  assert.throws(() => validateStudyTitle('资'.repeat(121), 120), error => error.code === 'invalid_input');
});

test('body validation preserves whitespace and rejects unrepresentable or oversized UTF-8 text', () => {
  const text = '  第一行\r\n第二行 😀  \n';
  assert.equal(validateTextBody(text), text);
  assert.equal(validateTextBody(''), '');
  assert.equal(validateTextBody('x'.repeat(TEXT_BODY_MAX_BYTES)).length, TEXT_BODY_MAX_BYTES);
  for (const value of ['\0', '\uD800', '\uDC00']) assert.throws(() => validateTextBody(value), error => error.code === 'invalid_input');
  for (const value of ['x'.repeat(TEXT_BODY_MAX_BYTES + 1), '学'.repeat(Math.floor(TEXT_BODY_MAX_BYTES / 3) + 1)]) {
    assert.throws(() => validateTextBody(value), error => error.code === 'payload_too_large' && error.status === 413);
  }
});

test('invalid versions and empty updates are rejected locally', async () => {
  const api = createStudyApi(async () => assert.fail('invalid payload must not reach transport'));
  for (const value of [0, -1, 1.5, 2147483647, NaN]) {
    await assert.rejects(api.renameSet(setId, { title: '资料', version: value }), error => error.code === 'invalid_input');
    await assert.rejects(api.updateMaterial(setId, materialId, { body: '', version: value }), error => error.code === 'invalid_input');
  }
  await assert.rejects(api.updateMaterial(setId, materialId, { version: 1 }), error => error.code === 'invalid_input');
});

test('title-only and body-only updates carry only the selected change and current version', async () => {
  const bodies = [];
  const api = createStudyApi(async (_path, options) => { bodies.push(options.body); return { material }; });
  await api.updateMaterial(setId, materialId, { version: 1, title: '  改名  ' });
  await api.updateMaterial(setId, materialId, { version: 2, body: '' });
  assert.deepEqual(bodies, [{ version: 1, title: '改名' }, { version: 2, body: '' }]);
});

test('invalid study-set schemas are service failures, never successful saves', async () => {
  for (const response of [null, [], { studySet: null }, { studySet: { ...studySet, id: 'main' } },
    { studySet: { ...studySet, version: 0 } }, { studySet: { ...studySet, version: 1.5 } },
    { studySet: { ...studySet, title: '  untrimmed ' } }, { studySet: { ...studySet, title: 'x'.repeat(61) } },
    { studySet: { ...studySet, updatedAt: '2026-02-31T01:02:03.000Z' } },
    { studySet: { ...studySet, createdAt: 'yesterday' } }, { studySet: { ...studySet, id: otherSet } }]) {
    const api = createStudyApi(async () => response);
    await assert.rejects(api.getSet(setId), invalidResponse);
  }
});

test('material responses must belong to the requested set and material, with valid plain text', async () => {
  for (const value of [{ ...material, studySetId: otherSet }, { ...material, id: otherSet },
    { ...material, format: 'html' }, { ...material, body: undefined }, { ...material, body: '\uD800' },
    { ...material, body: 'x'.repeat(TEXT_BODY_MAX_BYTES + 1) }]) {
    const api = createStudyApi(async () => ({ material: value }));
    await assert.rejects(api.getMaterial(setId, materialId), invalidResponse);
  }
  const api = createStudyApi(async () => ({ items: [{ ...summary, studySetId: otherSet }], nextCursor: null }));
  await assert.rejects(api.listMaterials(setId), invalidResponse);
});

test('malformed pages, duplicate records, and unusable next-cursors are rejected', async () => {
  for (const response of [{ items: [] }, { items: {}, nextCursor: null },
    { items: [], nextCursor: cursor }, { items: [studySet], nextCursor: '' },
    { items: [studySet, studySet], nextCursor: null }, { items: [studySet], nextCursor: 'unsafe?query' }]) {
    await assert.rejects(createStudyApi(async () => response).listSets(), invalidResponse);
  }
  assert.deepEqual(await createStudyApi(async () => ({ items: [], nextCursor: null })).listSets(), { items: [], nextCursor: null });
});

test('HTML, malformed JSON, and upstream business errors remain explicit AuthApiError failures', async () => {
  for (const response of [new Response('<html>fallback</html>'), new Response('{bad-json', { status: 502 })]) {
    const api = createStudyApi((path, options) => authApi(path, options, async () => response));
    await assert.rejects(api.listSets(), error => error instanceof AuthApiError && error.code === 'invalid_response');
  }
  for (const [status, code] of [[409, 'version_conflict'], [429, 'rate_limited'], [503, 'service_unavailable']]) {
    let calls = 0;
    const api = createStudyApi((path, options) => authApi(path, options, async () => { ++calls; return json({ error: { code, message: '合成错误' } }, status); }));
    await assert.rejects(api.createMaterial(setId, { clientRequestId: requestId, title: '资料', body: material.body }), error => error instanceof AuthApiError && error.code === code && error.status === status);
    assert.equal(calls, 1, 'never automatically retry a write');
  }
});

test('ambiguous create failure preserves the caller request ID and payload for an intentional retry', async () => {
  const sent = [];
  const input = { clientRequestId: requestId, title: '资料', body: material.body };
  const api = createStudyApi(async (_path, options) => {
    sent.push(options.body);
    if (sent.length === 1) throw new AuthApiError('connection_lost', '合成断线');
    return { material };
  });
  await assert.rejects(api.createMaterial(setId, input), error => error.code === 'connection_lost');
  assert.deepEqual(await api.createMaterial(setId, input), material);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(input, { clientRequestId: requestId, title: '资料', body: material.body });
});

test('PDF upload uses form data, keeps failure records distinct from extracted text, and rejects an oversized file locally', async () => {
  const fileId = 'e5555555-5555-4555-8555-555555555555';
  const source = { id: fileId, studySetId: setId, materialId, displayName: '线段.pdf', byteSize: 12, status: 'ready', pageCount: 1, pages: [{ page: 1, start: 0, end: 8 }], createdAt: time, updatedAt: time };
  const failed = { ...source, id: 'f6666666-6666-4666-8666-666666666666', materialId: null, displayName: '扫描.pdf', status: 'no_extractable_text', pageCount: 0, pages: [] };
  let seen;
  const api = createStudyApi(async (path, options) => {
    seen = { path, method: options.method, body: options.body, formData: options.formData };
    return path.endsWith('/files') && options.method === 'POST' ? { file: source } : { items: [source, failed], nextCursor: null };
  });
  const file = new File([Buffer.from('%PDF-1.4')], '线段.pdf', { type: 'application/pdf' });
  assert.deepEqual(await api.uploadPdf(setId, file, requestId), source);
  assert.equal(seen.path, `/v1/study/sets/${setId}/files`);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, undefined);
  assert.equal(seen.formData.get('clientRequestId'), requestId);
  assert.equal(seen.formData.get('file').name, '线段.pdf');
  const listed = await api.listFiles(setId);
  assert.equal(listed[1].status, 'no_extractable_text');
  assert.equal(listed[1].materialId, null);
  const huge = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'big.pdf');
  await assert.rejects(api.uploadPdf(setId, huge, requestId), error => error instanceof AuthApiError && error.status === 413);
  await assert.rejects(api.uploadPdf(setId, new File([], 'empty.pdf'), requestId), error => error instanceof AuthApiError && error.status === 400);
});

test('cancellation is preserved and late cancelled responses are not accepted', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(createStudyApi(async () => assert.fail('cancelled request')).listSets(undefined, cancelled.signal), error => error.name === 'AbortError');
  const abort = new DOMException('navigation', 'AbortError');
  await assert.rejects(createStudyApi(async () => { throw abort; }).listSets(), error => error === abort);
  const late = new AbortController();
  await assert.rejects(createStudyApi(async () => { late.abort(); return { material }; }).getMaterial(setId, materialId, late.signal), error => error.name === 'AbortError');
});
