import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { SharedRateLimiter } from '../runtime/rate-limit.js';
import type { StudyEnv } from './auth.js';
import { readJson } from './study.js';
import { SpacedReviewService } from '../services/spaced-review.js';
export function registerSpacedRoutes(app: Hono<StudyEnv>, db: Db, limits: SharedRateLimiter) {
    const service = new SpacedReviewService(db), root = '/v1/study/sets/:setId/flashcard-decks/:deckId', uuid = z.uuid();
    const ids = (c: any) => [c.get('userId'), uuid.parse(c.req.param('setId')), uuid.parse(c.req.param('deckId'))] as const;
    app.get(`${root}/review-queue`, async (c) => c.json(await service.queue(...ids(c))));
    app.post(`${root}/review-sessions`, async (c) => { await limits.consume('write', c.get('userId'), 120); const r = await service.start(...ids(c), await readJson(c, 32768)); return c.json(r, r.replayed ? 200 : 201); });
    app.get(`${root}/review-sessions/:sessionId`, async (c) => c.json({ session: await service.get(...ids(c), uuid.parse(c.req.param('sessionId'))) }));
    app.post(`${root}/review-sessions/:sessionId/actions`, async (c) => { await limits.consume('write', c.get('userId'), 120); const r = await service.act(...ids(c), uuid.parse(c.req.param('sessionId')), await readJson(c, 32768)); return c.json(r, r.replayed ? 200 : 201); });
}
