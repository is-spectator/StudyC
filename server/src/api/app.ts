import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { Db } from '../db/db.js';
import { SharedRateLimiter } from '../runtime/rate-limit.js';
import { DomainError } from '../services/errors.js';
import { StudyError, StudyInputError } from '../services/study-data.js';
import { StudyFileError } from '../services/study-files.js';
import { requireStudySession, SessionError, type StudyEnv } from './auth.js';
import { registerFileRoutes } from './files.js';
import { registerStudyRoutes } from './study.js';

export interface AppOptions {
  releaseId: string;
  rateLimitSecret: Uint8Array;
  /** Absolute private directory for original PDFs. File routes stay unmounted without it. */
  fileRoot?: string;
  /** Test transport injection only; the destination remains a fixed loopback URL. */
  sessionFetch?: typeof fetch;
}

const statuses = {
  unauthorized: 401, credential_conflict: 401, account_mismatch: 409,
  origin_forbidden: 403, csrf_invalid: 403, service_unavailable: 503,
  not_found: 404, version_conflict: 409, idempotency_conflict: 409,
  payload_too_large: 413, rate_limited: 429, invalid_input: 422, internal: 500,
} as const;

/** Startup checks the complete StudyC registry; public probes only check DB
 * connectivity, coalesced and bounded so they cannot build an unbounded queue. */
function readiness(db: Db) {
  let checkedAt = -Infinity, healthy = false, pending: Promise<boolean> | undefined;
  return (): Promise<boolean> => {
    if (pending) return pending;
    if (Date.now() - checkedAt < 5000) return Promise.resolve(healthy);
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([db.query('SELECT 1 AS ready'), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('readiness_timeout')), 2500);
        })]);
        healthy = true;
      } catch { healthy = false; }
      finally { clearTimeout(timer); checkedAt = Date.now(); pending = undefined; }
      return healthy;
    })();
    return pending;
  };
}

export function createApp(db: Db, options: AppOptions) {
  const app = new Hono<StudyEnv>();
  const limits = new SharedRateLimiter(db, options.rateLimitSecret);
  const ready = readiness(db);
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
    c.header('Cache-Control', 'private, no-store');
  });
  app.onError((error, c) => {
    if (error instanceof StudyInputError) return c.json({ error: { code: 'invalid_input', message: error.message } }, 400);
    if (error instanceof StudyFileError) {
      const status = error.code === 'parse_timeout' ? 503 : error.code === 'text_too_large' ? 413 : 422;
      return c.json({ error: { code: error.code, message: error.message } }, status);
    }
    if (error instanceof DomainError || error instanceof StudyError || error instanceof SessionError) {
      return c.json({ error: { code: error.code, message: error.message, details: error.details } }, statuses[error.code]);
    }
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return c.json({ error: { code: 'invalid_input', message: '请求格式不正确，这次没有保存。' } }, 400);
    }
    return c.json({ error: { code: 'internal', message: '服务暂时不可用，请保留输入并核对保存结果后重试。' } }, 500);
  });
  app.get('/healthz', c => c.json({ ok: true, service: 'studyc' }));
  app.get('/readyz', async c => {
    const ok = await ready();
    return c.json({ ok, release: options.releaseId, service: 'studyc' }, ok ? 200 : 503);
  });
  app.use('/v1/study/*', requireStudySession(options.sessionFetch));
  app.use('/v1/study/*', async (c, next) => {
    const path = c.req.path;
    const collection = /^\/v1\/study\/sets(?:\/[^/]+\/(?:materials|files))?$/.test(path);
    const detail = /^\/v1\/study\/sets\/[^/]+\/materials\/[^/]+$/.test(path);
    const setDetail = /^\/v1\/study\/sets\/[^/]+$/.test(path);
    const fileRead = /^\/v1\/study\/sets\/[^/]+\/files\/[^/]+\/content$/.test(path);
    if ((collection && !['GET', 'POST'].includes(c.req.method)) || ((detail || setDetail) && !['GET', 'PATCH'].includes(c.req.method)) || (fileRead && c.req.method !== 'GET')) {
      return c.json({ error: { code: 'method_not_allowed', message: '此接口不支持该请求方法。' } }, 405);
    }
    await next();
  });
  registerStudyRoutes(app, db, limits);
  if (options.fileRoot) registerFileRoutes(app, db, limits, options.fileRoot);
  // No PlanPlan or account-management routes are mounted.
  app.notFound(c => c.json({ error: { code: 'not_found', message: '没有找到该接口。' } }, 404));
  return app;
}
