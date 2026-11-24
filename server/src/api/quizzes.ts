import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { SharedRateLimiter } from '../runtime/rate-limit.js';
import { GenerationError } from '../generation/types.js';
import { answerQuiz, getQuiz, getQuizAttempt, listQuizAttempts, listQuizzes, materializeQuiz, startQuizAttempt, submitQuiz, type QuizGenerationReader } from '../services/quizzes.js';
import type { StudyEnv } from './auth.js';
import { readJson } from './study.js';
const id = z.uuid().transform(value => value.toLowerCase());
const version = z.number().int().min(1).max(2147483646);
const create = z.object({ clientRequestId: id, generationId: id }).strict();
const start = z.object({ clientRequestId: id, mode: z.enum(['practice', 'exam']) }).strict();
const answer = z.object({ clientRequestId: id, version, questionIndex: z.number().int().min(0).max(19), answerIndex: z.number().int().min(0).max(5) }).strict();
const submit = z.object({ clientRequestId: id, version }).strict();
const page = z.object({ limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().max(50)).optional().default(20), cursor: id.optional() }).strict();
export function registerQuizRoutes(app: Hono<StudyEnv>, db: Db, generations: QuizGenerationReader | undefined, limits: SharedRateLimiter): void {
  const base = '/v1/study/sets/:setId/quizzes';
  // This guard is scoped to quiz paths and leaves unrelated APIs unchanged.
  app.use(`${base}/*`, async (c, next) => {
    const suffix = c.req.path.split('/quizzes')[1] ?? '';
    const methods = /^\/[^/]+$/.test(suffix) || /^\/[^/]+\/attempts\/[^/]+$/.test(suffix) ? ['GET']
      : /^\/[^/]+\/attempts$/.test(suffix) ? ['GET', 'POST'] : /^\/[^/]+\/attempts\/[^/]+\/(answers|submit)$/.test(suffix) ? ['POST'] : null;
    if (methods && !methods.includes(c.req.method)) return c.json({ error: { code: 'method_not_allowed', message: '此接口不支持该请求方法。' } }, 405);
    await next();
  });
  app.use(base, async (c, next) => {
    if (!['GET', 'POST'].includes(c.req.method)) return c.json({ error: { code: 'method_not_allowed', message: '此接口不支持该请求方法。' } }, 405);
    await next();
  });
  app.get(base, async c => {
    if (Object.values(c.req.queries()).some(values => values.length !== 1)) throw new GenerationError('invalid_input', '分页参数无效。');
    return c.json(await listQuizzes(db, c.get('userId'), id.parse(c.req.param('setId')), page.parse(c.req.query())));
  });
  app.post(base, async c => {
    const user = c.get('userId'); await limits.consume('write', user, 120);
    const result = await materializeQuiz(db, generations, user, id.parse(c.req.param('setId')), create.parse(await readJson(c, 16384)));
    return c.json({ quiz: result.quiz }, result.replayed ? 200 : 201);
  });
  app.get(`${base}/:quizId`, async c => c.json({ quiz: await getQuiz(db, c.get('userId'), id.parse(c.req.param('setId')), id.parse(c.req.param('quizId'))) }));
  app.get(`${base}/:quizId/attempts`, async c => {
    if (Object.values(c.req.queries()).some(values => values.length !== 1)) throw new GenerationError('invalid_input', '分页参数无效。');
    return c.json(await listQuizAttempts(db, c.get('userId'), id.parse(c.req.param('setId')), id.parse(c.req.param('quizId')), page.parse(c.req.query())));
  });
  app.post(`${base}/:quizId/attempts`, async c => {
    const user = c.get('userId'); await limits.consume('write', user, 120);
    const result = await startQuizAttempt(db, user, id.parse(c.req.param('setId')), id.parse(c.req.param('quizId')), start.parse(await readJson(c, 16384)));
    return c.json({ attempt: result.attempt }, result.replayed ? 200 : 201);
  });
  app.get(`${base}/:quizId/attempts/:attemptId`, async c => c.json({ attempt: await getQuizAttempt(db, c.get('userId'), id.parse(c.req.param('setId')), id.parse(c.req.param('quizId')), id.parse(c.req.param('attemptId'))) }));
  for (const action of ['answers', 'submit'] as const) app.post(`${base}/:quizId/attempts/:attemptId/${action}`, async c => {
    const user = c.get('userId'); await limits.consume('write', user, 120);
    const params = [db, user, id.parse(c.req.param('setId')), id.parse(c.req.param('quizId')), id.parse(c.req.param('attemptId'))] as const;
    const body = await readJson(c, 16384);
    const result = action === 'answers' ? await answerQuiz(...params, answer.parse(body)) : await submitQuiz(...params, submit.parse(body));
    return c.json({ attempt: result.attempt });
  });
}
