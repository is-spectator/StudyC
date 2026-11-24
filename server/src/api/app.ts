import {registerCopyRoutes} from './content-copy.js';
import {registerTrashRoutes} from './trash.js';
import {registerFolderRoutes} from './folders.js';
import {registerSearchRoutes} from './search.js';
import {registerCalendarRoutes} from './calendar.js';
import {registerPlanRoutes} from './plans.js';
import { registerNoteRoutes } from './notes.js';
import { registerMistakeRoutes } from './mistakes.js';
import { registerSpacedRoutes } from './spaced-review.js';
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
import { registerGenerationRoutes, type GenerationHttpStore } from './generations.js';
import { GenerationError } from '../generation/types.js';
import { GenerationStore } from '../generation/store.js';
import { registerChatRoutes } from './chat.js';
import { registerFlashcardRoutes } from './flashcards.js';
import { registerQuizRoutes } from './quizzes.js';

export interface AppOptions {
  releaseId: string;
  rateLimitSecret: Uint8Array;
  /** Absolute private directory for original PDFs. File routes stay unmounted without it. */
  fileRoot?: string;
  /** Test transport injection only; the destination remains a fixed loopback URL. */
  sessionFetch?: typeof fetch;
  /** Always provide the store, even with generation disabled, to retain history/cancellation. */
  generationStore?: GenerationHttpStore;
}

