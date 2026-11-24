import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { GenerationStore } from '../src/generation/store.js';
import { startGenerationWorker, type GenerationWorkerStore } from '../src/generation/worker.js';
import { DEFAULT_GENERATION_POLICY, UNKNOWN_USAGE, type ClaimedGeneration, type GenerationOutcome, type GenerationProvider,
  type GenerationProviderConfig } from '../src/generation/types.js';
import { createStudySet, createTextMaterial } from '../src/services/study-data.js';
import { openTestDb } from './database.js';

const config: GenerationProviderConfig = {
  provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'synthetic/model', outputMode: 'strict',
  maxOutputTokens: 1000, timeoutMs: 60_000, providerOnly: [],
};
const outcome = (claim: ClaimedGeneration): GenerationOutcome => {
  const source = claim.snapshot.sources[0]!;
  return { status: 'succeeded', errorCode: null, usage: { state: 'reported', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCredits: '0.001', providerRequestId: 'fixture-request' },
    result: { schemaVersion: 1, title: '资料提纲', points: [{ text: '资料中的知识点', citations: [{ sourceId: source.sourceId, materialId: source.materialId,
      version: source.version, quote: source.body, start: 0, end: source.body.length, page: null }] }] } };
};
const provider = (generate: GenerationProvider['generate'], override: Partial<GenerationProviderConfig> = {}): GenerationProvider => ({ config: { ...config, ...override }, generate });
async function eventually(check: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Worker condition did not settle before test deadline');
}

