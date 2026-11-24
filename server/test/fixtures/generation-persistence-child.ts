import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrations.js';
import { GenerationStore } from '../../src/generation/store.js';
import { DEFAULT_GENERATION_POLICY, type GenerationProviderConfig } from '../../src/generation/types.js';
import { createStudySet, createTextMaterial } from '../../src/services/study-data.js';
import { sharedIdentity } from '../database.js';

const [mode, directory, identity] = process.argv.slice(2);
assert.ok(directory && ['write', 'claim', 'recover'].includes(mode ?? ''));
const db = await openDb(`pglite://${directory}`, { migrations: mode === 'write' ? 'none' : 'check' });
const config: GenerationProviderConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',
  model: 'baidu/ernie-5.5-flash-preview:free', outputMode: 'compact', maxOutputTokens: 256, timeoutMs: 1000, providerOnly: ['baidu'] };
try {
  if (mode === 'write') {
    await sharedIdentity(db); await migrate(db);
    const user = (await db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id'))[0]!;
    const set = (await createStudySet(db, user.id, { title: 'Generation restart fixture', clientRequestId: randomUUID() })).studySet;
    const material = (await createTextMaterial(db, user.id, set.id, { title: 'Fixture', body: 'A persisted task keeps the original source across process restarts.', clientRequestId: randomUUID() })).material;
    const store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config);
    const { job } = await store.create(user.id, set.id, { clientRequestId: randomUUID(), kind: 'study_outline', sources: [{ materialId: material.id, version: 1 }], config: { language: 'en', pointCount: 1 } });
    console.log(JSON.stringify({ processId: process.pid, userId: user.id, setId: set.id, jobId: job.id, status: job.status }));
  } else {
    assert.ok(identity);
    const input = JSON.parse(identity) as { userId: string; setId: string; jobId: string; leaseExpiresAt?: string };
    const now = mode === 'recover' ? () => new Date(Date.parse(input.leaseExpiresAt!) + 1) : () => new Date();
    const store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config, { now });
    if (mode === 'claim') {
      const job = await store.get(input.userId, input.setId, input.jobId); assert.equal(job.status, 'queued');
      const claim = await store.claim(); assert.equal(claim?.jobId, job.id);
      // Close without settling to simulate losing a process after durable dispatch.
      console.log(JSON.stringify({ ...input, processId: process.pid, leaseExpiresAt: claim!.leaseExpiresAt, status: 'running' }));
    } else {
      assert.equal(await store.recoverExpired(), 1);
      const job = await store.get(input.userId, input.setId, input.jobId);
      assert.equal(await store.claim(), null); // No silent second provider request.
      console.log(JSON.stringify({ processId: process.pid, status: job.status, errorCode: job.errorCode,
        attemptCount: job.attemptCount, usageState: job.attempts[0]?.usage.state, snapshotBody: job.inputSnapshot?.sources[0]?.body }));
    }
  }
} finally { await db.close(); }
