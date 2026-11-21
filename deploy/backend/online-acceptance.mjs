#!/usr/bin/env node
/**
 * Run on the existing server AFTER independent StudyC activation. Use the existing
 * identity runtime env only for this short-lived synthetic acceptance process:
 * node-24 --env-file=/etc/planplan-web/runtime.env online-acceptance.mjs \
 *   --identity-release /opt/planplan-web/releases/4692cb11f7fdeb4f8ea7fdb69750e3dbe71880c25f36e76c791497fdcbb56f98 \
 *   --study-release /opt/studyc-api/releases/<40-char-git-sha> \
 *   --report /root/<private-deployment-directory>/acceptance.json [--restart-service]
 *
 * Creates exactly two synthetic accounts through the existing account service and
 * removes only those accounts through the existing deletion workflow in finally.
 * Does not enable dev login, modify email allowlists, send mail, call AI, or log
 * credentials. Existing customer rows are never read; only aggregate counts are.
 * The optional restart targets only studyc.service. PlanPlan must keep its PID
 * and release throughout this run. No identity credentials are written to StudyC.
 */
import { randomUUID } from 'node:crypto';
import { readFile, realpath, lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

process.umask(0o077);
const run = promisify(execFile);
const identityRevision = '4692cb11f7fdeb4f8ea7fdb69750e3dbe71880c25f36e76c791497fdcbb56f98';
const studyOrigin = 'https://study.clyna.ai';
const planOrigin = 'https://planplan.clyna.ai';
const clynaOrigin = 'https://clyna.ai';
const hosts = new Set([studyOrigin, planOrigin, clynaOrigin]);
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--restart-service' && options.restart === undefined) options.restart = true;
  else if (['--identity-release', '--study-release', '--report'].includes(key) && options[key] === undefined && args[i + 1]) options[key] = args[++i];
  else { process.stderr.write('Invalid explicit acceptance arguments.\n'); process.exit(2); }
}
if (process.getuid?.() !== 0 || options['--identity-release'] !== `/opt/planplan-web/releases/${identityRevision}`
  || !/^\/opt\/studyc-api\/releases\/[a-f0-9]{40}$/.test(options['--study-release'] ?? '')
  || !/^\/root\/.+\/acceptance\.json$/.test(options['--report'] ?? '')) {
  process.stderr.write('Use root, explicit identity and StudyC releases, and a private /root report path.\n');
  process.exit(2);
}

class AcceptanceFailure extends Error {
  constructor(test) { super('Acceptance assertion failed'); this.test = test; }
}
const report = {
  format: 1, startedAt: new Date().toISOString(), target: studyOrigin,
  identityRelease: options['--identity-release'], studyRelease: options['--study-release'], restartRequested: options.restart === true,
  fixtureRunPrefix: `studyc-deploy-${randomUUID()}`, fixtures: [], assertions: [],
  cleanup: [], success: false, process: { pid: process.pid, parentPid: process.ppid },
};
let reportPath;
let db;
let requestAccountDeletion;
let failure;
let interrupted = false;
const abort = new AbortController();
function cancel(reason) { interrupted = true; report.cancellation = reason; abort.abort(); }
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => cancel(signal));
const overallTimer = setTimeout(() => cancel('overall-timeout'), 300_000);

