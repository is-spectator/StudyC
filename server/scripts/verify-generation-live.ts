/** Explicit opt-in, one real OpenRouter request with synthetic study material.
 * All database work is confined by openTestDb to ephemeral PGlite or a dedicated
 * *_test PostgreSQL schema. Never use a production database or user content.
 * No secrets, headers, upstream response bodies, or real account data are logged.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';
import { createApp } from '../src/api/app.js';
import { GenerationStore } from '../src/generation/store.js';
import { createOpenRouterGenerationProvider, DEFAULT_OPENROUTER_MODEL } from '../src/generation/provider.js';
import { DEFAULT_GENERATION_POLICY, type GenerationInput } from '../src/generation/types.js';
import { startGenerationWorker } from '../src/generation/worker.js';
import { generationProviderConfig } from '../src/runtime/generation-config.js';
import { createStudySet, createTextMaterial, updateTextMaterial } from '../src/services/study-data.js';
import { openTestDb } from '../test/database.js';

const args = process.argv.slice(2);
if (!args.includes('--run')) {
  console.log('Prepared only. Use --run --planplan-config <private dotenv file> --report <absolute summary path>. One synthetic OpenRouter request; no production database.');
  process.exit(0);
}
function argument(name: string): string {
  const index = args.indexOf(name), value = args[index + 1];
  if (index < 0 || !value || !isAbsolute(value) || args.lastIndexOf(name) !== index) throw new Error('Invalid arguments');
  return value;
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run') continue;
  if (args[i] === '--planplan-config' || args[i] === '--report') { i++; continue; }
  throw new Error('Invalid arguments');
}
const configPath = argument('--planplan-config'), reportPath = argument('--report');
if (configPath === reportPath) throw new Error('Report must not overwrite config');
const report: Record<string, unknown> = { passed: false, syntheticOnly: true, productionDatabase: false, startedAt: new Date().toISOString() };
let db: Awaited<ReturnType<typeof openTestDb>> | undefined;
let worker: ReturnType<typeof startGenerationWorker> | undefined;
let phase = 'configuration';
let calls = 0;
try {
  const fd = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let env: NodeJS.ProcessEnv;
  try {
    const stat = await fd.stat();
    assert.ok(stat.isFile() && stat.size <= 32768 && (stat.mode & 0o027) === 0);
    const bytes = Buffer.alloc(32769);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    assert.ok(bytesRead <= 32768);
    env = parseEnv(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await fd.close(); }
  assert.equal(env.AI_PROVIDER, 'openrouter');
  const config = generationProviderConfig(env);
  // This acceptance runner follows the user-approved PlanPlan free configuration.
  assert.equal(config.model, DEFAULT_OPENROUTER_MODEL);
  const apiKey = env.OPENROUTER_API_KEY;
  assert.ok(apiKey && apiKey.startsWith('sk-or-'));
  const provider = createOpenRouterGenerationProvider({ config, apiKey, fetch: async (url, init) => {
    calls++;
    assert.equal(calls, 1, 'Live runner permits one outbound model request');
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    const upstream = await fetch(url, init);
    if (!upstream.ok) {
      const probe = upstream.clone().body?.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        if (probe) while (true) {
          const part = await probe.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 16384) { void probe.cancel().catch(() => undefined); break; }
          chunks.push(part.value);
        }
        if (bytes <= 16384) {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const message = typeof value?.error?.message === 'string' ? value.error.message : '';
          report.upstreamFailure = { status: upstream.status,
            category: /per.day|daily|day.*limit/i.test(message) ? 'daily_request_limit'
              : value?.error?.metadata?.provider_name ? 'upstream_provider_limit' : 'request_limit',
            provider: /^baidu$/i.test(value?.error?.metadata?.provider_name ?? '') ? 'baidu' : null,
            retryAfterSeconds: /^\d{1,9}$/.test(upstream.headers.get('retry-after') ?? '') ? Number(upstream.headers.get('retry-after')) : null };
        }
      } catch { report.upstreamFailure = { status: upstream.status, category: 'unclassified' }; }
      finally { probe?.releaseLock(); }
    }
    return upstream;
  } });
  // Do not retain unrelated PlanPlan variables in the test harness.
  for (const name of Object.keys(env)) delete env[name];
  phase = 'isolated-database';
  db = await openTestDb();
  const [user] = await db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
  assert.ok(user);
  const set = (await createStudySet(db, user.id, { title: 'Synthetic generation acceptance', clientRequestId: randomUUID() })).studySet;
  const original = '蒸发是液态水转变为水蒸气的过程，水面上的水可以通过蒸发进入空气。\n凝结是水蒸气变成液态小水滴的过程，云中的小水滴与凝结过程有关。\n降水包括雨和雪，能够把水从大气带回地面。\n地表径流能够把陆地上的水输送到河流、湖泊和海洋。';
  const material = (await createTextMaterial(db, user.id, set.id, { title: '水循环合成测试资料', body: original, clientRequestId: randomUUID() })).material;
  const store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, config);
  const csrf = 'g'.repeat(43);
  const app = createApp(db, { releaseId: 'synthetic-generation-live', rateLimitSecret: new TextEncoder().encode('synthetic-generation-live-rate-key-0000'),
    generationStore: store, sessionFetch: async () => Response.json({ userId: user.id, csrfToken: csrf }) });
  const headers = { 'content-type': 'application/json', cookie: '__Host-planplan-session=synthetic-live-cookie',
    origin: 'https://study.clyna.ai', 'X-PlanPlan-Expected-User': user.id, 'X-CSRF-Token': csrf };
  const input: GenerationInput = { clientRequestId: randomUUID(), kind: 'study_outline', sources: [{ materialId: material.id, version: 1 }], config: { language: 'zh-CN', pointCount: 2 } };
  phase = 'queue-through-api';
  const path = `/v1/study/sets/${set.id}/generations`;
  const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(response.status, 202);
  const { job: created } = await response.json();
  phase = 'real-openrouter-generation';
  worker = startGenerationWorker(store, provider, { pollMs: 100, cancelPollMs: 100 });
  const deadline = Date.now() + 75000;
  let job = await store.get(user.id, set.id, created.id);
  while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    job = await store.get(user.id, set.id, created.id);
  }
  report.status = job.status;
  report.errorCode = job.errorCode;
  assert.equal(job.status, 'succeeded');
  assert.ok(job.result && 'points' in job.result);
  assert.equal(job.result?.points.length, 2);
  assert.equal(job.attempts[0]?.usage.state, 'reported');
  assert.ok(job.result?.points.every(point => point.citations.length > 0 && point.citations.every(citation =>
    citation.materialId === material.id && citation.version === 1 && original.slice(citation.start, citation.end) === citation.quote)));
  await worker.stop(); worker = undefined;
  phase = 'persisted-input-and-idempotency';
  await updateTextMaterial(db, user.id, set.id, material.id, { version: 1, body: '资料已经修改，既有生成任务应继续保留原始输入。' });
  const replay = await app.request(path, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(replay.status, 200);
  const replayed = (await replay.json()).job;
  assert.equal(replayed.id, created.id);
  assert.equal(replayed.inputSnapshot.sources[0].body, original);
  const reloaded = await new GenerationStore(db, DEFAULT_GENERATION_POLICY, config).get(user.id, set.id, created.id);
  assert.deepEqual(reloaded.result, job.result);
  const usage = await store.usage(user.id);
  assert.equal(usage.requests, 1); assert.equal(calls, 1);
  report.passed = true;
  report.model = config.model;
  report.pointCount = job.result?.points.length;
  report.inputSnapshotPreserved = true;
  report.idempotentReplayVerified = true;
  report.usage = job.attempts[0]?.usage;
  report.budgetTokens = usage.tokens;
} catch {
  report.failedPhase = phase;
  process.exitCode = 1;
} finally {
  await worker?.stop();
  if (db) {
    try { await db.close(); report.testDatabaseCleanupVerified = true; }
    catch { report.testDatabaseCleanupVerified = false; report.passed = false; process.exitCode = 1; }
  }
  report.providerRequests = calls;
  report.endedAt = new Date().toISOString();
  // Exclusive creation prevents an accidentally supplied path from replacing a file.
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, phase: report.failedPhase ?? 'completed', providerRequests: calls,
    status: report.status ?? null, errorCode: report.errorCode ?? null, report: reportPath }));
}
