import {requireVisibleSet} from './set-visibility.js';
import { createHash } from 'node:crypto';
import type { Db, Transaction } from '../db/db.js';
import { requireActiveUser } from './identity.js';
import { GenerationError, type ChatConfig, type GenerationInput, type Language } from '../generation/types.js';
import type { GenerationJob, GenerationStore } from '../generation/store.js';
const lock = 'studyc:generations';
const absent = () => new GenerationError('not_found', '没有找到这段对话。');
const conflict = () => new GenerationError('job_conflict', '请先完成或停止当前回答；只能重试最后一轮。');
const repeated = () => new GenerationError('idempotency_conflict', '同一次请求的内容已变化，请重新提交。');
const iso = (x: Date | string) => new Date(x).toISOString();
type ThreadRow = { id: string; study_set_id: string; user_id: string; title: string; created_at: Date; updated_at: Date };
type TurnRow = { id: string; thread_id: string; user_id: string; job_id: string; sequence: number; question: string; request_digest: string; created_at: Date };
export interface ChatThread { id: string; studySetId: string; title: string; createdAt: string; updatedAt: string }
export interface ChatTurn { id: string; threadId: string; sequence: number; question: string; jobId: string; createdAt: string; job: GenerationJob }
export interface ChatMessageInput { clientRequestId: string; question: string; sources: GenerationInput['sources']; language: Language }
const threadView = (row: ThreadRow): ChatThread => ({ id: row.id, studySetId: row.study_set_id, title: row.title, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
export class ChatService {
  constructor(private readonly db: Db, private readonly store: GenerationStore) {}
  private async scope(q: Transaction, user: string, set: string) { return requireVisibleSet(q,user,set); }
  private async thread(q: Transaction, user: string, set: string, id: string): Promise<ThreadRow> {
    await this.scope(q, user, set);
    const [row] = await q.query<ThreadRow>('SELECT * FROM study_chat_threads WHERE id=$1 AND user_id=$2 AND study_set_id=$3', [id, user, set]);
    if (!row) throw absent(); return row;
  }
  private async present(q: Transaction, user: string, set: string, turn: TurnRow): Promise<ChatTurn> {
    return { id: turn.id, threadId: turn.thread_id, sequence: turn.sequence, question: turn.question, jobId: turn.job_id,
      createdAt: iso(turn.created_at), job: await this.store.getInTransaction(q, user, set, turn.job_id) };
  }
  async list(user: string, set: string): Promise<{ items: ChatThread[] }> {
    return this.db.tx(async q => { await this.scope(q, user, set);
      const rows = await q.query<ThreadRow>('SELECT * FROM study_chat_threads WHERE user_id=$1 AND study_set_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 100', [user, set]);
      return { items: rows.map(threadView) };
    }, lock);
  }
  async create(user: string, set: string, input: { clientRequestId: string; title?: string }) {
    const title = (input.title ?? '新对话').trim();
    if (!title || title.length > 120 || /[\u0000\uD800-\uDFFF]/u.test(title)) throw new GenerationError('invalid_input', '对话标题无效。');
    return this.db.tx(async q => {
      await this.scope(q, user, set);
      const [existing] = await q.query<ThreadRow>('SELECT * FROM study_chat_threads WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]);
      if (existing) { if (existing.study_set_id !== set || existing.title !== title) throw repeated(); return { thread: threadView(existing), replayed: true }; }
      const [count] = await q.query<{ total: string }>('SELECT count(*) AS total FROM study_chat_threads WHERE user_id=$1 AND study_set_id=$2', [user, set]);
      if (Number(count!.total) >= 100) throw new GenerationError('quota_exceeded', '每个资料集最多保存100段对话。');
      const [row] = await q.query<ThreadRow>('INSERT INTO study_chat_threads(user_id,study_set_id,client_request_id,title) VALUES($1,$2,$3,$4) RETURNING *', [user, set, input.clientRequestId, title]);
      return { thread: threadView(row!), replayed: false };
    }, lock);
  }
  async get(user: string, set: string, threadId: string): Promise<{ thread: ChatThread; turns: ChatTurn[] }> {
    return this.db.tx(async q => {
      const thread = await this.thread(q, user, set, threadId);
      const rows = await q.query<TurnRow>('SELECT * FROM study_chat_turns WHERE thread_id=$1 AND user_id=$2 ORDER BY sequence', [threadId, user]);
      const turns: ChatTurn[] = []; for (const row of rows) turns.push(await this.present(q, user, set, row));
      return { thread: threadView(thread), turns };
    }, lock);
  }
  private async idle(q: Transaction, user: string, thread: string) {
    const active = await q.query(`SELECT a.id FROM study_chat_turns t JOIN study_generation_attempts a ON a.job_id=t.job_id
      WHERE t.thread_id=$1 AND t.user_id=$2 AND a.status IN ('queued','running') LIMIT 1`, [thread, user]);
    if (active.length) throw conflict();
  }
  async send(user: string, set: string, threadId: string, raw: ChatMessageInput) {
    const input = { ...raw, question: raw.question.trim(), sources: raw.sources.map(source => ({ ...source, materialId: source.materialId.toLowerCase() })).sort((a, b) => a.materialId.localeCompare(b.materialId)) };
    const digest = createHash('sha256').update(JSON.stringify({ threadId, question: input.question, language: input.language, sources: input.sources })).digest('hex');
    return this.db.tx(async q => {
      await this.thread(q, user, set, threadId);
      const [existing] = await q.query<TurnRow>('SELECT * FROM study_chat_turns WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]);
      if (existing) { if (existing.thread_id !== threadId || existing.request_digest !== digest) throw repeated();
        const turn = await this.present(q, user, set, existing); return { turn, job: turn.job, replayed: true }; }
      await this.idle(q, user, threadId);
      const [count] = await q.query<{ total: string }>('SELECT count(*) AS total FROM study_chat_turns WHERE thread_id=$1', [threadId]);
      const sequence = Number(count!.total) + 1;
      if (sequence > 100) throw new GenerationError('quota_exceeded', '本段对话已达到100轮，请新建对话。');
      const previous = await q.query<{ question: string; answer: string }>(`SELECT t.question,j.result->>'answer' AS answer FROM study_chat_turns t
        JOIN study_generation_jobs j ON j.id=t.job_id WHERE t.thread_id=$1 AND j.status='succeeded' ORDER BY t.sequence DESC LIMIT 4`, [threadId]);
      const history: ChatConfig['history'] = [];
      for (const turn of previous) {
        const bounded = { question: turn.question, answer: Array.from(turn.answer).slice(0, 1500).join('') };
        if (Buffer.byteLength(JSON.stringify([bounded, ...history])) > 8192) break;
        history.unshift(bounded);
      }
      const generation = await this.store.createInTransaction(q, user, set, { clientRequestId: input.clientRequestId, kind: 'chat_answer', sources: input.sources,
        config: { language: input.language, question: input.question, history } });
      // A generic generation request must never be attached as a second turn.
      if (generation.replayed) throw repeated();
      const [row] = await q.query<TurnRow>(`INSERT INTO study_chat_turns(user_id,thread_id,job_id,client_request_id,request_digest,sequence,question)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [user, threadId, generation.job.id, input.clientRequestId, digest, sequence, input.question]);
      await q.query('UPDATE study_chat_threads SET updated_at=clock_timestamp() WHERE id=$1', [threadId]);
      return { turn: await this.present(q, user, set, row!), job: generation.job, replayed: false };
    }, lock);
  }
  async turn(user: string, set: string, threadId: string, turnId: string): Promise<ChatTurn> {
    return this.db.tx(async q => {
      await this.thread(q, user, set, threadId);
      const [row] = await q.query<TurnRow>('SELECT * FROM study_chat_turns WHERE id=$1 AND thread_id=$2 AND user_id=$3', [turnId, threadId, user]);
      if (!row) throw absent(); return this.present(q, user, set, row);
    }, lock);
  }
  async stop(user: string, set: string, threadId: string, turnId: string) {
    const turn = await this.turn(user, set, threadId, turnId), job = await this.store.cancel(user, set, turn.jobId);
    return { turn: { ...turn, job }, job };
  }
  async retry(user: string, set: string, threadId: string, turnId: string, input: { clientRequestId: string }) {
    return this.db.tx(async q => {
      await this.thread(q, user, set, threadId);
      const [row] = await q.query<TurnRow>('SELECT * FROM study_chat_turns WHERE id=$1 AND thread_id=$2 AND user_id=$3', [turnId, threadId, user]);
      if (!row) throw absent();
      const replay = await q.query('SELECT id FROM study_generation_attempts WHERE job_id=$1 AND user_id=$2 AND client_request_id=$3 AND request_kind=\'retry\'', [row.job_id, user, input.clientRequestId]);
      if (!replay.length) {
        if ((await q.query('SELECT id FROM study_chat_turns WHERE thread_id=$1 AND sequence>$2 LIMIT 1', [threadId, row.sequence])).length) throw conflict();
        await this.idle(q, user, threadId);
      }
      const result = await this.store.retryInTransaction(q, user, set, row.job_id, input);
      return { turn: await this.present(q, user, set, row), job: result.job, replayed: result.replayed };
    }, lock);
  }
}
