import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { StudyEnv } from './auth.js';
import type { SharedRateLimiter } from '../runtime/rate-limit.js';
import { MistakeService } from '../services/mistakes.js';
import { GenerationError } from '../generation/types.js';
import { readJson } from './study.js';
const uuid = z.uuid().transform(v => v.toLowerCase());
const question = z.coerce.number().int().min(0).max(19);
export function registerMistakeRoutes(app: Hono<StudyEnv>, db: Db, limits: SharedRateLimiter) {
    const service = new MistakeService(db), root = '/v1/study/sets/:setId';
    const ids = (c: Context<StudyEnv>) => [c.get('userId'), uuid.parse(c.req.param('setId'))] as const;
    const query = (c: Context<StudyEnv>) => {
        if (Object.values(c.req.queries()).some(a => a.length !== 1))
            throw new GenerationError('invalid_input', '分页参数无效。');
        return c.req.query();
    };
    const input = async (c: Context<StudyEnv>) => {
        await limits.consume('write', c.get('userId'), 120);
        return readJson(c, 16384);
    };
    app.get(`${root}/mistakes`, async (c) => {
        const options = z.object({ quizId: uuid.optional(), attemptId: uuid.optional(), cursor: z.string().max(50).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict().parse(query(c));
        return c.json(await service.list(...ids(c), options));
    });
    app.get(`${root}/mistakes/:quizId/:questionIndex`, async (c) => {
        const { cursor } = z.object({ cursor: uuid.optional() }).strict().parse(query(c));
        return c.json(await service.detail(...ids(c), uuid.parse(c.req.param('quizId')), question.parse(c.req.param('questionIndex')), cursor));
    });
    app.get(`${root}/mistake-reviews`, async (c) => {
        const { quizId, cursor } = z.object({ quizId: uuid.optional(), cursor: uuid.optional() }).strict().parse(query(c));
        return c.json(await service.history(...ids(c), quizId, cursor));
    });
    app.post(`${root}/mistake-reviews`, async (c) => {
        const r = await service.start(...ids(c), await input(c));
        return c.json(r, r.replayed ? 200 : 201);
    });
    app.get(`${root}/mistake-reviews/:reviewId`, async (c) => c.json({ review: await service.get(...ids(c), uuid.parse(c.req.param('reviewId'))) }));
    for (const action of ['answers', 'submit'] as const)
        app.post(`${root}/mistake-reviews/:reviewId/${action}`, async (c) => {
            const r = await service.mutate(...ids(c), uuid.parse(c.req.param('reviewId')), await input(c), action === 'answers' ? 'answer' : 'submit');
            return c.json(r, r.replayed ? 200 : 201);
        });
}
