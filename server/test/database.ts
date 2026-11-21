import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { openDb, type Db } from '../src/db/db.js';
import { migrate, SHARED_ACTIVE_USER_BODY } from '../src/db/migrations.js';

/** Synthetic identity contract only: no PlanPlan business tables or registration implementation. */
export async function sharedIdentity(db: Db): Promise<void> {
  await db.exec(`CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE request_rate_limits (
    key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
    hits timestamptz[] NOT NULL, expires_at timestamptz NOT NULL
  );
  CREATE INDEX request_rate_limits_expiry ON request_rate_limits(expires_at);
  CREATE FUNCTION planplan_active_user_write() RETURNS trigger AS $$${SHARED_ACTIVE_USER_BODY}$$ LANGUAGE plpgsql;`);
}

export async function openTestDb(options: { migrate?: boolean } = {}): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  let db: Db;
  let cleanup = async () => {};
  if (url) {
    const target = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(target.protocol)
      || !/^[A-Za-z0-9_]+_test$/.test(decodeURIComponent(target.pathname.slice(1)))
      || [...target.searchParams.keys()].some(key => /^ssl/i.test(key))) {
      throw new Error('TEST_DATABASE_URL must target a dedicated *_test database without SSL overrides');
    }
    const caFile = process.env.PG_CA_FILE;
    if (!caFile || !isAbsolute(caFile)) throw new Error('PostgreSQL tests require an absolute PG_CA_FILE');
    const ssl = { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true as const };
    const schema = `studyc_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: url, ssl });
    await admin.connect();
    try { await admin.query(`CREATE SCHEMA ${schema}`); } finally { await admin.end(); }
    cleanup = async () => {
      const client = new pg.Client({ connectionString: url, ssl });
      await client.connect();
      try { await client.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await client.end(); }
    };
    try { db = await openDb(url, { schema, ssl, migrations: 'none' }); } catch (error) { await cleanup(); throw error; }
  } else db = await openDb('pglite://memory', { migrations: 'none' });
  const close = db.close.bind(db);
  let closed = false;
  db.close = async () => {
    if (closed) return;
    closed = true;
    try { await close(); } finally { await cleanup(); }
  };
  try {
    await sharedIdentity(db);
    if (options.migrate !== false) await migrate(db);
    return db;
  } catch (error) { await db.close(); throw error; }
}
