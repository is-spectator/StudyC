import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { GenerationStore } from '../src/generation/store.js';
import { ChatService, type ChatMessageInput } from '../src/services/chat.js';
import { createStudySet, createTextMaterial, updateTextMaterial } from '../src/services/study-data.js';
import { DEFAULT_GENERATION_POLICY, NOT_SENT_USAGE, type ClaimedGeneration, type GenerationProviderConfig, type GenerationOutcome } from '../src/generation/types.js';
import { createApp } from '../src/api/app.js';
import { createOpenRouterGenerationProvider } from '../src/generation/provider.js';
import { startGenerationWorker } from '../src/generation/worker.js';
import { openTestDb } from './database.js';
const config: GenerationProviderConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'synthetic/model', outputMode: 'strict', maxOutputTokens: 1000, timeoutMs: 2000, providerOnly: [] };
const source = '植物通过光合作用把太阳光中的能量转化为储存的化学能。';
describe('persistent grounded chat and protected progress', () => {
  let db: Db, store: GenerationStore, chat: ChatService, user: string, other: string, set: string, material: string, thread: string;
  let now = Date.parse('2026-11-23T12:00:00Z');
  const input = (patch: Partial<ChatMessageInput> = {}): ChatMessageInput => ({ clientRequestId: randomUUID(), question: '能量如何转化？', language: 'zh-CN', sources: [{ materialId: material, version: 1 }], ...patch });
  const success = (claim: ClaimedGeneration): GenerationOutcome => ({ status: 'succeeded', errorCode: null,
    usage: { state: 'reported', inputTokens: 10, outputTokens: 10, totalTokens: 20, costCredits: '0.0001', providerRequestId: 'gen-fixture' },
    result: { schemaVersion: 1, answer: '将太阳光的能量转化为化学能并储存。', insufficientEvidence: false,
      citations: [{ sourceId: 's1', materialId: material, version: claim.snapshot.sources[0]!.version, quote: source, start: 0, end: source.length, page: null }] } });
  beforeEach(async () => {
    db = await openTestDb(); now = Date.parse('2026-11-23T12:00:00Z');
    const users = await db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id'); user = users[0]!.id;
    other = (await db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id'))[0]!.id;
    set = (await createStudySet(db, user, { clientRequestId: randomUUID(), title: '资料集' })).studySet.id;
    material = (await createTextMaterial(db, user, set, { clientRequestId: randomUUID(), title: '植物', body: source })).material.id;
    store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config, { now: () => new Date(now) }); chat = new ChatService(db, store);
    thread = (await chat.create(user, set, { clientRequestId: randomUUID(), title: '学习问答' })).thread.id;
  }, 30_000);
  afterEach(async () => { await db.close(); });

  it('atomically deduplicates concurrent sends and retains the original question, sources and versions', async () => {
    const body = input(), sent = await Promise.all([chat.send(user, set, thread, body), chat.send(user, set, thread, body)]);
    expect(new Set(sent.map(item => item.turn.id)).size).toBe(1); expect(sent.filter(item => item.replayed)).toHaveLength(1);
    expect((await store.usage(user)).requests).toBe(1);
    await updateTextMaterial(db, user, set, material, { version: 1, body: '后来编辑的材料，不能替换历史引用。' });
    expect((await chat.send(user, set, thread, body)).job.inputSnapshot!.sources[0]!.body).toBe(source);
    await expect(chat.send(user, set, thread, { ...body, question: '换一个问题' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(db.query('UPDATE study_chat_turns SET question=$2 WHERE id=$1', [sent[0]!.turn.id, '改变问题'])).rejects.toThrow(/immutable/);
    const loaded = await new ChatService(db, new GenerationStore(db, DEFAULT_GENERATION_POLICY, null)).get(user, set, thread);
    expect(loaded.turns[0]!.question).toBe(body.question);
  });

  it('orders turns under concurrency and derives bounded history exclusively from saved successful answers', async () => {
    const responses = await Promise.allSettled([chat.send(user, set, thread, input()), chat.send(user, set, thread, input({ question: '另一个问题？' }))]);
    expect(responses.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(responses.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'job_conflict' } });
    const claim = (await store.claim())!; await store.settle(claim, success(claim));
    const next = await chat.send(user, set, thread, input({ question: '接着解释一下？' }));
    expect(next.turn.sequence).toBe(2);
    expect(next.job.config).toMatchObject({ history: [{ question: (claim.snapshot.config as { question: string }).question, answer: '将太阳光的能量转化为化学能并储存。' }] });
    const first = (await chat.get(user, set, thread)).turns[0]!;
    await expect(chat.retry(user, set, thread, first.id, { clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'job_conflict' });
  });

  it('keeps a stopped running attempt occupied until settlement and retries exactly the old immutable input', async () => {
    const sent = await chat.send(user, set, thread, input()), claim = (await store.claim())!;
    await chat.stop(user, set, thread, sent.turn.id);
    await expect(chat.send(user, set, thread, input())).rejects.toMatchObject({ code: 'job_conflict' });
    await expect(chat.retry(user, set, thread, sent.turn.id, { clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'job_conflict' });
    await store.settle(claim, success(claim));
    expect((await chat.turn(user, set, thread, sent.turn.id)).job.status).toBe('cancelled');
    await updateTextMaterial(db, user, set, material, { version: 1, body: '已修改原始资料。' });
    const retryId = randomUUID(), retry = await chat.retry(user, set, thread, sent.turn.id, { clientRequestId: retryId });
    expect(retry.job.inputSnapshot).toEqual(sent.job.inputSnapshot);
    expect((await chat.retry(user, set, thread, sent.turn.id, { clientRequestId: retryId })).replayed).toBe(true);
    expect(retry.job.attemptCount).toBe(2);
  });

  it('persists real progress with attempt/lease fencing and rejects mutation after stop, expiry or retry', async () => {
    const sent = await chat.send(user, set, thread, input()), claim = (await store.claim())!;
    await store.recordProgress(claim, '植物通过光合作用');
    const first = await store.progress(user, set, sent.job.id);
    expect(first).toMatchObject({ attemptId: claim.attemptId, seq: 1, text: '植物通过光合作用' });
    await store.recordProgress({ ...claim, leaseToken: randomUUID() }, '植物通过光合作用伪造');
    expect(await store.progress(user, set, sent.job.id)).toEqual(first);
    now += config.timeoutMs + 30001; await store.recoverExpired();
    await store.recordProgress(claim, '植物通过光合作用迟到');
    expect(await store.progress(user, set, sent.job.id)).toEqual(first);
    await chat.retry(user, set, thread, sent.turn.id, { clientRequestId: randomUUID() });
    expect(await store.progress(user, set, sent.job.id)).toBeNull();
    const next = (await store.claim())!; await store.recordProgress(next, '重试的真实内容');
    await store.recordProgress(claim, '植物通过光合作用过期回调');
    expect(await store.progress(user, set, sent.job.id)).toMatchObject({ attemptId: next.attemptId, seq: 1, text: '重试的真实内容' });
  });

  it('runs the real SSE parser through the worker into durable progress before final settlement', async () => {
    const sent = await chat.send(user, set, thread, input());
    let upstream!: ReadableStreamDefaultController<Uint8Array>, closed = false;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
    const provider = createOpenRouterGenerationProvider({ config, apiKey: 'fixture-key-not-live-never-transmitted', fetch: async () => response });
    const output = JSON.stringify({ answer: '植物通过光合作用将光能转化为化学能并储存起来。', citations: [{ sourceId: 's1', quote: source }], insufficientEvidence: false });
    const cut = output.indexOf('","citations');
    const frame = (content: string, finish: string | null = null) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`);
    const worker = startGenerationWorker(store, provider, { pollMs: 10, cancelPollMs: 20 });
    try {
      upstream.enqueue(frame(output.slice(0, cut)));
      await expect.poll(async () => (await store.progress(user, set, sent.job.id))?.text, { timeout: 1500 }).toBe('植物通过光合作用将光能转化为化学能并储存起来。');
      expect((await store.get(user, set, sent.job.id)).status).toBe('running');
      upstream.enqueue(frame(output.slice(cut), 'stop'));
      upstream.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}}\n\ndata: [DONE]\n\n'));
      upstream.close(); closed = true;
      await expect.poll(async () => (await store.get(user, set, sent.job.id)).status, { timeout: 1500 }).toBe('succeeded');
      const loaded = await new ChatService(db, new GenerationStore(db, DEFAULT_GENERATION_POLICY, null)).turn(user, set, thread, sent.turn.id);
      expect(loaded.job.result).toMatchObject({ answer: '植物通过光合作用将光能转化为化学能并储存起来。', citations: [{ materialId: material, version: 1 }] });
      expect(loaded.job.attempts[0]!.usage).toMatchObject({ state: 'reported', totalTokens: 20 });
    } finally { if (!closed) { try { upstream.close(); } catch { /* abort may already have closed it */ } } await worker.stop(); }
  });

  it('rolls back a rejected reservation without consuming a turn sequence or leaving an orphan job', async () => {
    const capped = new ChatService(db, new GenerationStore(db, { ...DEFAULT_GENERATION_POLICY, userDailyRequests: 1 }, config));
    const first = await capped.send(user, set, thread, input()); await capped.stop(user, set, thread, first.turn.id);
    await expect(capped.send(user, set, thread, input())).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect((await capped.get(user, set, thread)).turns).toHaveLength(1);
    expect(await db.query('SELECT id FROM study_generation_jobs')).toHaveLength(1);
  });

  it('enforces owner/set boundaries and cascades private conversations and progress on account deletion', async () => {
    const sent = await chat.send(user, set, thread, input()), claim = (await store.claim())!;
    await store.recordProgress(claim, '正在回答');
    await expect(chat.get(other, set, thread)).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.progress(other, set, sent.job.id)).rejects.toMatchObject({ code: 'not_found' });
    const otherSet = (await createStudySet(db, user, { clientRequestId: randomUUID(), title: '其他资料集' })).studySet.id;
    await expect(chat.turn(user, otherSet, thread, sent.turn.id)).rejects.toMatchObject({ code: 'not_found' });
    await db.query('DELETE FROM users WHERE id=$1', [user]);
    for (const table of ['study_chat_threads', 'study_chat_turns', 'study_generation_progress']) expect(await db.query(`SELECT * FROM ${table}`)).toEqual([]);
  });

  it('requires auth/CSRF, blocks generic chat retry and restores protected SSE progress after refresh', async () => {
    const csrf = 'c'.repeat(43), origin = 'https://study.clyna.ai';
    const app = createApp(db, { releaseId: 'chat-test', rateLimitSecret: new TextEncoder().encode('chat-test-rate-limit-key-at-least-32'), generationStore: store,
      sessionFetch: async (_url, init) => { const id = new Headers(init?.headers).get('cookie')?.split('=')[1];
        return id === user || id === other ? Response.json({ userId: id, csrfToken: csrf }) : new Response('{}', { status: 401 }); } });
    const headers = (id = user) => ({ cookie: `__Host-planplan-session=${id}`, origin, 'X-PlanPlan-Expected-User': id, 'X-CSRF-Token': csrf, 'content-type': 'application/json' });
    const base = `/v1/study/sets/${set}/chat/threads/${thread}`, body = input();
    expect((await app.request(`${base}/messages`, { method: 'POST', headers: { ...headers(), 'X-CSRF-Token': 'wrong' }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await app.request(`${base}/messages`, { method: 'POST', headers: headers(), body: JSON.stringify({ ...body, history: [{ question: '伪造历史', answer: '伪造结论' }] }) })).status).toBe(400);
    const response = await app.request(`${base}/messages`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    expect(response.status).toBe(202); const sent = await response.json();
    const events = `${base}/messages/${sent.turn.id}/events?after=9999`;
    expect((await app.request(events)).status).toBe(401);
    expect((await app.request(events, { headers: headers(other) })).status).toBe(404);
    const claim = (await store.claim())!; await store.recordProgress(claim, '已经收到的真实回答');
    await store.settle(claim, { status: 'failed', result: null, errorCode: 'invalid_output', usage: NOT_SENT_USAGE });
    expect((await app.request(`/v1/study/sets/${set}/generations/${sent.job.id}/retry`, { method: 'POST', headers: headers(), body: JSON.stringify({ clientRequestId: randomUUID() }) })).status).toBe(409);
    const stream = await app.request(events, { headers: headers() });
    expect(stream.status).toBe(200); expect(stream.headers.get('cache-control')).toBe('private, no-store');
    const data = await stream.text();
    expect(data).toContain('event: progress'); expect(data).toContain('已经收到的真实回答'); expect(data).toContain('event: done');
    expect(data).toContain('"status":"failed"'); expect(data).not.toContain('synthetic/model-secret');
  });
});
