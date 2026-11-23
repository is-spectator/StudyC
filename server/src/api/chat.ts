import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { GenerationStore } from '../generation/store.js';
import { GenerationError, MAX_SOURCES } from '../generation/types.js';
import { ChatService } from '../services/chat.js';
import type { SharedRateLimiter } from '../runtime/rate-limit.js';
import type { StudyEnv } from './auth.js';
import { readJson } from './study.js';
const uuid = z.uuid().transform(x => x.toLowerCase());
const text = z.string().refine(x => !/[\u0000\uD800-\uDFFF]/u.test(x));
const newThread = z.object({ clientRequestId: uuid, title: text.trim().min(1).max(120).optional() }).strict();
const message = z.object({ clientRequestId: uuid, question: text.trim().min(1).max(2000), language: z.enum(['zh-CN', 'en']),
  sources: z.array(z.object({ materialId: uuid, version: z.number().int().min(1).max(2147483647) }).strict()).min(1).max(MAX_SOURCES)
    .refine(sources => new Set(sources.map(source => source.materialId)).size === sources.length) }).strict();
export function registerChatRoutes(app: Hono<StudyEnv>, db: Db, store: GenerationStore | undefined, limits: SharedRateLimiter): void {
  const service = store ? new ChatService(db, store) : null;
  const activeStreams = new Map<string, number>();
  const available = () => { if (!service) throw new GenerationError('service_unavailable', '对话服务暂时不可用。'); return service; };
  const ids = (c: Context<StudyEnv>) => [c.get('userId'), uuid.parse(c.req.param('setId'))] as const;
  const thread = (c: Context<StudyEnv>) => uuid.parse(c.req.param('threadId'));
  const turn = (c: Context<StudyEnv>) => uuid.parse(c.req.param('turnId'));
  const base = '/v1/study/sets/:setId/chat/threads';
  app.get(base, async c => c.json(await available().list(...ids(c))));
  app.post(base, async c => {
    const [user, set] = ids(c); await limits.consume('write', user, 120);
    const result = await available().create(user, set, newThread.parse(await readJson(c, 16 * 1024)));
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.get(`${base}/:threadId`, async c => c.json(await available().get(...ids(c), thread(c))));
  app.post(`${base}/:threadId/messages`, async c => {
    const [user, set] = ids(c); await limits.consume('chat', user, 30);
    const result = await available().send(user, set, thread(c), message.parse(await readJson(c, 32 * 1024)));
    return c.json(result, result.replayed ? 200 : 202);
  });
  const messages = `${base}/:threadId/messages/:turnId`;
  app.post(`${messages}/stop`, async c => {
    const [user, set] = ids(c); await limits.consume('write', user, 120);
    if (c.req.raw.body) z.object({}).strict().parse(await readJson(c, 1024));
    return c.json(await available().stop(user, set, thread(c), turn(c)));
  });
  app.post(`${messages}/retry`, async c => {
    const [user, set] = ids(c); await limits.consume('chat', user, 30);
    const result = await available().retry(user, set, thread(c), turn(c), z.object({ clientRequestId: uuid }).strict().parse(await readJson(c, 1024)));
    return c.json(result, result.replayed ? 200 : 202);
  });
  app.get(`${messages}/events`, async c => {
    const [user, set] = ids(c), threadId = thread(c), turnId = turn(c);
    if (Object.values(c.req.queries()).some(values => values.length !== 1)) throw new GenerationError('invalid_input', '流参数无效。');
    const query = z.object({ after: z.string().regex(/^\d{1,9}$/).transform(Number).optional().default(0) }).strict().parse(c.req.query());
    await limits.consume('chat', user, 30);
    const initial = await available().turn(user, set, threadId, turnId);
    if ((activeStreams.get(user) ?? 0) >= 2 || [...activeStreams.values()].reduce((sum, count) => sum + count, 0) >= 16) {
      throw new GenerationError('quota_exceeded', '正在查看的回答过多，请关闭其他对话后重试。');
    }
    activeStreams.set(user, (activeStreams.get(user) ?? 0) + 1);
    c.header('Cache-Control', 'private, no-store'); c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async stream => {
      try {
      let seq = query.after, attemptId = initial.job.attempts.at(-1)?.id, state = '', firstProgress = true;
      const deadline = Date.now() + 65_000;
      while (!stream.aborted && Date.now() < deadline) {
        // Each read rechecks active identity and ownership. Disconnecting this GET
        // never cancels the durable job; only the explicit stop route does so.
        const current = await available().turn(user, set, threadId, turnId);
        const currentAttempt = current.job.attempts.at(-1)?.id;
        if (currentAttempt !== attemptId) { attemptId = currentAttempt; seq = 0; firstProgress = true; }
        const progress = await store!.progress(user, set, current.jobId);
        // Always replay the current snapshot once: a cursor from an earlier
        // attempt must never suppress the low sequence numbers of a retry.
        if (progress && (firstProgress || progress.seq > seq)) {
          await stream.writeSSE({ event: 'progress', id: `${progress.attemptId}:${progress.seq}`, data: JSON.stringify(progress) }); seq = progress.seq; firstProgress = false;
        }
        const version = JSON.stringify([current.job.status, current.job.updatedAt, current.job.attempts.map(item => [item.status, item.usage.state])]);
        if (state !== version) { await stream.writeSSE({ event: 'job', data: JSON.stringify({ job: current.job }) }); state = version; }
        if (!['queued', 'running'].includes(current.job.status)
          && !current.job.attempts.some(attempt => ['queued', 'running'].includes(attempt.status))) {
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ jobId: current.jobId }) }); return;
        }
        await stream.sleep(250);
      }
      if (!stream.aborted) await stream.writeSSE({ event: 'reconnect', data: '{}' });
      } finally {
        const count = (activeStreams.get(user) ?? 1) - 1;
        if (count) activeStreams.set(user, count); else activeStreams.delete(user);
      }
    }, async (_error, stream) => {
      if (!stream.aborted) await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'stream_unavailable' }) });
    });
  });
}
