import { createHash, randomUUID } from 'node:crypto';
import type { Db, Queryable, Transaction } from '../db/db.js';
import { requireActiveUser } from '../services/identity.js';
import { validateProviderConfig } from './provider.js';
import { normalizeConfig, PROMPTS } from './kinds.js';
import { GenerationError, MAX_SOURCES, MAX_SOURCE_BYTES, NOT_SENT_USAGE, UNKNOWN_USAGE,
  type ClaimedGeneration, type GenerationInput, type GenerationOutcome, type GenerationPolicy,
  type GenerationProviderConfig, type GenerationSnapshot, type GenerationStatus, type GenerationUsage, type GenerationKind, type GenerationResult } from './types.js';

const lock = 'studyc:generations';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const iso = (value: Date | string) => new Date(value).toISOString();
const number = (value: number | string | null | undefined) => Number(value ?? 0);
const missing = () => new GenerationError('not_found', '没有找到这项生成任务或资料。');
const invalid = () => new GenerationError('invalid_input', '生成配置或资料无效，请重新选择。');
const unavailable = () => new GenerationError('service_unavailable', '生成服务尚未启用，请稍后再试。');
const conflict = () => new GenerationError('job_conflict', '当前任务状态不允许这项操作。');
const quota = () => new GenerationError('quota_exceeded', '生成额度或同时处理的任务已达上限，请稍后重试。');