const statuses = { no_cards_due: 409,
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
    if (error instanceof GenerationError) {
      const code = { invalid_input: 400, not_found: 404, version_conflict: 409, idempotency_conflict: 409,
        job_conflict: 409, quota_exceeded: 429, service_unavailable: 503 } as const;
      return c.json({ error: { code: error.code, message: error.message } }, code[error.code]);
    }
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
    const generationCollection = /^\/v1\/study\/sets\/[^/]+\/generations$/.test(path);
    const generationDetail = /^\/v1\/study\/sets\/[^/]+\/generations\/[^/]+$/.test(path);
    const generationAction = /^\/v1\/study\/sets\/[^/]+\/generations\/[^/]+\/(?:cancel|retry)$/.test(path);
    const generationUsage = path === '/v1/study/generation-usage';
    const chatCollection = /^\/v1\/study\/sets\/[^/]+\/chat\/threads$/.test(path);
    const chatRead = /^\/v1\/study\/sets\/[^/]+\/chat\/threads\/[^/]+(?:\/messages\/[^/]+\/events)?$/.test(path);
    const chatWrite = /^\/v1\/study\/sets\/[^/]+\/chat\/threads\/[^/]+\/messages(?:\/[^/]+\/(?:stop|retry))?$/.test(path);
    const flashcardCollection = /^\/v1\/study\/sets\/[^/]+\/flashcard-decks$/.test(path);
    const flashcardMaterialize = /^\/v1\/study\/sets\/[^/]+\/flashcard-decks\/materialize$/.test(path);
    const flashcardDetail = !flashcardMaterialize && /^\/v1\/study\/sets\/[^/]+\/flashcard-decks\/[^/]+$/.test(path);
    const flashcardWrite = flashcardMaterialize || /^\/v1\/study\/sets\/[^/]+\/flashcard-decks\/[^/]+\/(?:cards|sessions(?:\/[^/]+\/reviews)?)$/.test(path);
    const flashcardEdit = /^\/v1\/study\/sets\/[^/]+\/flashcard-decks\/[^/]+\/cards\/[^/]+$/.test(path);
    const flashcardSession = /^\/v1\/study\/sets\/[^/]+\/flashcard-decks\/[^/]+\/sessions\/[^/]+$/.test(path);
    const spacedRead = /^\/v1\/study\/sets\/[^/]+\/flashcard-decks\/[^/]+\/(?:review-queue|review-sessions\/[^/]+)$/.test(path);
    const spacedWrite = /^\/v1\/study\/sets\/[^/]+\/flashcard-decks\/[^/]+\/review-sessions(?:\/[^/]+\/actions)?$/.test(path);
    if ((spacedRead && c.req.method !== 'GET') || (spacedWrite && c.req.method !== 'POST')) return c.json({error:{code:'method_not_allowed',message:'请求方法不支持。'}},405);
    const mistakeRead = /^\/v1\/study\/sets\/[^/]+\/(?:mistakes(?:\/[^/]+\/[^/]+)?|mistake-reviews\/[^/]+)$/.test(path);
    const mistakeCollection = /^\/v1\/study\/sets\/[^/]+\/mistake-reviews$/.test(path);
    const mistakeWrite = /^\/v1\/study\/sets\/[^/]+\/mistake-reviews\/[^/]+\/(?:answers|submit)$/.test(path);
    if ((mistakeRead && c.req.method !== 'GET') || (mistakeCollection && !['GET','POST'].includes(c.req.method)) || (mistakeWrite && c.req.method !== 'POST')) return c.json({error:{code:'method_not_allowed',message:'请求方法不支持。'}},405);
    if((path==='/v1/study/trash'&&c.req.method!=='GET')||(/^\/v1\/study\/trash\/[^/]+$/.test(path)&&!['GET','PATCH'].includes(c.req.method)))return c.json({error:{code:'method_not_allowed',message:'请求方法不支持。'}},405);
    if((path==='/v1/study/copies'&&c.req.method!=='POST')||(/^\/v1\/study\/sets\/[^/]+\/copy-preview$/.test(path)&&c.req.method!=='GET'))return c.json({error:{code:'method_not_allowed',message:'请求方法不支持。'}},405);
    const folderCollection=path==='/v1/study/folders',folderDetail=/^\/v1\/study\/folders\/[^/]+$/.test(path),folderRemove=/^\/v1\/study\/folders\/[^/]+\/remove$/.test(path),folderSets=/^\/v1\/study\/folders\/[^/]+\/sets$/.test(path),folderAssignment=/^\/v1\/study\/sets\/[^/]+\/folder$/.test(path);
    if((folderCollection&&!['GET','POST'].includes(c.req.method))||((folderDetail||folderAssignment)&&!['GET','PATCH'].includes(c.req.method))||(folderRemove&&c.req.method!=='POST')||(folderSets&&c.req.method!=='GET'))return c.json({error:{code:'method_not_allowed',message:'请求方法不支持。'}},405);
    if(path==='/v1/study/search'&&c.req.method!=='GET')return c.json({error:{code:'method_not_allowed',message:'请求方法不支持。'}},405);
    const calendarSettings=path==='/v1/study/calendar/settings',calendarCollection=path==='/v1/study/calendar/events',calendarDetail=/^\/v1\/study\/calendar\/events\/[^/]+$/.test(path),calendarRead=['/v1/study/calendar/time-options','/v1/study/calendar/task-event'].includes(path),calendarPreview=path==='/v1/study/calendar/conflicts';
    if(((calendarSettings||calendarDetail)&&!['GET','PATCH'].includes(c.req.method))||(calendarCollection&&!['GET','POST'].includes(c.req.method))||(calendarRead&&c.req.method!=='GET')||(calendarPreview&&c.req.method!=='POST'))return c.json({error:{code:'method_not_allowed',message:'请求方法不支持。'}},405);
    const planCollection=/^\/v1\/study\/sets\/[^/]+\/plans(?:\/[^/]+\/tasks)?$/.test(path);
    const planDetail=/^\/v1\/study\/sets\/[^/]+\/plans\/[^/]+$/.test(path);
    const planTask=/^\/v1\/study\/sets\/[^/]+\/plans\/[^/]+\/tasks\/[^/]+$/.test(path);
    const planEvidence=/^\/v1\/study\/sets\/[^/]+\/plans\/[^/]+\/tasks\/[^/]+\/evidence$/.test(path);
    const planOptions=/^\/v1\/study\/sets\/[^/]+\/planning-options$/.test(path);
    if((planCollection&&!['GET','POST'].includes(c.req.method))||(planDetail&&!['GET','PATCH'].includes(c.req.method))||(planTask&&c.req.method!=='PATCH')||(planEvidence&&!['GET','POST'].includes(c.req.method))||(planOptions&&c.req.method!=='GET'))return c.json({error:{code:'method_not_allowed',message:'请求方法不支持。'}},405);
    const noteCollection=/^\/v1\/study\/sets\/[^/]+\/notes$/.test(path),noteDetail=/^\/v1\/study\/sets\/[^/]+\/notes\/[^/]+$/.test(path);
    if((noteCollection&&!['GET','POST'].includes(c.req.method))||(noteDetail&&!['GET','PATCH'].includes(c.req.method)))return c.json({error:{code:'method_not_allowed',message:'请求方法不支持。'}},405);
    const quizCollection = /^\/v1\/study\/sets\/[^/]+\/quizzes(?:\/[^/]+\/attempts)?$/.test(path);
    const quizRead = /^\/v1\/study\/sets\/[^/]+\/quizzes\/[^/]+(?:\/attempts\/[^/]+)?$/.test(path);
    const quizWrite = /^\/v1\/study\/sets\/[^/]+\/quizzes\/[^/]+\/attempts\/[^/]+\/(?:answers|submit)$/.test(path);
    if ((collection && !['GET', 'POST'].includes(c.req.method)) || ((detail || setDetail) && !['GET', 'PATCH'].includes(c.req.method)) || (fileRead && c.req.method !== 'GET')
      || (generationCollection && !['GET', 'POST'].includes(c.req.method)) || ((generationDetail || generationUsage) && c.req.method !== 'GET')
      || (generationAction && c.req.method !== 'POST') || (chatCollection && !['GET','POST'].includes(c.req.method))
      || (chatRead && c.req.method !== 'GET') || (chatWrite && c.req.method !== 'POST')
      || (flashcardCollection && !['GET', 'POST'].includes(c.req.method)) || (flashcardDetail && !['GET', 'PATCH'].includes(c.req.method))
      || (flashcardWrite && c.req.method !== 'POST') || (flashcardEdit && c.req.method !== 'PATCH') || (flashcardSession && c.req.method !== 'GET')
      || (quizCollection && !['GET', 'POST'].includes(c.req.method)) || (quizRead && c.req.method !== 'GET') || (quizWrite && c.req.method !== 'POST')) {
      return c.json({ error: { code: 'method_not_allowed', message: '此接口不支持该请求方法。' } }, 405);
    }
    await next();
  });
  registerStudyRoutes(app, db, limits);
  registerGenerationRoutes(app, options.generationStore, limits);
  registerChatRoutes(app, db, options.generationStore instanceof GenerationStore ? options.generationStore : undefined, limits);
  registerFlashcardRoutes(app, db, options.generationStore instanceof GenerationStore ? options.generationStore : undefined, limits);
  registerSpacedRoutes(app, db, limits);
  registerMistakeRoutes(app,db,limits);
  registerNoteRoutes(app,db,limits);
  registerPlanRoutes(app,db,limits);
  registerCalendarRoutes(app,db,limits);
  registerSearchRoutes(app,db);
  registerFolderRoutes(app,db,limits);
  registerCopyRoutes(app,db,limits);
  registerTrashRoutes(app,db,limits,options.generationStore instanceof GenerationStore ? options.generationStore : undefined);
  registerQuizRoutes(app, db, options.generationStore, limits);
  if (options.fileRoot) registerFileRoutes(app, db, limits, options.fileRoot);
  // No PlanPlan or account-management routes are mounted.
  app.notFound(c => c.json({ error: { code: 'not_found', message: '没有找到该接口。' } }, 404));
  return app;
}
