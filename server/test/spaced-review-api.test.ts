import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { registerFlashcardRoutes } from '../src/api/flashcards.js';
import { SharedRateLimiter } from '../src/runtime/rate-limit.js';
import { createStudySet } from '../src/services/study-data.js';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
const csrf = 'f'.repeat(43), origin = 'https://study.clyna.ai', secret = new Uint8Array(32).fill(6);
describe('flashcard HTTP validation and shared session boundary', () => {
    let db: Db, app: ReturnType<typeof createApp>, user: string, other: string, set: string;
    const root = () => `/v1/study/sets/${set}/flashcard-decks`;
    const headers = (id = user) => ({ cookie: `__Host-planplan-session=${id}`, origin, 'X-PlanPlan-Expected-User': id, 'X-CSRF-Token': csrf, 'content-type': 'application/json' });
    const send = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}, id = user) => app.request(path, { method, headers: { ...headers(id), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    beforeAll(async () => { db = await openTestDb(); });
    afterAll(async () => { await db?.close(); });
    beforeEach(async () => { await db.query('DELETE FROM users'); const rows = await db.query<{
        id: string;
    }>('INSERT INTO users(id) VALUES(DEFAULT),(DEFAULT) RETURNING id'); [user, other] = rows.map(r => r.id) as [
        string,
        string
    ]; set = (await createStudySet(db, user, { clientRequestId: randomUUID(), title: 'HTTP学习集' })).studySet.id; app = createApp(db, { releaseId: 'flashcards-test', rateLimitSecret: secret, sessionFetch: async (_url, init) => { const id = new Headers(init?.headers).get('cookie')?.split('=')[1]; return Response.json({ userId: id, csrfToken: csrf }); } }); if (!app.routes.some(r => r.path === '/v1/study/sets/:setId/flashcard-decks'))
        registerFlashcardRoutes(app, db, undefined, new SharedRateLimiter(db, secret)); });
    it('validates SRS HTTP identity, methods, CSRF, body and durable actions', async () => { const { deck } = await (await send(root(), 'POST', { clientRequestId: randomUUID(), title: '复习' })).json(); const path = root() + '/' + deck.id; const { card } = await (await send(path + '/cards', 'POST', { clientRequestId: randomUUID(), front: '问题', back: '答案' })).json(); expect((await send(path + '/review-queue')).status).toBe(200); expect((await send(path + '/review-queue', 'POST', {})).status).toBe(405); expect((await send(path + '/review-sessions', 'GET')).status).toBe(405); expect((await send(path + '/review-sessions', 'POST', { clientRequestId: randomUUID() }, { 'X-CSRF-Token': 'bad' })).status).toBe(403); expect((await send(path + '/review-queue', 'GET', undefined, {}, other)).status).toBe(404); expect((await send(path + '/review-sessions', 'POST', { clientRequestId: randomUUID(), extra: 'bad' })).status).toBe(400); expect((await send(path + '/review-sessions', 'POST', { clientRequestId: randomUUID(), extra: 'x'.repeat(40000) })).status).toBe(413); const { session } = await (await send(path + '/review-sessions', 'POST', { clientRequestId: randomUUID() })).json(); const body = { clientRequestId: randomUUID(), version: 1, position: 0, cardId: card.id, action: 'rate', rating: 'good' }, action = path + '/review-sessions/' + session.id + '/actions'; const saved = await send(action, 'POST', body); expect(saved.status).toBe(201); expect((await saved.json()).session.status).toBe('completed'); expect((await send(action, 'POST', body)).status).toBe(200); expect((await send(path + '/review-sessions', 'POST', { clientRequestId: randomUUID() })).status).toBe(409); expect((await (await send(path + '/review-queue')).json()).newCount).toBe(0); expect((await send(path + '/review-sessions/' + session.id, 'GET', undefined, {}, other)).status).toBe(404); });
});