describe('generation worker orchestration with real persisted claims', () => {
  let db: Db, store: GenerationStore, userId: string, setId: string, materialId: string;
  let clock: Date;
  const workers: ReturnType<typeof startGenerationWorker>[] = [];
  const start = (source: GenerationWorkerStore, gen: GenerationProvider, options: Parameters<typeof startGenerationWorker>[2] = {}) => {
    const worker = startGenerationWorker(source, gen, { pollMs: 5, cancelPollMs: 5, shutdownMs: 100, ...options });
    workers.push(worker); return worker;
  };
  const create = async () => {
    const { job } = await store.create(userId, setId, { clientRequestId: randomUUID(), kind: 'study_outline',
      sources: [{ materialId, version: 1 }], config: { language: 'zh-CN', pointCount: 1 } });
    clock = new Date(clock.getTime() + 1);
    return job;
  };
  beforeEach(async () => {
    db = await openTestDb(); clock = new Date();
    userId = (await db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id'))[0]!.id;
    setId = (await createStudySet(db, userId, { clientRequestId: randomUUID(), title: '学习集' })).studySet.id;
    materialId = (await createTextMaterial(db, userId, setId, { clientRequestId: randomUUID(), title: '原文', body: '植物通过光合作用转化能量。' })).material.id;
    store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config, { now: () => clock });
  }, 30_000);
  afterEach(async () => {
    await Promise.all(workers.splice(0).map(worker => worker.stop()));
    await db.close();
  });

  it('two workers dispatch the same queued job exactly once after reopening the store', async () => {
    const job = await create();
    const reopened = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config, { now: () => clock });
    let calls = 0;
    const gen = provider(async claim => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return outcome(claim); });
    start(store, gen); start(reopened, gen);
    await eventually(async () => (await store.get(userId, setId, job.id)).status === 'succeeded');
    expect(calls).toBe(1);
    expect((await store.get(userId, setId, job.id)).attemptCount).toBe(1);
  });

  it('recovers expired running attempts as interrupted without automatically dispatching them again', async () => {
    const expired = await create();
    const claim = await store.claim();
    expect(claim?.jobId).toBe(expired.id);
    const queued = await create();
    clock = new Date(Date.parse(claim!.leaseExpiresAt) + 1);
    const calls: string[] = [];
    start(store, provider(async job => { calls.push(job.jobId); return outcome(job); }));
    await eventually(async () => (await store.get(userId, setId, queued.id)).status === 'succeeded');
    expect((await store.get(userId, setId, expired.id)).status).toBe('interrupted');
    expect(calls).toEqual([queued.id]);
  });

  it('observes cancellation from another store and ignores a late successful result', async () => {
    const job = await create();
    let signal: AbortSignal | undefined, resolve!: (value: GenerationOutcome) => void, claim: ClaimedGeneration | undefined;
    start(store, provider(async (value, current) => { claim = value; signal = current; return new Promise(done => { resolve = done; }); }));
    await eventually(() => !!signal);
    const otherProcess = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config, { now: () => clock });
    await otherProcess.cancel(userId, setId, job.id);
    await eventually(() => signal!.aborted);
    await eventually(async () => (await store.get(userId, setId, job.id)).attempts[0]?.status === 'cancelled');
    expect((await store.get(userId, setId, job.id)).attempts[0]!.usage.state).toBe('unknown');
    resolve(outcome(claim!));
    await eventually(async () => (await store.get(userId, setId, job.id)).attempts[0]?.usage.state === 'reported');
    const saved = await store.get(userId, setId, job.id);
    expect(saved.status).toBe('cancelled');
    expect(saved.result).toBeNull();
    expect(saved.attempts[0]!.usage.totalTokens).toBe(15);
  });

  it('provider exceptions are sanitized and do not stop the next queued job', async () => {
    const first = await create(), second = await create();
    let calls = 0;
    const errors: string[] = [];
    start(store, provider(async claim => { if (++calls === 1) throw new Error('secret-provider-response'); return outcome(claim); }), { onError: code => errors.push(code) });
    await eventually(async () => (await store.get(userId, setId, second.id)).status === 'succeeded');
    const failed = await store.get(userId, setId, first.id);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
    expect(failed.attempts[0]!.usage.state).toBe('unknown');
    expect(errors).toContain('generation_provider_failed');
    expect(JSON.stringify(errors)).not.toContain('secret-provider-response');
  });

  it('observes account deletion and aborts the active provider request', async () => {
    const job = await create();
    let signal: AbortSignal | undefined;
    start(store, provider(async (_claim, current) => {
      signal = current;
      await new Promise<void>(resolve => { current.addEventListener('abort', () => resolve(), { once: true }); });
      return { status: 'cancelled', result: null, errorCode: 'cancelled', usage: { ...UNKNOWN_USAGE } };
    }));
    await eventually(() => !!signal);
    await db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [userId]);
    await eventually(() => signal!.aborted);
    await eventually(async () => {
      const [row] = await db.query<{ status: string; result: unknown }>('SELECT status,result FROM study_generation_jobs WHERE id=$1', [job.id]);
      return row?.status === 'cancelled' && row.result === null;
    });
  });

  it('does not dispatch a queued task with a changed persisted provider configuration', async () => {
    const job = await create();
    let calls = 0;
    start(store, provider(async claim => { calls++; return outcome(claim); }, { model: 'different/model' }));
    await eventually(async () => (await store.get(userId, setId, job.id)).status === 'failed');
    const saved = await store.get(userId, setId, job.id);
    expect(calls).toBe(0);
    expect(saved.errorCode).toBe('config_changed');
    expect(saved.attempts[0]!.usage.state).toBe('not_sent');
  });

  it('bounded stop interrupts noncooperative providers, retains unknown usage and leaves queued work for restart', async () => {
    const first = await create(), queued = await create();
    let dispatched = false;
    const worker = start(store, provider(async () => { dispatched = true; return new Promise(() => {}); }), { shutdownMs: 100 });
    await eventually(() => dispatched);
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(500);
    const interrupted = await store.get(userId, setId, first.id);
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.attempts[0]!.usage.state).toBe('unknown');
    expect((await store.get(userId, setId, queued.id)).status).toBe('queued');
    const resumed: string[] = [];
    start(new GenerationStore(db, DEFAULT_GENERATION_POLICY, config), provider(async claim => { resumed.push(claim.jobId); return outcome(claim); }));
    await eventually(async () => (await store.get(userId, setId, queued.id)).status === 'succeeded');
    expect(resumed).toEqual([queued.id]);
  });

  it('settles a claim arriving after shutdown without ever sending it to the provider', async () => {
    const job = await create();
    const claim = await store.claim();
    let release!: (claim: ClaimedGeneration | null) => void, entered = false, sends = 0;
    const delayed: GenerationWorkerStore = {
      recoverExpired: store.recoverExpired.bind(store), shouldCancel: store.shouldCancel.bind(store), settle: store.settle.bind(store),
      claim: async () => { entered = true; return new Promise(resolve => { release = resolve; }); },
    };
    const errors: string[] = [];
    const worker = start(delayed, provider(async value => { sends++; return outcome(value); }), { shutdownMs: 20, onError: code => errors.push(code) });
    await eventually(() => entered);
    await worker.stop();
    expect(errors).toContain('generation_shutdown_timeout');
    release(claim);
    await eventually(async () => (await store.get(userId, setId, job.id)).status === 'interrupted');
    expect(sends).toBe(0);
    expect((await store.get(userId, setId, job.id)).attempts[0]!.usage.state).toBe('not_sent');
  });

  it('poll failures and logger failures do not poison subsequent ticks', async () => {
    const job = await create();
    let recoverCalls = 0;
    const unreliable: GenerationWorkerStore = {
      claim: store.claim.bind(store), shouldCancel: store.shouldCancel.bind(store), settle: store.settle.bind(store),
      recoverExpired: async () => { if (++recoverCalls === 1) throw new Error('private-db-detail'); return store.recoverExpired(); },
    };
    start(unreliable, provider(async claim => outcome(claim)), { onError: () => { throw new Error('logger failed'); } });
    await eventually(async () => (await store.get(userId, setId, job.id)).status === 'succeeded');
    expect(recoverCalls).toBeGreaterThan(1);
  });
});

