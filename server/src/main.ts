import { backfillMistakes } from './services/mistakes.js';
import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { openDb } from './db/db.js';
import { checkMigrations, migrate } from './db/migrations.js';
import { runtimeConfig } from './runtime/config.js';
import { FILE_ORPHAN_GRACE_MS, reconcileStoredFiles, resolveFileRoot } from './services/study-files.js';
import { GenerationStore } from './generation/store.js';
import { startGenerationWorker } from './generation/worker.js';
import { generationProviderFromEnv } from './runtime/generation-config.js';
import { generationPolicyFromEnv } from './runtime/generation-policy.js';

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (!['serve', 'check', 'migrate', 'backfill-mistakes'].includes(command) || process.argv.length > 3) throw new Error('Invalid command');
  const config = runtimeConfig();
  // Migrations need database-owner access, not access to the model credential.
  const provider = ['migrate','backfill-mistakes'].includes(command) ? null : generationProviderFromEnv();
  const generationPolicy = generationPolicyFromEnv();
  const fileRoot = resolveFileRoot(process.env.STUDYC_FILE_ROOT ?? '');
  const db = await openDb(config.databaseUrl, { ssl: config.ssl, migrations: 'none',
    onPoolError: () => console.error(JSON.stringify({ event: 'database_connection_failed' })) });
  try {
    if (command === 'migrate') await migrate(db);
    await checkMigrations(db);
    if (command === 'backfill-mistakes') { const result = await backfillMistakes(db); console.log(JSON.stringify({event:'mistakes_backfilled',...result})); }
    if (command !== 'serve') {
      await db.close();
      console.log(JSON.stringify({ ok: true, command, service: 'studyc', release: config.releaseId }));
      return;
    }
    const generationStore = new GenerationStore(db, generationPolicy, provider?.config ?? null);
    const app = createApp(db, { releaseId: config.releaseId, rateLimitSecret: config.rateLimitSecret, fileRoot, generationStore });
    let sweeping: Promise<void> | undefined;
    const sweep = () => {
      if (sweeping) return;
      sweeping = reconcileStoredFiles(db, fileRoot, FILE_ORPHAN_GRACE_MS).catch(() => {
        console.error(JSON.stringify({ event: 'file_reconcile_failed', service: 'studyc' }));
      }).then(() => undefined).finally(() => { sweeping = undefined; });
    };
    sweep();
    const sweepTimer = setInterval(sweep, 60_000);
    sweepTimer.unref();
    const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, () => {
      console.log(JSON.stringify({ event: 'server_started', service: 'studyc', release: config.releaseId }));
    });
    const worker = provider ? startGenerationWorker(generationStore, provider, {
      onError: () => console.error(JSON.stringify({ event: 'generation_worker_failed', service: 'studyc' })),
    }) : undefined;
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      clearInterval(sweepTimer);
      const timeout = setTimeout(() => process.exit(1), 25000).unref();
      const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
      void Promise.all([httpClosed, worker?.stop(), sweeping]).then(() => db.close()).then(() => {
        clearTimeout(timeout); process.exit(0);
      }).catch(() => {
        console.error(JSON.stringify({ event: 'shutdown_failed', service: 'studyc' }));
        clearTimeout(timeout); process.exit(1);
      });
    });
  } catch (error) { await db.close(); throw error; }
}

// Never emit exception messages from configuration, database drivers, or upstream requests.
for (const event of ['unhandledRejection', 'uncaughtException'] as const) process.on(event, () => {
  console.error(JSON.stringify({ event: 'process_failed', service: 'studyc' })); process.exit(1);
});
void main().catch(() => {
  console.error(JSON.stringify({ event: 'startup_failed', service: 'studyc' })); process.exitCode = 1;
});
