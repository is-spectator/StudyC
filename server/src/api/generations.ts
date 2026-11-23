import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { GenerationStore } from '../generation/store.js';
import { GenerationError, MAX_SOURCES } from '../generation/types.js';
import type { SharedRateLimiter } from '../runtime/rate-limit.js';
import type { StudyEnv } from './auth.js';
import { readJson } from './study.js';

export type GenerationHttpStore = Pick<GenerationStore, 'create' | 'list' | 'get' | 'cancel' | 'retry' | 'usage'>;
const uuid = z.uuid().transform(value => value.toLowerCase());
const input = z.object({
  clientRequestId: uuid,
  kind: z.literal('study_outline'),
  sources: z.array(z.object({ materialId: uuid, version: z.number().int().min(1).max(2147483647) }).strict())
    .min(1).max(MAX_SOURCES).refine(sources => new Set(sources.map(source => source.materialId)).size === sources.length),
  config: z.object({ language: z.enum(['zh-CN', 'en']), pointCount: z.number().int().min(1).max(8) }).strict(),
}).strict();
const retryInput = z.object({ clientRequestId: uuid }).strict();
const cancelInput = z.object({}).strict();
const pagination = z.object({
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().max(100)).optional().default(50),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();

function listOptions(c: Context<StudyEnv>) {
  if (Object.values(c.req.queries()).some(values => values.length !== 1)) {
    throw new GenerationError('invalid_input', '分页参数无效。');
  }
  return pagination.parse(c.req.query());
}

/** Identity and method guards run in createApp before these protected handlers. */
export function registerGenerationRoutes(app: Hono<StudyEnv>, store: GenerationHttpStore | undefined, limits: SharedRateLimiter): void {
  const available = () => {
    if (!store) throw new GenerationError('service_unavailable', '生成服务暂时不可用。');
    return store;
  };
  const ids = (c: Context<StudyEnv>) => ({ userId: c.get('userId'), setId: uuid.parse(c.req.param('setId')) });
  const jobId = (c: Context<StudyEnv>) => uuid.parse(c.req.param('jobId'));
  const collection = '/v1/study/sets/:setId/generations';

  app.post(collection, async c => {
    const id = ids(c);
    await limits.consume('write', id.userId, 120);
    const body = input.parse(await readJson(c, 16 * 1024));
    const result = await available().create(id.userId, id.setId, body);
    return c.json({ job: result.job }, result.replayed ? 200 : 202);
  });
  app.get(collection, async c => {
    const id = ids(c);
    return c.json(await available().list(id.userId, id.setId, listOptions(c)));
  });
  app.get(`${collection}/:jobId`, async c => {
    const id = ids(c);
    return c.json({ job: await available().get(id.userId, id.setId, jobId(c)) });
  });
  app.post(`${collection}/:jobId/cancel`, async c => {
    const id = ids(c), job = jobId(c);
    await limits.consume('write', id.userId, 120);
    // No request body is needed; if one is supplied it must be an empty JSON object.
    if (c.req.raw.body) cancelInput.parse(await readJson(c, 16 * 1024));
    return c.json({ job: await available().cancel(id.userId, id.setId, job) });
  });
  app.post(`${collection}/:jobId/retry`, async c => {
    const id = ids(c), job = jobId(c);
    await limits.consume('write', id.userId, 120);
    const body = retryInput.parse(await readJson(c, 16 * 1024));
    const result = await available().retry(id.userId, id.setId, job, body);
    return c.json({ job: result.job }, result.replayed ? 200 : 202);
  });
  app.get('/v1/study/generation-usage', async c => c.json(await available().usage(c.get('userId'))));
}