describe('trash generation accounting',()=>{
 it('cancels queued and running attempts without refunding reported usage or dispatching on restore',async()=>{
  const {TrashService}=await import('../src/services/trash.js');const db=await openTestDb();
  try{
   const user=(await db.query<{id:string}>('INSERT INTO users DEFAULT VALUES RETURNING id'))[0]!.id;
   const set=(await createStudySet(db,user,{clientRequestId:randomUUID(),title:'回收站生成'})).studySet.id;
   const material=(await createTextMaterial(db,user,set,{clientRequestId:randomUUID(),title:'来源',body:'保留实际用量'})).material;
   const store=new GenerationStore(db,DEFAULT_GENERATION_POLICY,config),trash=new TrashService(db,store);
   const enqueue=()=>store.create(user,set,{clientRequestId:randomUUID(),kind:'study_outline',sources:[{materialId:material.id,version:1}],config:{language:'zh-CN',pointCount:1}});
   const first=await enqueue(),claim=await store.claim(),second=await enqueue();expect(claim!.jobId).toBe(first.job.id);
   await trash.change(user,set,{clientRequestId:randomUUID(),version:0,deleted:true});
   expect(await store.shouldCancel(claim!)).toBe(true);expect(await store.claim()).toBeNull();
   const [queued]=await db.query<any>('SELECT * FROM study_generation_attempts WHERE job_id=$1',[second.job.id]);expect(queued.status).toBe('cancelled');expect(queued.usage_state).toBe('not_sent');expect(Number(queued.accounted_tokens)).toBe(0);
   await store.settle(claim!,outcome(claim!));
   await trash.change(user,set,{clientRequestId:randomUUID(),version:1,deleted:false});
   const saved=await store.get(user,set,first.job.id);expect(saved.status).toBe('cancelled');expect(saved.result).toBeNull();expect(saved.attempts[0]!.usage.totalTokens).toBe(15);expect(await store.claim()).toBeNull();
  }finally{await db.close();}
 },30000);
});