interface JobRow {
  id: string; user_id: string; study_set_id: string; kind: GenerationKind; client_request_id: string;
  request_digest: string; input_snapshot: GenerationSnapshot; provider_config: GenerationProviderConfig;
  status: GenerationStatus; result: GenerationResult | null; error_code: string | null; current_attempt_id: string | null;
  created_at: Date; updated_at: Date; cursor_time?: string;
}
interface AttemptRow {
  id: string; job_id: string; user_id: string; number: number; client_request_id: string; request_kind: 'create' | 'retry';
  status: GenerationStatus; budget_day: string; reserved_tokens: number; accounted_tokens: number | string;
  usage_state: GenerationUsage['state']; input_tokens: number | string | null; output_tokens: number | string | null;
  total_tokens: number | string | null; cost_credits: string | null; provider_request_id: string | null; error_code: string | null;
  lease_token: string | null; lease_expires_at: Date | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
}
export interface GenerationAttempt {
  id: string; number: number; status: GenerationStatus; reservedTokens: number; usage: GenerationUsage;
  errorCode: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface GenerationJob {
  id: string; studySetId: string; kind: GenerationKind; status: GenerationStatus;
  config: GenerationInput['config']; promptVersion: GenerationSnapshot['promptVersion']; providerConfig: GenerationProviderConfig;
  inputSnapshot?: GenerationSnapshot; sources: Omit<GenerationSnapshot['sources'][number], 'body'>[];
  result: GenerationResult | null; errorCode: string | null; attemptCount: number;
  createdAt: string; updatedAt: string; attempts: GenerationAttempt[];
}
export interface GenerationDailyUsage {
  day: string; requests: number; tokens: number; reservedTokens: number; reportedTokens: number; unknownTokens: number;
  limits: { requests: number; tokens: number }; activeJobs: number; running: number;
}

function normalized(input: GenerationInput): GenerationInput {
  if (!input || typeof input.clientRequestId !== 'string' || !uuid.test(input.clientRequestId) || !Object.hasOwn(PROMPTS, input.kind)
    || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > MAX_SOURCES) throw invalid();
  const sources = input.sources.map(source => {
    if (!source || typeof source.materialId !== 'string' || !uuid.test(source.materialId) || !Number.isSafeInteger(source.version) || source.version < 1 || source.version > 2147483647) throw invalid();
    return { materialId: source.materialId.toLowerCase(), version: source.version };
  }).sort((a, b) => a.materialId.localeCompare(b.materialId));
  if (new Set(sources.map(source => source.materialId)).size !== sources.length) throw invalid();
  return { clientRequestId: input.clientRequestId.toLowerCase(), kind: input.kind, sources,
    config: normalizeConfig(input.kind, input.config) };
}

function usageOf(row: AttemptRow): GenerationUsage {
  const numeric = (value: number | string | null) => value === null ? null : number(value);
  return { state: row.usage_state, inputTokens: numeric(row.input_tokens), outputTokens: numeric(row.output_tokens),
    totalTokens: numeric(row.total_tokens), costCredits: row.cost_credits, providerRequestId: row.provider_request_id };
}

function validUsage(usage: GenerationUsage): GenerationUsage {
  const token = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2147483647;
  const state = usage?.state === 'not_sent' ? 'not_sent' : usage?.state === 'reported'
    && token(usage.inputTokens) && token(usage.outputTokens) && token(usage.totalTokens)
    && usage.totalTokens === usage.inputTokens + usage.outputTokens ? 'reported' : 'unknown';
  if (state === 'not_sent') return { ...NOT_SENT_USAGE };
  return { state, inputTokens: token(usage?.inputTokens) ? usage.inputTokens : null,
    outputTokens: token(usage?.outputTokens) ? usage.outputTokens : null, totalTokens: token(usage?.totalTokens) ? usage.totalTokens : null,
    costCredits: typeof usage?.costCredits === 'string' && /^(?:0|[1-9]\d{0,12})(?:\.\d{1,18})?(?:[eE][+-]?\d{1,3})?$/.test(usage.costCredits)
      && Number.isFinite(Number(usage.costCredits)) && Number(usage.costCredits) >= 0 ? usage.costCredits : null,
    providerRequestId: typeof usage?.providerRequestId === 'string' && /^[A-Za-z0-9:._/-]{1,256}$/.test(usage.providerRequestId) ? usage.providerRequestId : null };
}

export class GenerationStore {
  private readonly now: () => Date;
  constructor(private readonly db: Db, private readonly policy: GenerationPolicy,
    private readonly providerConfig: GenerationProviderConfig | null | undefined, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value < 1) || policy.maxAttempts > 3) throw new Error('Invalid generation policy');
    if (providerConfig) validateProviderConfig(providerConfig);
    this.policy = { ...policy };
    this.providerConfig = providerConfig ? structuredClone(providerConfig) : null;
  }

  private async scope(q: Queryable, user: string, set: string) {
    await requireActiveUser(q, user);
    const [found] = await q.query('SELECT id FROM study_sets WHERE user_id=$1 AND id=$2', [user, set]);
    if (!found) throw missing();
  }

  private async row(q: Queryable, user: string, set: string, id: string): Promise<JobRow> {
    const [job] = await q.query<JobRow>('SELECT * FROM study_generation_jobs WHERE user_id=$1 AND study_set_id=$2 AND id=$3', [user, set, id]);
    if (!job) throw missing();
    return job;
  }

  private async present(q: Queryable, job: JobRow, detail = true): Promise<GenerationJob> {
    const attempts = await q.query<AttemptRow>('SELECT *,budget_day::text AS budget_day FROM study_generation_attempts WHERE job_id=$1 AND user_id=$2 ORDER BY number', [job.id, job.user_id]);
    return { id: job.id, studySetId: job.study_set_id, kind: job.kind, status: job.status,
      config: job.input_snapshot.config, promptVersion: job.input_snapshot.promptVersion, providerConfig: job.provider_config,
      ...(detail ? { inputSnapshot: job.input_snapshot } : {}),
      sources: job.input_snapshot.sources.map(({ body: _body, ...source }) => source), result: job.result, errorCode: job.error_code,
      attemptCount: attempts.length, createdAt: iso(job.created_at), updatedAt: iso(job.updated_at),
      attempts: attempts.map(attempt => ({ id: attempt.id, number: attempt.number, status: attempt.status,
        reservedTokens: attempt.reserved_tokens, usage: usageOf(attempt), errorCode: attempt.error_code,
        createdAt: iso(attempt.created_at), startedAt: attempt.started_at ? iso(attempt.started_at) : null,
        finishedAt: attempt.finished_at ? iso(attempt.finished_at) : null })) };
  }

  private async snapshot(q: Queryable, user: string, set: string, input: GenerationInput): Promise<GenerationSnapshot> {
    const sources: GenerationSnapshot['sources'] = [];
    let bytes = 0;
    for (const [index, wanted] of input.sources.entries()) {
      const [material] = await q.query<{ id: string; version: number; title: string; body: string }>(
        'SELECT id,version,title,body FROM study_materials WHERE user_id=$1 AND study_set_id=$2 AND id=$3 FOR SHARE', [user, set, wanted.materialId]);
      if (!material) throw missing();
      if (material.version !== wanted.version) throw new GenerationError('version_conflict', '资料已被修改，请重新读取后生成。');
      bytes += Buffer.byteLength(material.body, 'utf8');
      if (!material.body.trim() || bytes > MAX_SOURCE_BYTES) throw invalid();
      const files = await q.query<{ id: string; page_count: number; status: string }>(
        'SELECT id,page_count,status FROM study_source_files WHERE user_id=$1 AND study_set_id=$2 AND material_id=$3', [user, set, material.id]);
      if (files.length > 1 || files.some(file => file.status !== 'ready')) throw invalid();
      const file = files[0];
      let pages: GenerationSnapshot['sources'][number]['pages'] = [];
      if (file && material.version === 1) {
        pages = await q.query<{ page: number; start: number; end: number }>(
          'SELECT page_number AS page,char_start AS start,char_end AS end FROM study_source_pages WHERE source_file_id=$1 AND user_id=$2 ORDER BY page_number', [file.id, user]);
        if (!pages.length || pages.length > file.page_count || pages.some((page, position) => page.page < 1 || page.page > file.page_count
          || (position > 0 && page.page <= pages[position - 1]!.page) || page.start < 0 || page.end < page.start || page.end > material.body.length
          || (position > 0 && page.start < pages[position - 1]!.end))) throw invalid();
      }
      sources.push({ sourceId: `s${index + 1}`, materialId: material.id, version: material.version, title: material.title,
        body: material.body, bodySha256: digest(material.body), sourceFileId: file?.id ?? null, pages,
        pageProvenance: file ? material.version === 1 ? 'original_pdf' : 'edited_material' : 'plain_text' });
    }
    return { schemaVersion: 1, promptVersion: PROMPTS[input.kind], sources, config: input.config };
  }

  private reservation(snapshot: GenerationSnapshot, config: GenerationProviderConfig): number {
    return Buffer.byteLength(JSON.stringify(snapshot), 'utf8') + config.maxOutputTokens + 4096;
  }

  private async fitsDailyBudget(q: Queryable, user: string, tokens: number, day: string): Promise<boolean> {
    const [daily] = await q.query<{ requests: string; tokens: string }>(
      'SELECT count(*) AS requests,coalesce(sum(accounted_tokens),0) AS tokens FROM study_generation_attempts WHERE user_id=$1 AND budget_day=$2', [user, day]);
    const [global] = await q.query<{ requests: string; tokens: string }>('SELECT requests,tokens FROM study_generation_daily_budget WHERE day=$1', [day]);
    return number(daily?.requests) < this.policy.userDailyRequests && number(daily?.tokens) + tokens <= this.policy.userDailyTokens
      && number(global?.requests) < this.policy.globalDailyRequests && number(global?.tokens) + tokens <= this.policy.globalDailyTokens;
  }

  private async addDailyReservation(q: Queryable, tokens: number, day: string) {
    await q.query(`INSERT INTO study_generation_daily_budget(day,requests,tokens) VALUES($1,1,$2)
      ON CONFLICT(day) DO UPDATE SET requests=study_generation_daily_budget.requests+1,tokens=study_generation_daily_budget.tokens+excluded.tokens`, [day, tokens]);
  }

  private async reserve(q: Queryable, user: string, tokens: number, now: Date): Promise<string> {
    const day = now.toISOString().slice(0, 10);
    const [active] = await q.query<{ own: string; total: string }>(`SELECT count(*) FILTER (WHERE user_id=$1) AS own,count(*) AS total
      FROM study_generation_attempts WHERE status IN ('queued','running')`, [user]);
    if (number(active?.own) >= this.policy.userActiveJobs || number(active?.total) >= this.policy.globalActiveJobs
      || !await this.fitsDailyBudget(q, user, tokens, day)) throw quota();
    await this.addDailyReservation(q, tokens, day);
    return day;
  }

  private async newAttempt(q: Queryable, job: JobRow, clientRequestId: string, kind: 'create' | 'retry', attempt: number, now: Date) {
    const reserved = this.reservation(job.input_snapshot, job.provider_config);
    const day = await this.reserve(q, job.user_id, reserved, now);
    const [row] = await q.query<AttemptRow>(`INSERT INTO study_generation_attempts
      (job_id,user_id,number,client_request_id,request_kind,status,budget_day,reserved_tokens,accounted_tokens,usage_state,created_at)
      VALUES($1,$2,$3,$4,$5,'queued',$6,$7::integer,$7::integer,'not_sent',$8) RETURNING *`, [job.id, job.user_id, attempt, clientRequestId, kind, day, reserved, now.toISOString()]);
    await q.query(`UPDATE study_generation_jobs SET status='queued',result=NULL,error_code=NULL,current_attempt_id=$2,updated_at=$3 WHERE id=$1`, [job.id, row!.id, now.toISOString()]);
  }

  async create(user: string, set: string, raw: GenerationInput): Promise<{ job: GenerationJob; replayed: boolean }> {
    return this.db.tx(q => this.createInTransaction(q, user, set, raw), lock);
  }

  /** Caller must hold the studyc:generations transaction lock; used for atomic chat turns. */
  async createInTransaction(q: Transaction, user: string, set: string, raw: GenerationInput): Promise<{ job: GenerationJob; replayed: boolean }> {
    const input = normalized(raw);
    const payloadHash = digest(JSON.stringify({ studySetId: set.toLowerCase(), kind: input.kind, sources: input.sources, config: input.config }));
    await this.scope(q, user, set);
    const [existing] = await q.query<JobRow>('SELECT * FROM study_generation_jobs WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]);
    if (existing) {
      if (existing.request_digest !== payloadHash) throw new GenerationError('idempotency_conflict', '同一次生成请求的配置已变化，请重新发起。');
      return { job: await this.present(q, existing), replayed: true };
    }
    if (!this.providerConfig) throw unavailable();
    if ((await q.query('SELECT id FROM study_generation_attempts WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId])).length) {
      throw new GenerationError('idempotency_conflict', '该请求标识已用于其他生成操作。');
    }
    const snapshot = await this.snapshot(q, user, set, input), now = this.now();
    const [job] = await q.query<JobRow>(`INSERT INTO study_generation_jobs
      (user_id,study_set_id,kind,client_request_id,request_digest,input_snapshot,provider_config,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'queued',$8,$8) RETURNING *`,
    [user, set, input.kind, input.clientRequestId, payloadHash, JSON.stringify(snapshot), JSON.stringify(this.providerConfig), now.toISOString()]);
    await this.newAttempt(q, job!, input.clientRequestId, 'create', 1, now);
    return { job: await this.present(q, await this.row(q, user, set, job!.id)), replayed: false };
  }

  async get(user: string, set: string, jobId: string): Promise<GenerationJob> {
    return this.db.tx(q => this.getInTransaction(q, user, set, jobId), lock);
  }

  async getInTransaction(q: Transaction, user: string, set: string, jobId: string): Promise<GenerationJob> {
    await this.scope(q, user, set);
    return this.present(q, await this.row(q, user, set, jobId));
  }

  async list(user: string, set: string, options: { limit: number; cursor?: string }): Promise<{ items: GenerationJob[]; nextCursor: string | null }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw invalid();
    let cursor: { user: string; set: string; at: string; id: string } | undefined;
    if (options.cursor !== undefined) {
      try {
        if (options.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw invalid();
        const bytes = Buffer.from(options.cursor, 'base64url');
        if (bytes.toString('base64url') !== options.cursor) throw invalid();
        cursor = JSON.parse(bytes.toString('utf8'));
        if (!cursor || cursor.user !== user || cursor.set !== set || typeof cursor.id !== 'string' || !uuid.test(cursor.id)
          || typeof cursor.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at)
          || !Number.isFinite(Date.parse(cursor.at)) || cursor.at.startsWith('0000')
          || new Date(cursor.at).toISOString() !== cursor.at.slice(0, 23) + 'Z' || Object.keys(cursor).length !== 4) throw invalid();
      } catch { throw invalid(); }
    }
    return this.db.tx(async q => {
      await this.scope(q, user, set);
      const rows = await q.query<JobRow>(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
        FROM study_generation_jobs WHERE user_id=$1 AND study_set_id=$2 ${cursor ? 'AND (created_at,id)<($4::timestamptz,$5::uuid)' : ''}
        ORDER BY created_at DESC,id DESC LIMIT $3`, [user, set, options.limit + 1, ...(cursor ? [cursor.at, cursor.id] : [])]);
      const visible = rows.slice(0, options.limit), last = visible.at(-1);
      const items: GenerationJob[] = [];
      for (const row of visible) items.push(await this.present(q, row, false));
      return { items, nextCursor: rows.length > options.limit && last
        ? Buffer.from(JSON.stringify({ user, set, at: last.cursor_time, id: last.id })).toString('base64url') : null };
    }, lock);
  }

  async retry(user: string, set: string, jobId: string, input: { clientRequestId: string }): Promise<{ job: GenerationJob; replayed: boolean }> {
    return this.db.tx(q => this.retryInTransaction(q, user, set, jobId, input), lock);
  }

  /** Caller holds the same global lock as createInTransaction. */
  async retryInTransaction(q: Transaction, user: string, set: string, jobId: string, input: { clientRequestId: string }): Promise<{ job: GenerationJob; replayed: boolean }> {
    if (!input || typeof input.clientRequestId !== 'string' || !uuid.test(input.clientRequestId)) throw invalid();
    await this.scope(q, user, set);
    const job = await this.row(q, user, set, jobId);
    const [existing] = await q.query<AttemptRow>('SELECT *,budget_day::text AS budget_day FROM study_generation_attempts WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]);
    if (existing) {
      if (existing.job_id !== job.id || existing.request_kind !== 'retry') throw new GenerationError('idempotency_conflict', '该请求标识已用于其他生成操作。');
      return { job: await this.present(q, job), replayed: true };
    }
    if (!this.providerConfig) throw unavailable();
    const attempts = await q.query<AttemptRow>('SELECT *,budget_day::text AS budget_day FROM study_generation_attempts WHERE job_id=$1 ORDER BY number', [job.id]);
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status) || attempts.some(attempt => ['queued', 'running'].includes(attempt.status))
      || attempts.length >= this.policy.maxAttempts) throw conflict();
    await this.newAttempt(q, job, input.clientRequestId.toLowerCase(), 'retry', attempts.length + 1, this.now());
    return { job: await this.present(q, await this.row(q, user, set, job.id)), replayed: false };
  }

  private async applyUsage(q: Queryable, attempt: AttemptRow, usage: GenerationUsage) {
    const accounted = usage.state === 'reported' ? usage.totalTokens! : usage.state === 'not_sent' ? 0 : attempt.reserved_tokens;
    const delta = accounted - number(attempt.accounted_tokens);
    if (delta) await q.query('UPDATE study_generation_daily_budget SET tokens=tokens+$2 WHERE day=$1', [attempt.budget_day, delta]);
    await q.query(`UPDATE study_generation_attempts SET usage_state=$2,input_tokens=$3,output_tokens=$4,total_tokens=$5,
      cost_credits=$6,provider_request_id=$7,accounted_tokens=$8 WHERE id=$1`,
    [attempt.id, usage.state, usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.costCredits, usage.providerRequestId, accounted]);
  }

  async cancel(user: string, set: string, jobId: string): Promise<GenerationJob> {
    return this.db.tx(async q => {
      await this.scope(q, user, set);
      const job = await this.row(q, user, set, jobId);
      if (job.status === 'cancelled') return this.present(q, job);
      if (!['queued', 'running'].includes(job.status)) throw conflict();
      const [attempt] = await q.query<AttemptRow>('SELECT *,budget_day::text AS budget_day FROM study_generation_attempts WHERE id=$1', [job.current_attempt_id]);
      const now = this.now().toISOString();
      if (attempt?.status === 'queued') {
        await this.applyUsage(q, attempt, { ...NOT_SENT_USAGE });
        await q.query("UPDATE study_generation_attempts SET status='cancelled',error_code='cancelled',finished_at=$2 WHERE id=$1", [attempt.id, now]);
      }
      await q.query("UPDATE study_generation_jobs SET status='cancelled',result=NULL,error_code='cancelled',updated_at=$2 WHERE id=$1", [job.id, now]);
      return this.present(q, await this.row(q, user, set, job.id));
    }, lock);
  }

  async usage(user: string): Promise<GenerationDailyUsage> {
    return this.db.tx(async q => {
      await requireActiveUser(q, user);
      const day = this.now().toISOString().slice(0, 10);
      const [row] = await q.query<Record<string, number | string>>(`SELECT count(*) AS requests,coalesce(sum(accounted_tokens),0) AS tokens,
        coalesce(sum(accounted_tokens) FILTER (WHERE status IN ('queued','running')),0) AS reserved,
        coalesce(sum(accounted_tokens) FILTER (WHERE usage_state='reported'),0) AS reported,
        coalesce(sum(accounted_tokens) FILTER (WHERE usage_state='unknown'),0) AS unknown
        FROM study_generation_attempts WHERE user_id=$1 AND budget_day=$2`, [user, day]);
      const [active] = await q.query<{ active: string; running: string }>(`SELECT count(*) FILTER (WHERE status IN ('queued','running')) AS active,
        count(*) FILTER (WHERE status='running') AS running FROM study_generation_attempts WHERE user_id=$1`, [user]);
      return { day, requests: number(row?.requests), tokens: number(row?.tokens), reservedTokens: number(row?.reserved),
        reportedTokens: number(row?.reported), unknownTokens: number(row?.unknown),
        limits: { requests: this.policy.userDailyRequests, tokens: this.policy.userDailyTokens }, activeJobs: number(active?.active), running: number(active?.running) };
    }, lock);
  }

  private async finishQueued(q: Queryable, attempt: AttemptRow, status: 'failed' | 'cancelled', error: string, now: Date) {
    await this.applyUsage(q, attempt, { ...NOT_SENT_USAGE });
    await q.query('UPDATE study_generation_attempts SET status=$2,error_code=$3,finished_at=$4 WHERE id=$1',
      [attempt.id, status, error, now.toISOString()]);
    await q.query(`UPDATE study_generation_jobs SET status=$2,result=NULL,error_code=$3,updated_at=$4
      WHERE id=$1 AND current_attempt_id=$5 AND status='queued'`, [attempt.job_id, status, error, now.toISOString(), attempt.id]);
  }

  private async expire(q: Queryable, now: Date): Promise<number> {
    const abandoned = await q.query<AttemptRow>(`SELECT a.*,a.budget_day::text AS budget_day FROM study_generation_attempts a JOIN users u ON u.id=a.user_id
      WHERE a.status='queued' AND u.deleted_at IS NOT NULL`);
    for (const attempt of abandoned) await this.finishQueued(q, attempt, 'cancelled', 'account_deleted', now);
    const expired = await q.query<AttemptRow>("SELECT *,budget_day::text AS budget_day FROM study_generation_attempts WHERE status='running' AND lease_expires_at <= $1", [now.toISOString()]);
    for (const attempt of expired) {
      await q.query("UPDATE study_generation_attempts SET status='interrupted',error_code='lease_expired',finished_at=$2 WHERE id=$1", [attempt.id, now.toISOString()]);
      await q.query(`UPDATE study_generation_jobs SET status='interrupted',result=NULL,error_code='lease_expired',updated_at=$2
        WHERE id=$1 AND current_attempt_id=$3 AND status='running'`, [attempt.job_id, now.toISOString(), attempt.id]);
    }
    return expired.length + abandoned.length;
  }

  async recoverExpired(): Promise<number> { return this.db.tx(q => this.expire(q, this.now()), lock); }

  async claim(): Promise<ClaimedGeneration | null> {
    if (!this.providerConfig) return null;
    return this.db.tx(async q => {
      const now = this.now();
      await this.expire(q, now);
      const [running] = await q.query<{ count: string }>("SELECT count(*) FROM study_generation_attempts WHERE status='running'");
      if (number(running?.count) >= this.policy.globalConcurrency) return null;
      // A skipped old-day reservation becomes terminal, so the loop is bounded by queued jobs.
      for (;;) {
        const [candidate] = await q.query<AttemptRow>(`SELECT a.*,a.budget_day::text AS budget_day FROM study_generation_attempts a
          JOIN study_generation_jobs j ON j.id=a.job_id JOIN users u ON u.id=a.user_id
          WHERE a.status='queued' AND j.status='queued' AND j.current_attempt_id=a.id AND u.deleted_at IS NULL
          AND (SELECT count(*) FROM study_generation_attempts r WHERE r.user_id=a.user_id AND r.status='running')<$1
          ORDER BY a.created_at,a.id LIMIT 1`, [this.policy.userConcurrency]);
        if (!candidate) return null;
        const [job] = await q.query<JobRow>('SELECT * FROM study_generation_jobs WHERE id=$1', [candidate.job_id]);
        await requireActiveUser(q, job!.user_id);
        const day = now.toISOString().slice(0, 10);
        if (candidate.budget_day !== day) {
          if (!await this.fitsDailyBudget(q, job!.user_id, candidate.reserved_tokens, day)) {
            await this.finishQueued(q, candidate, 'failed', 'quota_exceeded', now);
            continue;
          }
          // No external call has occurred. Move, rather than duplicate, this reservation.
          await q.query('UPDATE study_generation_daily_budget SET requests=requests-1,tokens=tokens-$2 WHERE day=$1',
            [candidate.budget_day, number(candidate.accounted_tokens)]);
          await this.addDailyReservation(q, candidate.reserved_tokens, day);
          await q.query('UPDATE study_generation_attempts SET budget_day=$2 WHERE id=$1', [candidate.id, day]);
        }
        const leaseToken = randomUUID(), expires = new Date(now.getTime() + job!.provider_config.timeoutMs + 30000).toISOString();
        const [attempt] = await q.query<AttemptRow>(`UPDATE study_generation_attempts SET status='running',usage_state='unknown',
          lease_token=$2,lease_expires_at=$3,started_at=$4 WHERE id=$1 RETURNING *`, [candidate.id, leaseToken, expires, now.toISOString()]);
        await q.query("UPDATE study_generation_jobs SET status='running',updated_at=$2 WHERE id=$1", [job!.id, now.toISOString()]);
        return { jobId: job!.id, attemptId: attempt!.id, userId: job!.user_id, studySetId: job!.study_set_id,
          attemptNumber: attempt!.number, leaseToken, leaseExpiresAt: expires,
          snapshot: job!.input_snapshot, providerConfig: job!.provider_config };
      }
    }, lock);
  }

  private matchesResult(job: JobRow, result: GenerationResult | null): boolean {
    if (!result || result.schemaVersion !== 1) return false;
    const config = job.input_snapshot.config;
    if (job.kind === 'study_outline') return 'points' in result && 'pointCount' in config && result.points.length === config.pointCount;
    if (job.kind === 'study_note') return 'sections' in result && 'sectionCount' in config && result.sections.length === config.sectionCount;
    if (job.kind === 'flashcards') return 'cards' in result && 'cardCount' in config && result.cards.length === config.cardCount;
    if (job.kind === 'quiz') return 'questions' in result && 'singleChoiceCount' in config && result.questions.length === config.singleChoiceCount + config.trueFalseCount;
    return job.kind === 'chat_answer' && 'answer' in result && typeof result.answer === 'string' && typeof result.insufficientEvidence === 'boolean';
  }

  async recordProgress(claim: ClaimedGeneration, text: string): Promise<void> {
    if (typeof text !== 'string' || text.length > 8000 || /[\u0000\uD800-\uDFFF]/u.test(text)) throw invalid();
    await this.db.tx(async q => {
      const [current] = await q.query<{ text: string }>(`SELECT p.text FROM study_generation_progress p WHERE p.attempt_id=$1`, [claim.attemptId]);
      if (current && !text.startsWith(current.text)) throw invalid();
      await q.query(`INSERT INTO study_generation_progress(attempt_id,job_id,user_id,sequence,text)
        SELECT a.id,a.job_id,a.user_id,1,$5 FROM study_generation_attempts a JOIN study_generation_jobs j ON j.id=a.job_id
        JOIN users u ON u.id=a.user_id WHERE a.id=$1 AND a.job_id=$2 AND a.user_id=$3 AND a.lease_token=$4
        AND a.status='running' AND a.lease_expires_at>$6 AND j.status='running' AND j.current_attempt_id=a.id AND u.deleted_at IS NULL
        ON CONFLICT(attempt_id) DO UPDATE SET text=excluded.text,sequence=study_generation_progress.sequence+1
        WHERE study_generation_progress.text IS DISTINCT FROM excluded.text`,
      [claim.attemptId, claim.jobId, claim.userId, claim.leaseToken, text, this.now().toISOString()]);
    }, lock);
  }

  async progress(user: string, set: string, jobId: string): Promise<{ attemptId: string; seq: number; text: string } | null> {
    return this.db.tx(async q => {
      await this.scope(q, user, set);
      const job = await this.row(q, user, set, jobId);
      const [progress] = await q.query<{ attemptId: string; seq: number; text: string }>(
        'SELECT attempt_id AS "attemptId",sequence AS seq,text FROM study_generation_progress WHERE attempt_id=$1 AND user_id=$2', [job.current_attempt_id, user]);
      return progress ?? null;
    }, lock);
  }

  async shouldCancel(claim: ClaimedGeneration): Promise<boolean> {
    const [row] = await this.db.query<{ status: GenerationStatus; lease_token: string | null; lease_expires_at: Date | null; job_status: GenerationStatus; current_attempt_id: string; deleted_at: Date | null }>(
      `SELECT a.status,a.lease_token,a.lease_expires_at,j.status AS job_status,j.current_attempt_id,u.deleted_at
       FROM study_generation_attempts a JOIN study_generation_jobs j ON j.id=a.job_id JOIN users u ON u.id=a.user_id
       WHERE a.id=$1 AND a.job_id=$2 AND a.user_id=$3`, [claim.attemptId, claim.jobId, claim.userId]);
    return !row || row.status !== 'running' || row.job_status !== 'running' || row.current_attempt_id !== claim.attemptId
      || row.lease_token !== claim.leaseToken || !row.lease_expires_at || row.lease_expires_at.getTime() <= this.now().getTime() || row.deleted_at !== null;
  }

  async settle(claim: ClaimedGeneration, outcome: GenerationOutcome): Promise<void> {
    await this.db.tx(async q => {
      const [attempt] = await q.query<AttemptRow>('SELECT *,budget_day::text AS budget_day FROM study_generation_attempts WHERE id=$1 AND job_id=$2 AND user_id=$3', [claim.attemptId, claim.jobId, claim.userId]);
      if (!attempt || attempt.lease_token !== claim.leaseToken) return;
      const usage = validUsage(outcome.usage);
      if (attempt.status !== 'running') {
        // A late worker may settle real usage after cancellation/recovery. It
        // cannot rewrite terminal state, a new attempt, or an existing charge.
        if (attempt.usage_state === 'unknown' && usage.state === 'reported') await this.applyUsage(q, attempt, usage);
        return;
      }
      const now = this.now(), [job] = await q.query<JobRow>('SELECT * FROM study_generation_jobs WHERE id=$1', [claim.jobId]);
      if (!job) return;
      const expired = !attempt.lease_expires_at || attempt.lease_expires_at.getTime() <= now.getTime();
      const [user] = await q.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM users WHERE id=$1', [claim.userId]);
      let status: GenerationStatus = job.status === 'cancelled' || !user || user.deleted_at ? 'cancelled' : expired ? 'interrupted' : outcome.status;
      let errorCode = status === 'cancelled' ? 'cancelled' : expired ? 'lease_expired' : outcome.errorCode;
      if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)) { status = 'failed'; errorCode = 'invalid_outcome'; }
      if (status === 'succeeded' && !this.matchesResult(job, outcome.result)) { status = 'failed'; errorCode = 'invalid_output'; }
      const safeCode = typeof errorCode === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(errorCode) ? errorCode : null;
      await this.applyUsage(q, attempt, usage);
      await q.query('UPDATE study_generation_attempts SET status=$2,error_code=$3,finished_at=$4 WHERE id=$1', [attempt.id, status, safeCode, now.toISOString()]);
      await q.query(`UPDATE study_generation_jobs SET status=$2,result=$3::jsonb,error_code=$4,updated_at=$5
        WHERE id=$1 AND current_attempt_id=$6 AND status='running'`,
      [job.id, status, status === 'succeeded' ? JSON.stringify(outcome.result) : null, safeCode, now.toISOString(), attempt.id]);
    }, lock);
  }
}
