import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../src/db/db.js';
import { GenerationStore } from '../src/generation/store.js';
import { DEFAULT_GENERATION_POLICY, NOT_SENT_USAGE, UNKNOWN_USAGE, type ClaimedGeneration,
  type GenerationInput, type GenerationPolicy, type GenerationProviderConfig, type GenerationUsage } from '../src/generation/types.js';
import { createStudySet, createTextMaterial, updateTextMaterial } from '../src/services/study-data.js';
import { openTestDb } from './database.js';

const provider: GenerationProviderConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'fixture/model',
  outputMode: 'strict', maxOutputTokens: 512, timeoutMs: 1000, providerOnly: [] };
const reported: GenerationUsage = { state: 'reported', inputTokens: 20, outputTokens: 30, totalTokens: 50,
  costCredits: '0.0001', providerRequestId: 'fixture-request' };

describe('durable generation tasks, reservations and fencing', () => {
  let db: Db, now: number, store: GenerationStore;
  let alice: string, bob: string, carol: string, setA: string, setB: string, setC: string, material: string;
  const build = (overrides: Partial<GenerationPolicy> = {}, config: GenerationProviderConfig | null = provider) =>
    new GenerationStore(db, { ...DEFAULT_GENERATION_POLICY, ...overrides }, config, { now: () => new Date(now) });
  const input = (overrides: Partial<GenerationInput> = {}): GenerationInput => ({ clientRequestId: randomUUID(), kind: 'study_outline',
    sources: [{ materialId: material, version: 1 }], config: { language: 'zh-CN', pointCount: 2 }, ...overrides });
  const success = (claim: ClaimedGeneration) => ({ status: 'succeeded' as const, errorCode: null, usage: reported,
    result: { schemaVersion: 1 as const, title: '合成提纲', points: Array.from({ length: ('pointCount' in claim.snapshot.config ? claim.snapshot.config.pointCount : 0) }, (_, index) => ({
      text: `要点${index + 1}`, citations: [{ sourceId: 's1', materialId: claim.snapshot.sources[0]!.materialId,
        version: 1, quote: claim.snapshot.sources[0]!.body, start: 0, end: claim.snapshot.sources[0]!.body.length, page: null }],
    })) } });
  const create = async (data = input()) => { now += 1; return store.create(alice, setA, data); };

  beforeEach(async () => {
    db = await openTestDb();
    now = Date.parse('2026-11-23T12:00:00.000Z');
    const users = await db.query<{ id: string }>('INSERT INTO users VALUES(default,NULL,default),(default,NULL,default),(default,NULL,default) RETURNING id');
    [alice, bob, carol] = users.map(user => user.id) as [string, string, string];
    setA = (await createStudySet(db, alice, { clientRequestId: randomUUID(), title: 'A资料' })).studySet.id;
    setB = (await createStudySet(db, bob, { clientRequestId: randomUUID(), title: 'B资料' })).studySet.id;
    setC = (await createStudySet(db, carol, { clientRequestId: randomUUID(), title: 'C资料' })).studySet.id;
    material = (await createTextMaterial(db, alice, setA, { clientRequestId: randomUUID(), title: '真实输入', body: '这是一份没有内置题库的实际资料，供生成快照使用。' })).material.id;
    store = build();
  });
  afterEach(async () => { await db?.close(); });

  it('concurrent identical requests create one job/attempt/reservation and replay the original snapshot after edits', async () => {
    const requested = input();
    const results = await Promise.all([create(requested), create(requested), create(requested)]);
    expect(new Set(results.map(result => result.job.id)).size).toBe(1);
    expect(results.filter(result => !result.replayed)).toHaveLength(1);
    expect((await store.usage(alice)).requests).toBe(1);
    const original = results[0]!.job.inputSnapshot!;
    await updateTextMaterial(db, alice, setA, material, { version: 1, body: '资料已经改变，不应该重写旧快照。' });
    const replay = await build({}, null).create(alice, setA, requested);
    expect(replay.replayed).toBe(true);
    expect(replay.job.inputSnapshot).toEqual(original);
    expect(original.sources[0]!.bodySha256).toBe(createHash('sha256').update(original.sources[0]!.body).digest('hex'));
    await expect(store.create(alice, setA, { ...requested, config: { language: 'en', pointCount: 2 } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(store.create(alice, setA, input())).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('enforces owner/set boundaries and database snapshot immutability', async () => {
    const { job } = await create();
    await expect(store.get(bob, setA, job.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.get(bob, setB, job.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.create(bob, setB, input())).rejects.toMatchObject({ code: 'not_found' });
    const other = (await createStudySet(db, alice, { clientRequestId: randomUUID(), title: '同账户另一集' })).studySet.id;
    await expect(store.create(alice, other, input())).rejects.toMatchObject({ code: 'not_found' });
    for (const column of ['input_snapshot', 'provider_config']) {
      await expect(db.query(`UPDATE study_generation_jobs SET ${column}='{}'::jsonb WHERE id=$1`, [job.id])).rejects.toThrow(/immutable/);
    }
    await expect(db.query('UPDATE study_generation_jobs SET client_request_id=$2 WHERE id=$1', [job.id, randomUUID()])).rejects.toThrow(/immutable/);
    const list = await store.list(alice, setA, { limit: 1 });
    expect(list.items[0]).not.toHaveProperty('inputSnapshot');
    expect(list.items[0]!.sources[0]).not.toHaveProperty('body');
    expect((await store.get(alice, setA, job.id)).inputSnapshot).toEqual(job.inputSnapshot);
  });

  it('validates nonempty bounded material snapshots and configuration before reserving quota', async () => {
    await expect(create(input({ sources: Array.from({ length: 6 }, () => ({ materialId: material, version: 1 })) }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(create(input({ config: { language: 'zh-CN', pointCount: 9 } }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(create(input({ sources: [{ materialId: material, version: 1 }, { materialId: material, version: 1 }] }))).rejects.toMatchObject({ code: 'invalid_input' });
    await updateTextMaterial(db, alice, setA, material, { version: 1, body: ' \n ' });
    await expect(create(input({ sources: [{ materialId: material, version: 2 }] }))).rejects.toMatchObject({ code: 'invalid_input' });
    await updateTextMaterial(db, alice, setA, material, { version: 2, body: '学'.repeat(11000) });
    await expect(create(input({ sources: [{ materialId: material, version: 3 }] }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await store.usage(alice)).requests).toBe(0);
  });

  it('binds pagination cursors to owner/set and rejects normalized-invalid dates before SQL', async () => {
    await create(); await create(); await create();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list(alice, setA, { limit: 1, cursor });
      ids.push(...page.items.map(job => job.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(3);
    const first = await store.list(alice, setA, { limit: 1 });
    await expect(store.list(bob, setB, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input' });
    const valid = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    for (const at of ['2026-02-30T00:00:00.000000Z', '0000-01-01T00:00:00.000000Z']) {
      const invalidCursor = Buffer.from(JSON.stringify({ ...valid, at })).toString('base64url');
      await expect(store.list(alice, setA, { limit: 1, cursor: invalidCursor })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    const arrayId = Buffer.from(JSON.stringify({ ...valid, id: [valid.id] })).toString('base64url');
    await expect(store.list(alice, setA, { limit: 1, cursor: arrayId })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('copies reviewed policy and routing instead of retaining mutable caller configuration', async () => {
    const policy = { ...DEFAULT_GENERATION_POLICY, userDailyRequests: 1 };
    const configuration = structuredClone(provider);
    const isolated = new GenerationStore(db, policy, configuration, { now: () => new Date(now) });
    policy.userDailyRequests = 999;
    configuration.model = 'changed/model'; configuration.providerOnly.push('changed');
    const created = await isolated.create(alice, setA, input());
    expect(created.job.providerConfig).toEqual(provider);
    await expect(isolated.create(alice, setA, input())).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('copies real PDF page offsets only for the original ready material version', async () => {
    const text = '第一页包含中文与😀。\n\n第二页包含另一段内容。';
    const pdfMaterial = (await createTextMaterial(db, alice, setA, { clientRequestId: randomUUID(), title: 'PDF解析', body: text })).material;
    const [file] = await db.query<{ id: string }>(`INSERT INTO study_source_files
      (user_id,study_set_id,material_id,client_request_id,creation_digest,content_sha256,display_name,byte_size,status,page_count)
      VALUES($1,$2,$3,$4,repeat('a',64),repeat('b',64),'fixture.pdf',123,'ready',3) RETURNING id`, [alice, setA, pdfMaterial.id, randomUUID()]);
    const boundary = text.indexOf('第二页');
    // PR-003 omits empty page text rows while retaining the full page_count.
    await db.query('INSERT INTO study_source_pages VALUES($1,$2,1,0,$3),($1,$2,3,$4,$5)', [file!.id, alice, boundary - 2, boundary, text.length]);
    const first = await create(input({ sources: [{ materialId: pdfMaterial.id, version: 1 }] }));
    expect(first.job.inputSnapshot!.sources[0]).toMatchObject({ sourceFileId: file!.id, pageProvenance: 'original_pdf',
      pages: [{ page: 1, start: 0, end: boundary - 2 }, { page: 3, start: boundary, end: text.length }] });
    await updateTextMaterial(db, alice, setA, pdfMaterial.id, { version: 1, body: '手动编辑后不再对应原始PDF页码。' });
    const edited = await create(input({ sources: [{ materialId: pdfMaterial.id, version: 2 }] }));
    expect(edited.job.inputSnapshot!.sources[0]).toMatchObject({ pageProvenance: 'edited_material', pages: [], sourceFileId: file!.id });
    expect((await store.get(alice, setA, first.job.id)).inputSnapshot).toEqual(first.job.inputSnapshot);
  });

  it('uses one global advisory budget lock across concurrent request and token reservations', async () => {
    store = build({ userDailyRequests: 2, userActiveJobs: 10 });
    const requests = await Promise.allSettled(Array.from({ length: 6 }, () => create()));
    expect(requests.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    expect((await store.usage(alice)).requests).toBe(2);
    const [ledger] = await db.query<{ requests: number | string }>('SELECT requests FROM study_generation_daily_budget');
    expect(Number(ledger!.requests)).toBe(2);
    // A separate user still consumes the same global ledger, not a per-process counter.
    const note = (await createTextMaterial(db, bob, setB, { clientRequestId: randomUUID(), title: 'B', body: '另一账户的真实资料内容。' })).material;
    const capped = build({ globalDailyRequests: 2 });
    await expect(capped.create(bob, setB, input({ sources: [{ materialId: note.id, version: 1 }] }))).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('reserves conservative tokens atomically and cancellation releases only tokens, never request count', async () => {
    const first = await create();
    const reserved = first.job.attempts[0]!.reservedTokens;
    expect(reserved).toBeGreaterThan(Buffer.byteLength(JSON.stringify(first.job.inputSnapshot)) + provider.maxOutputTokens);
    store = build({ userDailyTokens: reserved * 3 - 1, userActiveJobs: 10 });
    const concurrent = await Promise.allSettled([create(), create()]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store.usage(alice)).tokens).toBe(reserved * 2);
    const cancelled = await store.cancel(alice, setA, first.job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.attempts[0]!.usage.state).toBe('not_sent');
    expect(await store.usage(alice)).toMatchObject({ requests: 2, tokens: reserved });
    await store.cancel(alice, setA, first.job.id);
    expect((await store.usage(alice)).tokens).toBe(reserved);
  });

  it('two workers cannot claim the same attempt and per-user/global concurrency are persisted', async () => {
    await create(); await create();
    for (const [user, set] of [[bob, setB], [carol, setC]]) {
      const note = (await createTextMaterial(db, user!, set!, { clientRequestId: randomUUID(), title: '其他资料', body: '需要单独处理的材料。' })).material;
      now += 1;
      await store.create(user!, set!, input({ sources: [{ materialId: note.id, version: 1 }] }));
    }
    const claims = (await Promise.all([store.claim(), build().claim(), build().claim()])).filter(Boolean) as ClaimedGeneration[];
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map(claim => claim.attemptId)).size).toBe(2);
    expect(new Set(claims.map(claim => claim.userId)).size).toBe(2);
    expect(await store.claim()).toBeNull();
    for (const claim of claims) expect(await store.shouldCancel(claim)).toBe(false);
  });

  it('cancelling a running attempt holds concurrency until settlement and a late success cannot resurrect the job', async () => {
    const first = await create(); await create();
    const claim = (await store.claim())!;
    expect(claim.jobId).toBe(first.job.id);
    await store.cancel(alice, setA, claim.jobId);
    expect(await store.shouldCancel(claim)).toBe(true);
    expect((await store.get(alice, setA, claim.jobId)).attempts[0]!.status).toBe('running');
    expect(await store.claim()).toBeNull();
    await expect(store.retry(alice, setA, claim.jobId, { clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'job_conflict' });
    await store.settle(claim, success(claim));
    const done = await store.get(alice, setA, claim.jobId);
    expect(done).toMatchObject({ status: 'cancelled', result: null });
    expect(done.attempts[0]).toMatchObject({ status: 'cancelled', usage: reported });
    expect(await store.claim()).not.toBeNull();
  });

  it('interrupted leases retain unknown usage, never automatically resend, and late usage cannot overwrite a retry', async () => {
    const { job } = await create(), claim = (await store.claim())!;
    const reserved = job.attempts[0]!.reservedTokens;
    now += provider.timeoutMs + 30001;
    expect(await build().recoverExpired()).toBe(1);
    expect(await store.recoverExpired()).toBe(0);
    expect(await store.claim()).toBeNull();
    expect(await store.usage(alice)).toMatchObject({ requests: 1, tokens: reserved, unknownTokens: reserved, running: 0 });
    const retryId = randomUUID();
    expect((await store.retry(alice, setA, job.id, { clientRequestId: retryId })).replayed).toBe(false);
    expect((await store.retry(alice, setA, job.id, { clientRequestId: retryId })).replayed).toBe(true);
    const next = (await store.claim())!;
    await store.settle({ ...claim, leaseToken: randomUUID() }, success(claim));
    expect((await store.usage(alice)).tokens).toBe(reserved * 2);
    await store.settle(claim, success(claim));
    expect((await store.get(alice, setA, job.id))).toMatchObject({ status: 'running', result: null, attemptCount: 2 });
    expect((await store.usage(alice)).tokens).toBe(reserved + 50);
    await store.settle(claim, { ...success(claim), usage: { ...reported, inputTokens: 0, outputTokens: 1, totalTokens: 1 } });
    expect((await store.usage(alice)).tokens).toBe(reserved + 50);
    await store.settle(next, success(next));
    expect((await store.usage(alice)).tokens).toBe(100);
    expect((await store.get(alice, setA, job.id)).status).toBe('succeeded');
    await expect(store.retry(alice, setA, job.id, { clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'job_conflict' });
  });

  it('retries reuse the immutable snapshot/config and stop after three attempts', async () => {
    const { job } = await create();
    await updateTextMaterial(db, alice, setA, material, { version: 1, body: '后来修改的资料。' });
    const changed = build({}, { ...provider, model: 'different/model' });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claim = (await changed.claim())!;
      expect(claim.snapshot).toEqual(job.inputSnapshot);
      expect(claim.providerConfig).toEqual(provider);
      expect(claim.attemptNumber).toBe(attempt);
      await changed.settle(claim, { status: 'failed', result: null, errorCode: 'provider_unavailable', usage: { ...UNKNOWN_USAGE, inputTokens: 1 } });
      if (attempt < 3) await changed.retry(alice, setA, job.id, { clientRequestId: randomUUID() });
    }
    await expect(changed.retry(alice, setA, job.id, { clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'job_conflict' });
    expect((await store.usage(alice)).tokens).toBe(job.attempts[0]!.reservedTokens * 3);
  });

  it('not-sent failures release reservations while incomplete reported usage stays unknown', async () => {
    const first = await create(), claim = (await store.claim())!;
    await store.settle(claim, { status: 'failed', result: null, errorCode: 'config_changed', usage: NOT_SENT_USAGE });
    expect(await store.usage(alice)).toMatchObject({ requests: 1, tokens: 0 });
    await store.retry(alice, setA, first.job.id, { clientRequestId: randomUUID() });
    const next = (await store.claim())!;
    await store.settle(next, { status: 'failed', result: null, errorCode: 'provider_unavailable', usage: { ...reported, totalTokens: null, costCredits: '1e-7' } });
    const done = await store.get(alice, setA, first.job.id);
    expect(done.attempts[1]!.usage.state).toBe('unknown');
    expect(done.attempts[1]!.usage.inputTokens).toBe(20);
    expect(done.attempts[1]!.usage.costCredits).toBe('1e-7');
    expect((await store.usage(alice)).tokens).toBe(first.job.attempts[0]!.reservedTokens);
  });

  it('UTC budget days do not move reservations or actual costs when a task crosses midnight', async () => {
    now = Date.parse('2026-11-23T23:59:59.000Z');
    await create(); const claim = (await store.claim())!;
    now = Date.parse('2026-11-24T00:00:01.000Z');
    await store.settle(claim, success(claim));
    expect(await store.usage(alice)).toMatchObject({ day: '2026-11-24', requests: 0, tokens: 0 });
    const [old] = await db.query<{ tokens: string | number }>("SELECT tokens FROM study_generation_daily_budget WHERE day='2026-11-23'");
    expect(Number(old!.tokens)).toBe(50);
  });

  it('moves unsent reservations to the actual claim day atomically across workers without bypassing the daily cap', async () => {
    const first = await create();
    const note = (await createTextMaterial(db, bob, setB, { clientRequestId: randomUUID(), title: 'B', body: '另一份真实资料内容。' })).material;
    now += 1;
    const second = await store.create(bob, setB, input({ sources: [{ materialId: note.id, version: 1 }] }));
    now = Date.parse('2026-11-24T00:00:01.000Z');
    const capped = build({ globalDailyRequests: 1 });
    const claims = (await Promise.all([capped.claim(), build({ globalDailyRequests: 1 }).claim()])).filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.jobId).toBe(first.job.id);
    expect(await capped.get(bob, setB, second.job.id)).toMatchObject({ status: 'failed', errorCode: 'quota_exceeded',
      attempts: [{ status: 'failed', usage: NOT_SENT_USAGE }] });
    expect(await capped.usage(alice)).toMatchObject({ day: '2026-11-24', requests: 1, tokens: first.job.attempts[0]!.reservedTokens });
    const rows = await db.query<{ day: Date | string; requests: string; tokens: string }>('SELECT day::text,requests,tokens FROM study_generation_daily_budget ORDER BY day');
    expect(rows.map(row => ({ day: new Date(row.day).toISOString().slice(0, 10), requests: Number(row.requests), tokens: Number(row.tokens) })))
      .toEqual([{ day: '2026-11-23', requests: 1, tokens: 0 },
        { day: '2026-11-24', requests: 1, tokens: first.job.attempts[0]!.reservedTokens }]);
    await capped.settle(claims[0]!, success(claims[0]!));
    expect((await capped.usage(alice)).tokens).toBe(50);
  });

  it('rejects a blocked old-day queue head and still claims another user with available budget', async () => {
    const oldAlice = await create();
    const note = (await createTextMaterial(db, bob, setB, { clientRequestId: randomUUID(), title: 'B', body: '可正常领取的另一账户资料。' })).material;
    now += 1;
    const oldBob = await store.create(bob, setB, input({ sources: [{ materialId: note.id, version: 1 }] }));
    now = Date.parse('2026-11-24T00:00:01.000Z');
    const currentAlice = await create();
    await store.cancel(alice, setA, currentAlice.job.id);
    const capped = build({ userDailyRequests: 1 });
    const claim = await capped.claim();
    expect(claim?.jobId).toBe(oldBob.job.id);
    expect(await capped.get(alice, setA, oldAlice.job.id)).toMatchObject({ status: 'failed', errorCode: 'quota_exceeded' });
    expect(await capped.usage(alice)).toMatchObject({ requests: 1, tokens: 0, activeJobs: 0 });
    expect(await capped.usage(bob)).toMatchObject({ requests: 1, tokens: oldBob.job.attempts[0]!.reservedTokens, running: 1 });
  });

  it.each(['recover', 'claim'] as const)('releases soft-deleted queued reservations through %s while retaining submitted request counts', async operation => {
    store = build({ globalActiveJobs: 1 });
    const created = await create();
    await db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [alice]);
    if (operation === 'recover') expect(await store.recoverExpired()).toBe(1);
    else expect(await store.claim()).toBeNull();
    const [attempt] = await db.query('SELECT status,usage_state,accounted_tokens FROM study_generation_attempts WHERE job_id=$1', [created.job.id]);
    expect(attempt).toMatchObject({ status: 'cancelled', usage_state: 'not_sent' });
    expect(Number(attempt!.accounted_tokens)).toBe(0);
    const [before] = await db.query('SELECT requests,tokens FROM study_generation_daily_budget');
    expect(Number(before!.requests)).toBe(1); expect(Number(before!.tokens)).toBe(0);
    expect(await store.recoverExpired()).toBe(0);
    const note = (await createTextMaterial(db, bob, setB, { clientRequestId: randomUUID(), title: 'B', body: '后来提交的正常账户资料。' })).material;
    const next = await store.create(bob, setB, input({ sources: [{ materialId: note.id, version: 1 }] }));
    expect(next.job.status).toBe('queued');
    expect((await store.claim())?.jobId).toBe(next.job.id);
  });

  it('account deletion cascades private jobs/attempts but preserves already reserved global spending', async () => {
    const { job } = await create(), claim = (await store.claim())!;
    const before = await db.query('SELECT * FROM study_generation_daily_budget');
    await db.query('DELETE FROM users WHERE id=$1', [alice]);
    expect(await db.query('SELECT id FROM study_generation_jobs WHERE id=$1', [job.id])).toEqual([]);
    expect(await db.query('SELECT id FROM study_generation_attempts WHERE job_id=$1', [job.id])).toEqual([]);
    expect(await store.shouldCancel(claim)).toBe(true);
    await store.settle(claim, success(claim));
    expect(await db.query('SELECT * FROM study_generation_daily_budget')).toEqual(before);
  });

  it('disabled generation preserves historical reads, cancellation and retry replay', async () => {
    const requested = input(), { job } = await create(requested);
    const disabled = build({}, null);
    expect((await disabled.create(alice, setA, requested)).replayed).toBe(true);
    await expect(disabled.create(alice, setA, input())).rejects.toMatchObject({ code: 'service_unavailable' });
    expect((await disabled.list(alice, setA, { limit: 5 })).items).toHaveLength(1);
    expect(await disabled.claim()).toBeNull();
    expect((await disabled.cancel(alice, setA, job.id)).status).toBe('cancelled');
    await expect(disabled.retry(alice, setA, job.id, { clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'service_unavailable' });
    const retryId = randomUUID();
    await store.retry(alice, setA, job.id, { clientRequestId: retryId });
    expect((await disabled.retry(alice, setA, job.id, { clientRequestId: retryId })).replayed).toBe(true);
  });
});
