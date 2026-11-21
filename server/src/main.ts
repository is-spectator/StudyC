import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { openDb } from './db/db.js';
import { checkMigrations, migrate } from './db/migrations.js';
import { runtimeConfig } from './runtime/config.js';
import { FILE_ORPHAN_GRACE_MS, reconcileStoredFiles, resolveFileRoot } from './services/study-files.js';

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (!['serve', 'check', 'migrate'].includes(command) || process.argv.length > 3) throw new Error('Invalid command');
  const config = runtimeConfig();
  const fileRoot = resolveFileRoot(process.env.STUDYC_FILE_ROOT ?? '');
  const db = await openDb(config.databaseUrl, { ssl: config.ssl, migrations: 'none',
    onPoolError: () => console.error(JSON.stringify({ event: 'database_connection_failed' })) });
  try {
    if (command === 'migrate') await migrate(db);
    await checkMigrations(db);
    if (command !== 'serve') {
      await db.close();
      console.log(JSON.stringify({ ok: true, command, service: 'studyc', release: config.releaseId }));
      return;
    }
    const app = createApp(db, { releaseId: config.releaseId, rateLimitSecret: config.rateLimitSecret, fileRoot });
    let sweeping = false;
    const sweep = () => {
      if (sweeping) return;
      sweeping = true;
      void reconcileStoredFiles(db, fileRoot, FILE_ORPHAN_GRACE_MS).catch(() => {
        console.error(JSON.stringify({ event: 'file_reconcile_failed', service: 'studyc' }));
      }).finally(() => { sweeping = false; });
    };
    sweep();
    const sweepTimer = setInterval(sweep, 60_000);
    sweepTimer.unref();
    const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, () => {
      console.log(JSON.stringify({ event: 'server_started', service: 'studyc', release: config.releaseId }));
    });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      clearInterval(sweepTimer);
      const timeout = setTimeout(() => process.exit(1), 25000).unref();
      server.close(() => { void db.close().finally(() => { clearTimeout(timeout); process.exit(0); }); });
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
