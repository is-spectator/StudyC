import { MistakeService, backfillMistakes } from '../src/services/mistakes.js';
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
describe('mistake facts and independent retraining', () => {
    let db: Db, store: GenerationStore, alice: string, bob: string, setId: string, otherSet: string, materialId: string, jobId: string, quizId: string;
    beforeEach(async () => {
        db = await openTestDb();
        const users = await db.query<{
            id: string;
        }>('INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id');
        alice = users[0]!.id;
        bob = users[1]!.id;
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
        expect(outcome.status).toBe('succeeded');
        await store.settle(claim, outcome);
        quizId = (await materializeQuiz(db, store, alice, setId, { clientRequestId: randomUUID(), generationId: jobId })).quiz.id;
    }, 30000);
    afterEach(async () => {
        await db?.close();
    });
    const start = (mode: 'exam' | 'practice') => startQuizAttempt(db, alice, setId, quizId, { mode, clientRequestId: randomUUID() });
    const answer = (id: string, version: number, questionIndex: number, answerIndex: number, clientRequestId = randomUUID()) => answerQuiz(db, alice, setId, quizId, id, { version, questionIndex, answerIndex, clientRequestId });
    async function mistakes(correctAfter = false) {
        let a = (await start('practice')).attempt;
        a = (await answer(a.id, a.version, 0, 0)).attempt;
        if (correctAfter)
            a = (await answer(a.id, a.version, 0, 1)).attempt;
        a = (await answer(a.id, a.version, 1, 1)).attempt;
        if (correctAfter)
            a = (await answer(a.id, a.version, 1, 0)).attempt;
        return (await submitQuiz(db, alice, setId, quizId, a.id, { version: a.version, clientRequestId: randomUUID() })).attempt;
    }
    const service = () => new MistakeService(db);
    it('keeps unsubmitted exams and practice out of all mistake endpoints', async () => {
        const a = (await start('exam')).attempt;
        await answer(a.id, a.version, 0, 0);
        expect((await service().list(alice, setId, { limit: 20 })).items).toEqual([]);
        await expect(service().list(alice, setId, { limit: 20, attemptId: a.id })).rejects.toMatchObject({ code: 'not_found' });
        await expect(service().detail(alice, setId, quizId, 0)).rejects.toMatchObject({ code: 'not_found' });
        await expect(service().start(alice, setId, { clientRequestId: randomUUID(), quizId, questionIndices: [0] })).rejects.toMatchObject({ code: 'not_found' });
    });
    it('records first errors after corrections, deduplicates repeated submission/backfill and groups attempts', async () => {
        const a = await mistakes(true);
        expect(a.score).toMatchObject({ firstCorrectRate: 0, finalScore: 100 });
        expect((await service().list(alice, setId, { limit: 20 })).items).toMatchObject([{ wrongCount: 1, firstWrongCount: 1, finalWrongCount: 0 }, { wrongCount: 1, firstWrongCount: 1, finalWrongCount: 0 }]);
        await submitQuiz(db, alice, setId, quizId, a.id, { version: a.version, clientRequestId: randomUUID() });
        expect(await backfillMistakes(db)).toEqual({ inserted: 0 });
        await mistakes();
        expect((await service().list(alice, setId, { limit: 20 })).items).toMatchObject([{ wrongCount: 2, finalWrongCount: 1 }, { wrongCount: 2, finalWrongCount: 1 }]);
        expect((await service().detail(alice, setId, quizId, 0)).origins).toHaveLength(2);
    });
    it('freezes independent retry, preserves first/final score and never changes original scores or wrong counts', async () => {
        const original = await mistakes();
        const input = { clientRequestId: randomUUID(), quizId, questionIndices: [1, 0] }, r = await service().start(alice, setId, input);
        expect((await service().start(alice, setId, input)).review.id).toBe(r.review.id);
        let v = r.review;
        expect(v.questions.map((q: any) => q.originalQuestionIndex)).toEqual([0, 1]);
        const body = { clientRequestId: randomUUID(), version: v.version, questionIndex: 0, answerIndex: 0 };
        v = (await service().mutate(alice, setId, v.id, body, 'answer')).review;
        expect((await service().mutate(alice, setId, v.id, body, 'answer')).replayed).toBe(true);
        await expect(service().mutate(alice, setId, v.id, { ...body, answerIndex: 1 }, 'answer')).rejects.toMatchObject({ code: 'idempotency_conflict' });
        v = (await service().mutate(alice, setId, v.id, { clientRequestId: randomUUID(), version: v.version, questionIndex: 0, answerIndex: 1 }, 'answer')).review;
        v = (await service().mutate(alice, setId, v.id, { clientRequestId: randomUUID(), version: v.version, questionIndex: 1, answerIndex: 1 }, 'answer')).review;
        v = (await service().mutate(alice, setId, v.id, { clientRequestId: randomUUID(), version: v.version }, 'submit')).review;
        expect(v.score).toMatchObject({ firstCorrectRate: 0, finalScore: 50 });
        expect((await getQuizAttempt(db, alice, setId, quizId, original.id)).score).toEqual(original.score);
        expect((await service().list(alice, setId, { limit: 20 })).items).toMatchObject([{ wrongCount: 1, latestReview: { correct: true } }, { wrongCount: 1, latestReview: { correct: false } }]);
    });
    it('recovers source snapshots and rejects cross-account, set, unknown questions and stale writes', async () => {
        await mistakes();
        const r = (await service().start(alice, setId, { clientRequestId: randomUUID(), quizId, questionIndices: [0] })).review;
        await expect(service().get(bob, setId, r.id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(service().get(alice, otherSet, r.id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(service().start(alice, setId, { clientRequestId: randomUUID(), quizId, questionIndices: [3] })).rejects.toMatchObject({ code: 'not_found' });
        await expect(service().start(alice, setId, { clientRequestId: randomUUID(), quizId, questionIndices: [0, 0] })).rejects.toThrow();
        const input = { clientRequestId: randomUUID(), version: r.version, questionIndex: 0, answerIndex: 1 };
        const answered = (await service().mutate(alice, setId, r.id, input, 'answer')).review;
        await expect(service().mutate(alice, setId, r.id, { ...input, clientRequestId: randomUUID() }, 'answer')).rejects.toMatchObject({ code: 'version_conflict' });
        await updateTextMaterial(db, alice, setId, materialId, { version: 1, body: '来源已改变，原引用仍应保存。' });
        expect((await new MistakeService(db).get(alice, setId, r.id)).questions[0].sourceSnapshots?.[0]).toMatchObject({ version: 1, body: quote });
        expect(answered.questions[0].correct).toBe(true);
    });
    it('supports owner-bound pagination and backfills existing submitted history repeatedly', async () => {
        await mistakes();
        await db.query('DELETE FROM study_mistake_facts');
        expect(await backfillMistakes(db)).toEqual({ inserted: 2 });
        expect(await backfillMistakes(db)).toEqual({ inserted: 0 });
        const p = await service().list(alice, setId, { limit: 1 });
        expect(p.items).toHaveLength(1);
        const next = await service().list(alice, setId, { limit: 1, cursor: p.nextCursor! });
        expect(next.items[0]!.questionIndex).not.toBe(p.items[0]!.questionIndex);
        await expect(service().list(bob, otherSet, { limit: 1, cursor: p.nextCursor! })).rejects.toMatchObject({ code: 'not_found' });
    });
});
// HTTP boundary coverage uses the same real Hono app and submitted fixtures.
it('exposes only authenticated owner mistakes and validates methods/CSRF/body before writes', async () => {
    const { createApp } = await import('../src/api/app.js');
    const db = await openTestDb();
    try {
        const [u] = await db.query<{
            id: string;
        }>('INSERT INTO users(id) VALUES(default) RETURNING id');
        const user = u!.id;
        const set = (await createStudySet(db, user, { clientRequestId: randomUUID(), title: 'HTTP边界' })).studySet.id;
        const app = createApp(db, { releaseId: 'mistakes-http', rateLimitSecret: new Uint8Array(32).fill(8), sessionFetch: async () => Response.json({ userId: user, csrfToken: 'a'.repeat(43) }) });
        const headers = { cookie: '__Host-planplan-session=test', 'X-PlanPlan-Expected-User': user, 'X-CSRF-Token': 'a'.repeat(43), origin: 'https://study.clyna.ai', 'content-type': 'application/json' }, base = `/v1/study/sets/${set}`;
        expect((await app.request(base + '/mistakes')).status).toBe(401);
        expect((await app.request(base + '/mistakes', { headers })).status).toBe(200);
        expect((await app.request(base + '/mistakes', { method: 'POST', headers, body: '{}' })).status).toBe(405);
        expect((await app.request(base + '/mistake-reviews', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body: '{}' })).status).toBe(403);
        expect((await app.request(base + '/mistake-reviews', { method: 'POST', headers, body: JSON.stringify({ clientRequestId: randomUUID(), quizId: randomUUID(), questionIndices: [0], score: 100 }) })).status).toBe(400);
        expect((await app.request(base + '/mistake-reviews', { method: 'POST', headers, body: JSON.stringify({ extra: 'x'.repeat(17000) }) })).status).toBe(413);
        expect((await app.request(base + '/mistakes?quizId=x&quizId=y', { headers })).status).toBe(400);
        expect((await app.request(base + '/mistake-reviews/' + randomUUID(), { headers })).status).toBe(404);
    }
    finally {
        await db.close();
    }
});
it('v7 upgrade backfills submitted mistakes without changing old data or migration records', async () => {
    const { migrate, checkMigrations } = await import('../src/db/migrations.js');
    const db = await openTestDb();
    try {
        const [owner] = await db.query<{
            id: string;
        }>('INSERT INTO users(id) VALUES(default) RETURNING id');
        const user = owner!.id;
        const set = (await createStudySet(db, user, { clientRequestId: randomUUID(), title: '升级保留' })).studySet.id;
        const body = '绿色植物通过光合作用将光能转化为化学能，并储存在有机物中。';
        const material = (await createTextMaterial(db, user, set, { clientRequestId: randomUUID(), title: '旧资料', body })).material;
        const store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config);
        const { job } = await store.create(user, set, { clientRequestId: randomUUID(), kind: 'quiz', sources: [{ materialId: material.id, version: 1 }], config: { language: 'zh-CN', singleChoiceCount: 0, trueFalseCount: 1 } });
        const claim = (await store.claim())!;
        await store.settle(claim, { status: 'succeeded', errorCode: null, usage: UNKNOWN_USAGE, result: { schemaVersion: 1, title: '旧测验', questions: [{ type: 'true_false', prompt: '能量储存在有机物？', options: ['正确', '错误'], answerIndex: 0, explanation: '原文如此。', citations: [{ sourceId: 's1', materialId: material.id, version: 1, quote: body, start: 0, end: body.length, page: null }] }] } });
        const quiz = (await materializeQuiz(db, store, user, set, { clientRequestId: randomUUID(), generationId: job.id })).quiz;
        let a = (await startQuizAttempt(db, user, set, quiz.id, { clientRequestId: randomUUID(), mode: 'exam' })).attempt;
        a = (await answerQuiz(db, user, set, quiz.id, a.id, { version: a.version, questionIndex: 0, answerIndex: 1, clientRequestId: randomUUID() })).attempt;
        a = (await submitQuiz(db, user, set, quiz.id, a.id, { version: a.version, clientRequestId: randomUUID() })).attempt;
        await db.exec('DROP TABLE study_mistake_review_events; DROP TABLE study_mistake_reviews; DROP TABLE study_mistake_facts; DELETE FROM studyc_schema_migrations WHERE version=8');
        const old = await db.query('SELECT * FROM studyc_schema_migrations ORDER BY version');
        await migrate(db);
        await migrate(db);
        await checkMigrations(db);
        expect(await db.query('SELECT * FROM studyc_schema_migrations WHERE version<=7 ORDER BY version')).toEqual(old);
        expect((await new MistakeService(db).list(user, set, { limit: 20 })).items).toMatchObject([{ wrongCount: 1 }]);
        expect((await getQuizAttempt(db, user, set, quiz.id, a.id)).score).toEqual(a.score);
        expect(await backfillMistakes(db)).toEqual({ inserted: 0 });
    }
    finally {
        await db.close();
    }
});
it('maintenance rejects unsubmitted rows and closed feature blocks retraining writes', async () => {
    const db = await openTestDb();
    const previous = process.env.STUDYC_MISTAKES_ENABLED;
    try {
        const [u] = await db.query<{
            id: string;
        }>('INSERT INTO users(id) VALUES(default) RETURNING id');
        const set = (await createStudySet(db, u!.id, { clientRequestId: randomUUID(), title: '关闭验证' })).studySet.id;
        process.env.STUDYC_MISTAKES_ENABLED = 'false';
        expect((await new MistakeService(db).list(u!.id, set, { limit: 20 })).enabled).toBe(false);
        await expect(new MistakeService(db).start(u!.id, set, { clientRequestId: randomUUID(), quizId: randomUUID(), questionIndices: [0] })).rejects.toMatchObject({ code: 'service_unavailable' });
        expect(await backfillMistakes(db)).toEqual({ inserted: 0 });
    }
    finally {
        if (previous === undefined)
            delete process.env.STUDYC_MISTAKES_ENABLED;
        else
            process.env.STUDYC_MISTAKES_ENABLED = previous;
        await db.close();
    }
});
