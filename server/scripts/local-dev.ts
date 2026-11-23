/** Explicit local acceptance harness. This file is excluded from the production build. */
import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { createApp } from '../src/api/app.js';
import { STUDY_ORIGIN } from '../src/api/auth.js';
import { openDb } from '../src/db/db.js';
import { migrate, checkMigrations } from '../src/db/migrations.js';
import { sharedIdentity } from '../test/database.js';
import { createStudySet, createTextMaterial } from '../src/services/study-data.js';
import { createOpenRouterGenerationProvider } from '../src/generation/provider.js';
import { generationProviderConfig } from '../src/runtime/generation-config.js';
import { GenerationStore } from '../src/generation/store.js';
import { DEFAULT_GENERATION_POLICY } from '../src/generation/types.js';
import { startGenerationWorker } from '../src/generation/worker.js';

process.umask(0o077);
if (process.env.NODE_ENV !== 'development' || process.env.STUDYC_LOCAL_ACCEPTANCE !== '1') throw new Error('Explicit development environment required');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--planplan-config' || !args[1]?.startsWith('/'))) throw new Error('Invalid local arguments');
const localOrigin = 'http://127.0.0.1:5180';
const allowedHosts = new Set(['127.0.0.1:5180', '127.0.0.1:18790']);
const profile = process.env.STUDYC_LOCAL_PROFILE ?? 'acceptance';
if (!['acceptance', 'automated-qa'].includes(profile)) throw new Error('Invalid local profile');
const root = resolve(import.meta.dirname, '../../.local', profile);
await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
const marker = resolve(root, 'local-only.json');
try { if (JSON.parse(await readFile(marker, 'utf8')).kind !== 'studyc-local-acceptance-v1') throw new Error('Wrong local directory'); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  await writeFile(marker, JSON.stringify({ kind: 'studyc-local-acceptance-v1' }), { flag: 'wx', mode: 0o600 });
}
const db = await openDb(`pglite://${resolve(root, 'database')}`, { migrations: 'none' });
const identity = await db.query<{ present: boolean }>("SELECT to_regclass('users') IS NOT NULL AS present");
if (!identity[0]?.present) await sharedIdentity(db);
await migrate(db); await checkMigrations(db);
const accounts = [
  { id: 'a1111111-1111-4111-8111-111111111111', email: 'learner-a@studyc.local', name: '验收账户 A' },
  { id: 'b2222222-2222-4222-8222-222222222222', email: 'learner-b@studyc.local', name: '验收账户 B' },
];
for (const account of accounts) await db.query('INSERT INTO users(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [account.id]);
const seeds = [
  { id: 'c1111111-1111-4111-8111-111111111111', mid: 'd1111111-1111-4111-8111-111111111111', title: '水循环与城市', material: '水循环观察笔记',
    body: '水循环是水在海洋、陆地和大气之间不断转移的过程。太阳辐射为水的蒸发提供能量，水蒸气上升后冷却凝结，形成云中的小水滴或冰晶。降水把大气中的水带回地表，部分降水沿地面流动成为地表径流，另一部分渗入土壤补给地下水。植物通过蒸腾作用向大气释放水分。城市中的不透水路面会减少雨水下渗，并使暴雨期间的地表径流增加。透水铺装、雨水花园和湿地能够暂时储存雨水，减缓径流并促进下渗。水循环并不产生新的水分子，而是改变水的位置和状态。' },
  { id: 'c2222222-2222-4222-8222-222222222222', mid: 'd2222222-2222-4222-8222-222222222222', title: '项目安排与反馈', material: '项目管理入门笔记',
    body: '项目是为了交付独特成果而开展的临时活动。范围描述需要交付什么，进度说明工作何时完成，资源表示人员、设备和预算。里程碑是用于检查阶段成果的重要时间点，本身不代表一段持续的工作。依赖关系说明某项工作开始前必须满足什么条件，关键路径上的活动一旦延误，可能推迟整个项目的完成日期。风险是尚未发生但可能影响目标的不确定事件，问题则是已经发生且需要处理的情况。定期回顾既要记录完成的成果，也要记录阻碍和下一步行动。反馈应描述具体行为与影响，并明确可执行的改进建议。' },
];
for (const seed of seeds) {
  const set = await createStudySet(db, accounts[0]!.id, { clientRequestId: seed.id, title: seed.title });
  await createTextMaterial(db, accounts[0]!.id, set.studySet.id, { clientRequestId: seed.mid, title: seed.material, body: seed.body });
}
await createStudySet(db, accounts[1]!.id, { clientRequestId: 'c3333333-3333-4333-8333-333333333333', title: '账户 B 的独立学习集' });
let provider: ReturnType<typeof createOpenRouterGenerationProvider> | null = null;
if (args[1]) {
  const fd = openSync(args[1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) throw new Error('Private OpenRouter config required');
    const values = parseEnv(readFileSync(fd, 'utf8'));
    if (!values.OPENROUTER_API_KEY) throw new Error('Missing OpenRouter credential');
    provider = createOpenRouterGenerationProvider({ config: generationProviderConfig(values), apiKey: values.OPENROUTER_API_KEY });
  } finally { closeSync(fd); }
}
const store = new GenerationStore(db, DEFAULT_GENERATION_POLICY, provider?.config ?? null);
const sessions = new Map<string, { userId: string; csrfToken: string }>();
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...headers } });
const reject = (code: string, status: number, message = '本地验收请求未通过校验。') => json({ error: { code, message } }, status);
function tokenFrom(request: Request) {
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith('studyc-local-session='));
  if (cookies.length !== 1) return null;
  return cookies[0]!.slice('studyc-local-session='.length);
}
const app = createApp(db, {
  releaseId: 'local-acceptance', fileRoot: resolve(root, 'files'), rateLimitSecret: randomBytes(48), generationStore: store,
  sessionFetch: async (_input, init) => {
    const cookie = new Headers(init?.headers).get('cookie') ?? '';
    const token = cookie.startsWith('__Host-planplan-session=') ? cookie.slice('__Host-planplan-session='.length) : '';
    return sessions.has(token) ? json(sessions.get(token)) : reject('unauthorized', 401);
  },
});
await mkdir(resolve(root, 'files'), { recursive: true, mode: 0o700 });
const server = serve({ hostname: '127.0.0.1', port: 18790, fetch: async request => {
  try {
    const url = new URL(request.url);
    if (!allowedHosts.has(request.headers.get('host') ?? url.host)) return reject('origin_forbidden', 403);
    if (request.headers.get('origin') && request.headers.get('origin') !== localOrigin) return reject('origin_forbidden', 403);
    if (!['GET','HEAD'].includes(request.method) && request.headers.get('origin') !== localOrigin) return reject('origin_forbidden', 403);
    const token = tokenFrom(request), session = token ? sessions.get(token) : undefined;
    if (url.pathname === '/v1/auth/web/email/login' && request.method === 'POST') {
      const raw = await request.text(); if (raw.length > 4096) return reject('invalid_input', 400);
      const body = JSON.parse(raw) as Record<string, unknown>;
      const account = accounts.find(item => item.email === body.email);
      if (!account || body.password !== 'local-acceptance') return reject('unauthorized', 401, '请使用本地验收账户入口。');
      const cookie = randomBytes(32).toString('base64url');
      sessions.set(cookie, { userId: account.id, csrfToken: randomBytes(32).toString('base64url') });
      return json({ userId: account.id }, 200, { 'set-cookie': `studyc-local-session=${cookie}; Path=/; HttpOnly; SameSite=Strict` });
    }
    if (url.pathname === '/v1/auth/web/session' && request.method === 'GET') return session ? json(session) : reject('unauthorized', 401);
    if (url.pathname === '/v1/me' && request.method === 'GET') return session && request.headers.get('X-PlanPlan-Expected-User') === session.userId ? json({ id: session.userId, signInMethod: 'local-acceptance', aiConsent: true, roles: [] }) : reject('unauthorized', 401);
    if (url.pathname === '/v1/logout' && request.method === 'POST') {
      if (!session || request.headers.get('X-PlanPlan-Expected-User') !== session.userId || request.headers.get('X-CSRF-Token') !== session.csrfToken) return reject('csrf_invalid', 403);
      for (const [key, item] of sessions) if (item.userId === session.userId) sessions.delete(key);
      return json({ ok: true }, 200, { 'set-cookie': 'studyc-local-session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    if (url.pathname === '/v1/local/status' && request.method === 'GET') return json({ local: true, model: provider?.config.model ?? null, aiEnabled: !!provider });
    if (url.pathname.startsWith('/v1/study/')) {
      const headers = new Headers(request.headers);
      headers.delete('cookie');
      if (token && session) headers.set('cookie', `__Host-planplan-session=${token}`);
      if (request.headers.get('origin') === localOrigin) headers.set('origin', STUDY_ORIGIN);
      return app.fetch(new Request(request, { headers }));
    }
    if (url.pathname === '/readyz' || url.pathname === '/healthz') return app.fetch(request);
    return reject('not_found', 404);
  } catch { return reject('invalid_input', 400); }
} }, () => console.log(JSON.stringify({ event: 'local_ready', origin: localOrigin, model: provider?.config.model ?? null, data: root })));
const worker = provider ? startGenerationWorker(store, provider) : null;
let closing = false;
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 11_000).unref();
  void Promise.all([new Promise<void>(done => server.close(() => done())), worker?.stop()]).then(() => db.close()).then(() => { clearTimeout(timer); process.exit(0); });
});
