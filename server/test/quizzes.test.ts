import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import type { Db } from '../src/db/db.js';
import { openTestDb } from './database.js';
import { createStudySet, createTextMaterial, updateTextMaterial } from '../src/services/study-data.js';
import { GenerationStore } from '../src/generation/store.js';
import { createOpenRouterGenerationProvider } from '../src/generation/provider.js';
import { DEFAULT_GENERATION_POLICY, UNKNOWN_USAGE, type GenerationProviderConfig } from '../src/generation/types.js';
import { QUIZ_TABLES } from '../src/db/quizzes-schema.js';
import { answerQuiz, getQuiz, getQuizAttempt, listQuizAttempts, listQuizzes, materializeQuiz, startQuizAttempt, submitQuiz } from '../src/services/quizzes.js';
import { createApp } from '../src/api/app.js';
const quote = '绿色植物通过光合作用将光能转化为化学能，并储存在有机物中。';
const config: GenerationProviderConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'fixture/model', outputMode: 'strict', maxOutputTokens: 1024, timeoutMs: 1000, providerOnly: [] };
const csrf = 'a'.repeat(43);
describe('persisted generated quizzes and independent exam/practice attempts', () => {
  let db: Db, store: GenerationStore, alice: string, bob: string, setId: string, otherSet: string, materialId: string, jobId: string, quizId: string;
  beforeEach(async () => {
    db = await openTestDb();
    const users = await db.query<{ id: string }>('INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id');
    alice = users[0]!.id; bob = users[1]!.id;
    setId = (await createStudySet(db, alice, { clientRequestId: randomUUID(), title: 'Quiz' })).studySet.id;
    otherSet = (await createStudySet(db, alice, { clientRequestId: randomUUID(), title: 'Other' })).studySet.id;
    materialId = (await createTextMaterial(db, alice, setId, { clientRequestId: randomUUID(), title: 'Source', body: quote })).material.id;
    store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config);
    const { job } = await store.create(alice, setId, { clientRequestId: randomUUID(), kind: 'quiz', sources: [{ materialId, version: 1 }], config: { language: 'zh-CN', singleChoiceCount: 1, trueFalseCount: 1 } });
    jobId = job.id;
    const claim = (await store.claim())!;
    const provider = createOpenRouterGenerationProvider({ config, apiKey: 'synthetic-only-test-key', fetch: async () => Response.json({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '光合作用测验', questions: [
        { type: 'single_choice', prompt: '光合作用将光能转化为什么？', options: ['声能', '化学能', '电能', '机械能'], answerIndex: 1, explanation: '资料指出光能转化成化学能。', citations: [{ sourceId: 's1', quote }] },
        { type: 'true_false', prompt: '光合作用的能量会储存在有机物中。', options: ['正确', '错误'], answerIndex: 0, explanation: '原文明确能量储存在有机物中。', citations: [{ sourceId: 's1', quote }] },
      ] }) } }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
    }) });
    const outcome = await provider.generate(claim, new AbortController().signal);
    expect(outcome.status).toBe('succeeded'); await store.settle(claim, outcome);
    quizId = (await materializeQuiz(db, store, alice, setId, { clientRequestId: randomUUID(), generationId: jobId })).quiz.id;
  }, 30_000);
  afterEach(async () => { await db?.close(); });
  const start = (mode: 'exam' | 'practice') => startQuizAttempt(db, alice, setId, quizId, { mode, clientRequestId: randomUUID() });
  const answer = (id: string, version: number, questionIndex: number, answerIndex: number, clientRequestId = randomUUID()) => answerQuiz(db, alice, setId, quizId, id, { version, questionIndex, answerIndex, clientRequestId });
  it('materializes once, exposes no answer key and retains old sources after edits', async () => {
    expect(await materializeQuiz(db, store, alice, setId, { clientRequestId: randomUUID(), generationId: jobId })).toMatchObject({ replayed: true, quiz: { id: quizId } });
    const quiz = await getQuiz(db, alice, setId, quizId);
    expect(JSON.stringify(quiz)).not.toContain('answerIndex'); expect(JSON.stringify(quiz)).not.toContain('explanation');
    await updateTextMaterial(db, alice, setId, materialId, { version: 1, body: '资料已修改，旧测验必须保留原文。' });
    const { attempt } = await start('practice'); expect(attempt.sourceSnapshots?.[0]).toMatchObject({ body: quote, version: 1 });
    expect((await listQuizzes(db, alice, setId, { limit: 10 })).items).toHaveLength(1);
  });
  it('binds alternate materialization request IDs to their original generation', async () => {
    const clientRequestId = randomUUID();
    expect(await materializeQuiz(db, store, alice, setId, { clientRequestId, generationId: jobId })).toMatchObject({ quiz: { id: quizId }, replayed: true });
    const previous = await store.get(alice, setId, jobId);
    const { job } = await store.create(alice, setId, { clientRequestId: randomUUID(), kind: 'quiz', sources: [{ materialId, version: 1 }], config: { language: 'zh-CN', singleChoiceCount: 1, trueFalseCount: 1 } });
    const claim = (await store.claim())!;
    await store.settle(claim, { status: 'succeeded', result: previous.result, errorCode: null, usage: UNKNOWN_USAGE });
    await expect(materializeQuiz(db, store, alice, setId, { clientRequestId, generationId: job.id })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect((await listQuizzes(db, alice, setId, { limit: 10 })).items).toHaveLength(1);
    expect(await materializeQuiz(db, store, alice, setId, { clientRequestId, generationId: jobId })).toMatchObject({ quiz: { id: quizId }, replayed: true });
  });
  it('exam autosave/resume reveals no keys, explanations, correctness or review until submission', async () => {
    let { attempt } = await start('exam');
    attempt = (await answer(attempt.id, 1, 0, 1)).attempt; attempt = (await answer(attempt.id, attempt.version, 1, 1)).attempt;
    const resumed = await getQuizAttempt(db, alice, setId, quizId, attempt.id);
    expect(resumed.questions.map(q => q.selectedAnswerIndex)).toEqual([1, 1]); expect(resumed.score).toBeNull(); expect(resumed).not.toHaveProperty('sourceSnapshots');
    for (const q of resumed.questions) for (const field of ['correctAnswerIndex', 'correct', 'explanation', 'citations', 'history', 'answerIndex']) expect(q).not.toHaveProperty(field);
    const submitted = (await submitQuiz(db, alice, setId, quizId, attempt.id, { version: attempt.version, clientRequestId: randomUUID() })).attempt;
    expect(submitted.score).toEqual({ total: 2, firstCorrect: 1, finalCorrect: 1, firstCorrectRate: 50, finalScore: 50 });
    expect(submitted.questions[1]).toMatchObject({ correctAnswerIndex: 0, correct: false });
  });
  it('practice preserves wrong-to-correct history and includes the final question in distinct first/final scores', async () => {
    let { attempt } = await start('practice'); attempt = (await answer(attempt.id, attempt.version, 0, 0)).attempt;
    expect(attempt.questions[0]).toMatchObject({ correct: false, correctAnswerIndex: 1 }); expect(attempt.questions[1]).not.toHaveProperty('correctAnswerIndex');
    attempt = (await answer(attempt.id, attempt.version, 0, 1)).attempt; attempt = (await answer(attempt.id, attempt.version, 1, 0)).attempt;
    const submitted = (await submitQuiz(db, alice, setId, quizId, attempt.id, { version: attempt.version, clientRequestId: randomUUID() })).attempt;
    expect(submitted.questions[0]!.history?.map(v => v.correct)).toEqual([false, true]);
    expect(submitted.score).toEqual({ total: 2, firstCorrect: 1, finalCorrect: 2, firstCorrectRate: 50, finalScore: 100 });
  });
  it('idempotency and optimistic versions reject duplicate or stale mutations without dropping history', async () => {
    const { attempt } = await start('practice'), request = randomUUID();
    await answer(attempt.id, 1, 0, 0, request); expect((await answer(attempt.id, 1, 0, 0, request)).replayed).toBe(true);
    await expect(answer(attempt.id, 1, 0, 1, request)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(answer(attempt.id, 1, 1, 0)).rejects.toMatchObject({ code: 'version_conflict' });
    const saved = await getQuizAttempt(db, alice, setId, quizId, attempt.id); expect(saved.version).toBe(2); expect(saved.questions[0]!.history).toHaveLength(1);
  });
  it('concurrent submits grade once and immutable submitted history is independent from a fresh attempt', async () => {
    let { attempt } = await start('exam'); attempt = (await answer(attempt.id, attempt.version, 0, 1)).attempt; attempt = (await answer(attempt.id, attempt.version, 1, 0)).attempt;
    const input = { version: attempt.version, clientRequestId: randomUUID() };
    const results = await Promise.all([submitQuiz(db, alice, setId, quizId, attempt.id, input), submitQuiz(db, alice, setId, quizId, attempt.id, input)]);
    expect(results.filter(v => !v.replayed)).toHaveLength(1); expect(await db.query("SELECT id FROM study_quiz_events WHERE attempt_id=$1 AND kind='submit'", [attempt.id])).toHaveLength(1);
    await expect(answer(attempt.id, results[0]!.attempt.version, 0, 0)).rejects.toMatchObject({ code: 'job_conflict' });
    const fresh = await start('practice'); expect(fresh.attempt.id).not.toBe(attempt.id); expect(fresh.attempt.questions.every(q => q.selectedAnswerIndex === null)).toBe(true);
    expect((await getQuizAttempt(db, alice, setId, quizId, attempt.id)).score?.finalScore).toBe(100);
  });
  it('requires every question, validates options and scopes quiz/attempt ownership', async () => {
    const { attempt } = await start('exam');
    await expect(submitQuiz(db, alice, setId, quizId, attempt.id, { version: 1, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(answer(attempt.id, 1, 1, 2)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(getQuiz(db, bob, setId, quizId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getQuizAttempt(db, alice, otherSet, quizId, attempt.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getQuizAttempt(db, bob, setId, quizId, attempt.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('start intents replay once, reject changed mode, and paginate distinct attempt records', async () => {
    const clientRequestId = randomUUID(); const first = await startQuizAttempt(db, alice, setId, quizId, { clientRequestId, mode: 'exam' });
    expect((await startQuizAttempt(db, alice, setId, quizId, { clientRequestId, mode: 'exam' })).attempt.id).toBe(first.attempt.id);
    await expect(startQuizAttempt(db, alice, setId, quizId, { clientRequestId, mode: 'practice' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await start('practice'); await start('practice');
    const page = await listQuizAttempts(db, alice, setId, quizId, { limit: 2 }); expect(page.items).toHaveLength(2);
    const last = await listQuizAttempts(db, alice, setId, quizId, { limit: 2, cursor: page.nextCursor! }); expect(last.items).toHaveLength(1);
    expect(new Set([...page.items, ...last.items].map(v => v.id)).size).toBe(3);
  });
  it('account deletion removes quiz snapshots, attempts and answer history through foreign keys', async () => {
    const { attempt } = await start('practice'); await answer(attempt.id, attempt.version, 0, 0);
    await db.query('DELETE FROM users WHERE id=$1', [alice]);
    for (const table of QUIZ_TABLES) {
      expect(await db.query(`SELECT id FROM ${table} WHERE user_id=$1`, [alice])).toEqual([]);
    }
  });
  it('HTTP enforces session/CSRF/strict bodies/methods and generic generation responses cannot bypass exam hiding', async () => {
    const app = createApp(db, { releaseId: 'synthetic-quiz-test', generationStore: store, rateLimitSecret: new TextEncoder().encode('synthetic-quiz-test-rate-limit-secret'),
      sessionFetch: async (_url, init) => { const user = new Headers(init?.headers).get('cookie')?.split('=')[1]; return [alice, bob].includes(user ?? '') ? Response.json({ userId: user, csrfToken: csrf }) : new Response('{}', { status: 401 }); } });
    const headers = (user = alice) => ({ cookie: `__Host-planplan-session=${user}`, origin: 'https://study.clyna.ai', 'X-PlanPlan-Expected-User': user, 'X-CSRF-Token': csrf, 'content-type': 'application/json' });
    const path = `/v1/study/sets/${setId}/quizzes/${quizId}/attempts`;
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { method: 'POST', headers: { ...headers(), 'X-CSRF-Token': 'wrong' }, body: JSON.stringify({ mode: 'exam', clientRequestId: randomUUID() }) })).status).toBe(403);
    expect((await app.request(path, { method: 'POST', headers: headers(), body: JSON.stringify({ mode: 'exam', clientRequestId: randomUUID(), answers: [1, 0] }) })).status).toBe(400);
    expect((await app.request(path, { headers: headers(bob) })).status).toBe(404);
    expect((await app.request(path, { method: 'PATCH', headers: headers() })).status).toBe(405);
    const started = await app.request(path, { method: 'POST', headers: headers(), body: JSON.stringify({ mode: 'exam', clientRequestId: randomUUID() }) });
    expect(started.status).toBe(201); expect(started.headers.get('cache-control')).toBe('private, no-store');
    expect((await started.json()).attempt.questions[0]).not.toHaveProperty('correctAnswerIndex');
    const generic = await app.request(`/v1/study/sets/${setId}/generations/${jobId}`, { headers: headers() }); expect(generic.status).toBe(200); expect((await generic.json()).job.result).toBeNull();
  });
});