async function saveReport() {
  if (!reportPath) return;
  const temp = `${reportPath}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temp, reportPath);
}
function check(name, passed) {
  if (interrupted) throw new AcceptanceFailure('operator_interrupted');
  report.assertions.push({ name, passed: !!passed });
  if (!passed) throw new AcceptanceFailure(name);
}
async function request(origin, path, session, method = 'GET', body, override = {}) {
  if (interrupted) throw new AcceptanceFailure('operator_interrupted');
  if (!hosts.has(origin) || !path.startsWith('/')) throw new AcceptanceFailure('fixed_https_target');
  const headers = { ...(session ? {
    Cookie: session.cookie, Origin: origin,
    'X-PlanPlan-Expected-User': session.userId, 'X-CSRF-Token': session.csrf,
  } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...override };
  const response = await fetch(`${origin}${path}`, {
    method, headers, redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { /* Nginx rejection responses may be HTML. */ }
  return { status: response.status, cache: response.headers.get('cache-control') ?? '', data };
}
function noStore(value) { return /(?:^|,)\s*no-store\s*(?:,|$)/i.test(value); }
function outcome(name, result, status, code) {
  check(name, result.status === status && (code === undefined || result.data?.error?.code === code));
  check(`${name}:private-no-store`, noStore(result.cache) && /(?:^|,)\s*private\s*(?:,|$)/i.test(result.cache));
}
async function counts() {
  const [row] = await db.query(`SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM plans) AS plans,
    (SELECT count(*)::int FROM study_sets) AS study_sets,
    (SELECT count(*)::int FROM study_materials) AS study_materials`);
  return row;
}
async function planPlanMainPid() {
  const result = await run('systemctl', ['show', 'planplan-web.service', '--property=MainPID', '--value'], { timeout: 5000, maxBuffer: 1024 });
  const value = result.stdout.trim();
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AcceptanceFailure('planplan-main-process-running');
  return Number(value);
}
async function waitReady(expected) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new AcceptanceFailure('operator_interrupted');
    try {
      const result = await fetch('http://127.0.0.1:8790/readyz', {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(1500, Math.max(1, deadline - Date.now())))]), redirect: 'manual',
      });
      if (result.status === 200) {
        const data = await result.json();
        if (data.ok === true && data.release === expected && data.service === 'studyc') return;
      }
    } catch { /* Retry only this read-only readiness probe. */ }
    if (Date.now() < deadline) await sleep(Math.min(500, deadline - Date.now()));
  }
  throw new AcceptanceFailure('restart_readiness_matches_release');
}

try {
  const release = await realpath(options['--identity-release']);
  const studyRelease = await realpath(options['--study-release']);
  check('canonical-identity-release-directory', release === options['--identity-release']);
  check('activated-identity-release-matches', await realpath('/opt/planplan-web/current') === release);
  check('canonical-study-release-directory', studyRelease === options['--study-release']);
  check('activated-study-release-matches', await realpath('/opt/studyc-api/current') === studyRelease);
  const reportDirectory = dirname(resolve(options['--report']));
  check('report-path-normalized', resolve(options['--report']) === options['--report']);
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(reportDirectory);
  check('private-report-directory', !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o077) === 0);
  const candidateReportPath = join(reportDirectory, 'acceptance.json');
  try { await lstat(candidateReportPath); throw new AcceptanceFailure('new-report-path-required'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  reportPath = candidateReportPath;
  const manifest = JSON.parse(await readFile(join(release, 'source-manifest.json'), 'utf8'));
  check('source-release-identity', manifest.releaseId === `source-sha256:${release.split('/').at(-1)}`);
  check('runtime-release-identity', process.env.RELEASE_ID === manifest.releaseId);
  report.identityReleaseId = manifest.releaseId;
  report.studyReleaseId = `git:${studyRelease.split('/').at(-1)}`;
  report.planPlanMainPidBefore = await planPlanMainPid();
  report.identityPublicReleasesBefore = {};
  for (const [label, origin] of [['clyna', clynaOrigin], ['planplan', planOrigin]]) {
    const ready = await request(origin, '/readyz');
    check(`${label}-baseline-readiness`, ready.status === 200 && ready.data?.ok === true && ready.data.release === manifest.releaseId);
    report.identityPublicReleasesBefore[label] = ready.data.release;
  }
  const studyReady = await request(studyOrigin, '/readyz');
  check('independent-study-readiness', studyReady.status === 200 && studyReady.data?.ok === true
    && studyReady.data.service === 'studyc' && studyReady.data.release === report.studyReleaseId);
  await saveReport();
  const module = relative => import(pathToFileURL(join(release, 'server/dist', relative)).href);
  const { loadRuntimeSecrets } = await module('src/runtime/secrets.js');
  loadRuntimeSecrets();
  check('production-mode-and-no-dev-login', ['beta', 'production'].includes(process.env.DEPLOYMENT_ENV ?? '') && process.env.DEV_LOGIN !== '1');
  const { managedDatabaseOptions } = await module('src/runtime/database.js');
  const { openDb } = await module('src/db/db.js');
  const { checkMigrations } = await module('src/db/migrations.js');
  const { authConfigFromEnv } = await module('src/auth/config.js');
  const { upsertUser, issueToken } = await module('src/api/auth.js');
  const { csrfTokenFor } = await module('src/api/web-session.js');
  ({ requestAccountDeletion } = await module('src/services/deletion.js'));
  const auth = authConfigFromEnv(process.env);
  check('secure-cookie-origins', auth.cookieSecure !== false && [...hosts].every(origin => auth.webAllowedOrigins?.includes(origin)));
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.searchParams.set('query_timeout', '12000');
  databaseUrl.searchParams.set('idle_in_transaction_session_timeout', '10000');
  db = await openDb(databaseUrl.toString(), { ...managedDatabaseOptions(databaseUrl.toString(), process.env), migrations: 'none' });
  await checkMigrations(db);
  const [identity] = await db.query('SELECT current_database() AS database, current_user AS role');
  check('expected-existing-database-and-app-role', identity.database === 'planplan_web' && identity.role === 'planplan_web_app');
  report.countsBefore = await counts();
  const sessions = [];
  for (const suffix of ['a', 'b']) {
    const name = `${report.fixtureRunPrefix}-${suffix}`;
    const existing = await db.query('SELECT id FROM users WHERE dev_name = $1', [name]);
    check(`fixture-${suffix}-name-unused`, existing.length === 0);
    // Record the verified-unused name before attempting INSERT, so cleanup can
    // recover the account even if its commit acknowledgement is lost.
    const fixture = { userId: null, name };
    report.fixtures.push(fixture);
    await saveReport();
    const user = await upsertUser(db, { devName: name });
    fixture.userId = user.id;
    await saveReport();
    const token = await issueToken(auth, user.id, user.token_version);
    sessions.push({ userId: user.id, cookie: `__Host-planplan-session=${token}`, csrf: csrfTokenFor(auth, token) });
  }
  const [alice, bob] = sessions;
  const api = (path, session = alice, method = 'GET', body, headers) => request(studyOrigin, path, session, method, body, headers);
  const base = '/v1/study/sets';
  const createInput = { clientRequestId: randomUUID(), title: '部署验收·独立学习集' };
  let result = await api(base, alice, 'POST', createInput);
  outcome('create-study-set', result, 201);
  const setA = result.data?.studySet;
  check('study-set-id-and-version', uuidPattern.test(setA?.id ?? '') && setA.version === 1);
  result = await api(base, alice, 'POST', createInput);
  outcome('retry-study-set', result, 200);
  check('retry-keeps-set-id', result.data?.studySet?.id === setA.id);
  outcome('changed-create-intent-conflict', await api(base, alice, 'POST', { ...createInput, title: '不同意图' }), 409, 'idempotency_conflict');
  result = await api(base, alice, 'POST', { ...createInput, clientRequestId: randomUUID() });
  outcome('same-title-independent-set', result, 201);
  const setA2 = result.data?.studySet;
  check('distinct-set-id', uuidPattern.test(setA2?.id ?? '') && setA2.id !== setA.id);
  result = await api(base, bob, 'POST', createInput);
  outcome('other-account-independent-create', result, 201);
  const setB = result.data?.studySet;
  check('other-account-distinct-id', uuidPattern.test(setB?.id ?? '') && setB.id !== setA.id);
  result = await api(base);
  outcome('list-own-study-sets', result, 200);
  check('alice-list-isolated', result.data?.items?.length === 2 && result.data.items.every(item => [setA.id, setA2.id].includes(item.id)));
  result = await api(base, bob);
  outcome('list-second-account', result, 200);
  check('bob-list-isolated', result.data?.items?.length === 1 && result.data.items[0].id === setB.id);
  outcome('get-study-set', await api(`${base}/${setA.id}`), 200);
  result = await api(`${base}/${setA.id}`, alice, 'PATCH', { version: 1, title: '部署验收·已改名' });
  outcome('rename-study-set', result, 200);
  check('rename-advances-version', result.data?.studySet?.version === 2);
  outcome('stale-set-version', await api(`${base}/${setA.id}`, alice, 'PATCH', { version: 1, title: '不能覆盖' }), 409, 'version_conflict');

  const materials = `${base}/${setA.id}/materials`;
  const text = '部署验收合成资料：6份线段有7个端点，共21条。\n  保留空格 😀\r\n<script>纯文本</script>';
  const noteInput = { clientRequestId: randomUUID(), title: '部署验收·文本资料', body: text };
  result = await api(materials, alice, 'POST', noteInput);
  outcome('create-text-material', result, 201);
  const note = result.data?.material;
  check('plain-text-preserved', uuidPattern.test(note?.id ?? '') && note.body === text && note.studySetId === setA.id);
  result = await api(materials, alice, 'POST', noteInput);
  outcome('retry-material', result, 200);
  check('retry-keeps-material-id', result.data?.material?.id === note.id);
  outcome('material-create-intent-conflict', await api(materials, alice, 'POST', { ...noteInput, body: '不同正文' }), 409, 'idempotency_conflict');
  result = await api(materials, alice, 'POST', { clientRequestId: randomUUID(), title: '部署验收·空白笔记', body: '' });
  outcome('blank-note', result, 201);
  check('blank-body-preserved', result.data?.material?.body === '');
  result = await api(materials);
  outcome('list-materials', result, 200);
  check('material-list-has-no-body', result.data?.items?.length === 2 && result.data.items.every(item => !Object.hasOwn(item, 'body')));
  result = await api(`${materials}/${note.id}`);
  outcome('read-material', result, 200);
  check('read-text-exact', result.data?.material?.body === text);
  const updatedText = `${text}\n保存后的版本。`;
  result = await api(`${materials}/${note.id}`, alice, 'PATCH', { version: 1, body: updatedText });
  outcome('update-material', result, 200);
  check('update-version-and-text', result.data?.material?.version === 2 && result.data.material.body === updatedText);
  outcome('stale-material-version', await api(`${materials}/${note.id}`, alice, 'PATCH', { version: 1, body: '不能覆盖' }), 409, 'version_conflict');
  outcome('cross-account-set-read-denied', await api(`${base}/${setA.id}`, bob), 404, 'not_found');
  outcome('cross-account-material-list-denied', await api(materials, bob), 404, 'not_found');
  outcome('cross-account-material-read-denied', await api(`${materials}/${note.id}`, bob), 404, 'not_found');
  outcome('cross-account-material-write-denied', await api(`${materials}/${note.id}`, bob, 'PATCH', { version: 2, body: '不能覆盖' }), 404, 'not_found');
  outcome('wrong-parent-denied', await api(`${base}/${setA2.id}/materials/${note.id}`), 404, 'not_found');
  outcome('anonymous-denied', await api(base, null), 401, 'unauthorized');
  outcome('account-binding-denied', await api(base, alice, 'GET', undefined, { 'X-PlanPlan-Expected-User': bob.userId }), 409, 'account_mismatch');
  outcome('csrf-denied', await api(base, alice, 'POST', { clientRequestId: randomUUID(), title: '不能创建' }, { 'X-CSRF-Token': 'invalid' }), 403, 'csrf_invalid');
  outcome('origin-denied', await api(base, alice, 'POST', { clientRequestId: randomUUID(), title: '不能创建' }, { Origin: 'https://invalid.example' }), 403, 'origin_forbidden');
  outcome('wrong-method-denied', await api(base, alice, 'DELETE'), 405);
  outcome('unexposed-planplan-api-denied', await api('/v1/templates'), 404);
  outcome('malformed-study-path-denied', await api(`${base}/not-a-uuid/materials`), 404);
  outcome('large-decoded-text-denied', await api(materials, alice, 'POST', { clientRequestId: randomUUID(), title: '过大合成正文', body: 'x'.repeat(1024 * 1024 + 1) }), 413, 'payload_too_large');
  outcome('nginx-large-request-denied', await api(materials, alice, 'POST', { clientRequestId: randomUUID(), title: '过大合成请求', body: 'x'.repeat(2 * 1024 * 1024 + 1) }), 413);
  const session = await api('/v1/auth/web/session');
  outcome('existing-session-bootstrap', session, 200);
  check('session-keeps-account', session.data?.userId === alice.userId);

  if (options.restart) {
    report.restartAttempted = true;
    await saveReport();
    await run('systemctl', ['restart', 'studyc.service'], { timeout: 35_000, maxBuffer: 16 * 1024 });
    await waitReady(report.studyReleaseId);
    check('restart_readiness_matches_release', true);
    check('study-restart-keeps-planplan-main-pid', await planPlanMainPid() === report.planPlanMainPidBefore);
    result = await api(`${materials}/${note.id}`);
    outcome('same-session-read-after-service-restart', result, 200);
    check('restart-preserves-material', result.data?.material?.body === updatedText && result.data.material.version === 2);
    result = await api(`${base}/${setA.id}`);
    outcome('set-read-after-service-restart', result, 200);
    check('restart-preserves-set', result.data?.studySet?.title === '部署验收·已改名' && result.data.studySet.version === 2);
    report.restartVerified = true;
  }
  for (const [label, origin] of [['clyna', clynaOrigin], ['planplan', planOrigin]]) {
    const ready = await request(origin, '/readyz');
    check(`${label}-readiness`, ready.status === 200 && ready.data?.ok === true
      && ready.data.release === manifest.releaseId && ready.data.release === report.identityPublicReleasesBefore[label]);
    const anonymous = await request(origin, '/v1/auth/web/session');
    check(`${label}-anonymous-session-still-protected`, anonymous.status === 401 && noStore(anonymous.cache));
    const plans = await request(origin, '/v1/plans', alice);
    check(`${label}-synthetic-account-plan-api`, plans.status === 200 && noStore(plans.cache));
  }
  const finalStudyReady = await request(studyOrigin, '/readyz');
  check('independent-study-final-readiness', finalStudyReady.status === 200 && finalStudyReady.data?.ok === true
    && finalStudyReady.data.service === 'studyc' && finalStudyReady.data.release === report.studyReleaseId);
} catch (error) {
  failure = interrupted ? 'operator_interrupted' : error instanceof AcceptanceFailure ? error.test : 'unexpected_runtime_error';
} finally {
  clearTimeout(overallTimer);
  report.cleanupStatus = 'running';
  // If cleanup cannot finish, preserve exact synthetic identities for the existing
  // deletion workflow; never expand recovery to other users or arbitrary names.
  const cleanupDeadline = setTimeout(async () => {
    report.success = false; report.failure = 'cleanup-deadline-exceeded'; report.cleanupStatus = 'unverified';
    try { await saveReport(); } catch {}
    process.exit(1);
  }, 45_000);
  try { await saveReport(); } catch { failure ??= 'private-report-write-failed'; }
  if (db && requestAccountDeletion) {
    for (const fixture of report.fixtures) {
      try {
        if (!fixture.userId) {
          const [created] = await db.query('SELECT id FROM users WHERE dev_name = $1', [fixture.name]);
          if (!created) { report.cleanup.push({ userId: null, passed: true, created: false }); continue; }
          fixture.userId = created.id;
        }
        const job = await requestAccountDeletion(db, fixture.userId, async q => {
          const [owned] = await q.query('SELECT dev_name FROM users WHERE id = $1', [fixture.userId]);
          if (owned?.dev_name !== fixture.name || !fixture.name.startsWith(`${report.fixtureRunPrefix}-`)) throw new AcceptanceFailure('fixture-cleanup-ownership-guard');
        });
        const [remaining] = await db.query(`SELECT
          (SELECT count(*)::int FROM users WHERE id=$1) AS users,
          (SELECT count(*)::int FROM study_sets WHERE user_id=$1) AS study_sets,
          (SELECT count(*)::int FROM study_materials WHERE user_id=$1) AS study_materials`, [fixture.userId]);
        const passed = job.status === 'completed' && remaining.users === 0 && remaining.study_sets === 0 && remaining.study_materials === 0;
        report.cleanup.push({ userId: fixture.userId, passed });
        if (!passed) failure ??= 'fixture-cleanup-incomplete';
      } catch { report.cleanup.push({ userId: fixture.userId, passed: false }); failure ??= 'fixture-cleanup-failed'; }
    }
    try { report.countsAfter = await counts(); } catch { failure ??= 'aggregate-count-read-failed'; }
    try {
      let closeTimer;
      try { await Promise.race([db.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('close-timeout')), 3000); })]); }
      finally { clearTimeout(closeTimer); }
    } catch { failure ??= 'database-close-failed'; }
  }
  if (report.planPlanMainPidBefore) {
    try {
      report.planPlanMainPidAfter = await planPlanMainPid();
      const unchanged = report.planPlanMainPidAfter === report.planPlanMainPidBefore
        && await realpath('/opt/planplan-web/current') === options['--identity-release'];
      report.assertions.push({ name: 'planplan-process-and-release-unchanged', passed: unchanged });
      if (!unchanged) failure ??= 'planplan-process-or-release-changed';
    } catch { failure ??= 'planplan-process-verification-failed'; }
  }
  report.completedAt = new Date().toISOString();
  report.success = !failure && report.fixtures.length === 2 && report.cleanup.length === 2 && report.cleanup.every(item => item.passed);
  report.cleanupStatus = report.cleanup.length === report.fixtures.length && report.cleanup.every(item => item.passed) ? 'verified' : 'unverified';
  if (!report.success) report.failure = failure ?? 'incomplete-fixture-run';
  try { await saveReport(); } catch { report.success = false; report.failure = 'private-report-write-failed'; }
  process.stdout.write(`${JSON.stringify({ success: report.success, assertionCount: report.assertions.length,
    passedAssertions: report.assertions.filter(item => item.passed).length,
    cleanedAccounts: report.cleanup.filter(item => item.passed).length,
    restartVerified: report.restartVerified === true,
    planPlanProcessUnchanged: report.planPlanMainPidBefore > 0 && report.planPlanMainPidBefore === report.planPlanMainPidAfter,
    ...(report.success ? {} : { failure: report.failure }), report: reportPath ?? null })}\n`);
  if (!report.success) process.exitCode = 1;
  clearTimeout(cleanupDeadline);
  setTimeout(() => process.exit(report.success ? 0 : 1), 3000).unref();
}
