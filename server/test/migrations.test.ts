import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db/db.js';
import { checkMigrations, migrate } from '../src/db/migrations.js';
import { STUDY_SCHEMA_SQL } from '../src/db/study-schema.js';
import { createStudySet, createTextMaterial } from '../src/services/study-data.js';
import { openTestDb } from './database.js';

describe('independent StudyC migration registry', () => {
  it('creates only StudyC objects on an existing identity schema and repeats without drift', async () => {
    const db = await openTestDb({ migrate: false });
    try {
      const before = await db.query('SELECT id,deleted_at,created_at FROM users');
      await migrate(db); await migrate(db); await checkMigrations(db);
      expect(await db.query('SELECT version,name,adopted FROM studyc_schema_migrations ORDER BY version')).toEqual([
        { version: 1, name: 'studyc_sets_and_text_materials', adopted: false },
        { version: 2, name: 'studyc_source_files', adopted: false },
      ]);
      expect(await db.query('SELECT id,deleted_at,created_at FROM users')).toEqual(before);
      expect(await db.query("SELECT to_regclass('schema_migrations') AS registry")).toEqual([{ registry: null }]);
      expect(await db.query("SELECT tablename FROM pg_tables WHERE schemaname LIKE 'pg_temp_%' AND tablename LIKE 'studyc_expected_%'")).toEqual([]);
    } finally { await db.close(); }
  });

  it('strictly adopts legacy18 tables and existing text without editing external migration history', async () => {
    const db = await openTestDb({ migrate: false });
    try {
      await db.exec(STUDY_SCHEMA_SQL);
      await db.exec("CREATE TABLE schema_migrations(version integer PRIMARY KEY,name text,checksum text); INSERT INTO schema_migrations SELECT n,'external-'||n,repeat('a',64) FROM generate_series(1,18)n;");
      const [u] = await db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      const set = (await createStudySet(db, u!.id, { clientRequestId: randomUUID(), title: '保留原资料' })).studySet;
      await createTextMaterial(db, u!.id, set.id, { clientRequestId: randomUUID(), title: 'legacy笔记', body: '跨服务保留\n😀' });
      const history = await db.query('SELECT * FROM schema_migrations ORDER BY version');
      const notes = await db.query('SELECT * FROM study_materials');
      await migrate(db); await migrate(db); await checkMigrations(db);
      expect(await db.query('SELECT * FROM schema_migrations ORDER BY version')).toEqual(history);
      expect(await db.query('SELECT * FROM study_materials')).toEqual(notes);
      expect(await db.query('SELECT version, adopted FROM studyc_schema_migrations ORDER BY version')).toEqual([
        { version: 1, adopted: true }, { version: 2, adopted: false },
      ]);
    } finally { await db.close(); }
  });

  it.each([
    ['column type', 'ALTER TABLE study_sets ALTER COLUMN title TYPE varchar(60)'],
    ['body check', 'ALTER TABLE study_materials DROP CONSTRAINT study_materials_body_check'],
    ['owner FK', 'ALTER TABLE study_materials DROP CONSTRAINT study_materials_study_set_id_user_id_fkey'],
    ['active account trigger', 'DROP TRIGGER active_user_write ON study_materials'],
    ['trigger disabled', 'ALTER TABLE study_sets DISABLE TRIGGER active_user_write'],
    ['pagination index', 'DROP INDEX study_materials_owner_set_created'],
    ['idempotency uniqueness', 'ALTER TABLE study_sets DROP CONSTRAINT study_sets_user_id_client_request_id_key'],
  ])('refuses legacy schema drift: %s', async (_name, sql) => {
    const db = await openTestDb({ migrate: false });
    try {
      await db.exec(STUDY_SCHEMA_SQL); await db.exec(sql);
      await expect(migrate(db)).rejects.toThrow(/exactly match/);
      expect(await db.query("SELECT to_regclass('studyc_schema_migrations') AS registry")).toEqual([{ registry: null }]);
      expect(await db.query("SELECT to_regclass('study_sets') IS NOT NULL AS present")).toEqual([{ present: true }]);
    } finally { await db.close(); }
  });

  it('PGlite only: refuses an empty database without the external identity schema', async () => {
    const empty = await openDb('pglite://memory', { migrations: 'none' });
    try { await expect(migrate(empty)).rejects.toThrow(/identity/); } finally { await empty.close(); }
  });

  it('fails closed for partial tables, altered lifecycle function and registry checksum', async () => {
    const partial = await openTestDb({ migrate: false });
    try {
      await partial.exec(STUDY_SCHEMA_SQL); await partial.exec('DROP TABLE study_materials');
      await expect(migrate(partial)).rejects.toThrow(/Partial/);
    } finally { await partial.close(); }
    const db = await openTestDb();
    try {
      await db.exec("CREATE OR REPLACE FUNCTION planplan_active_user_write() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;");
      await expect(checkMigrations(db)).rejects.toThrow(/deletion trigger/);
    } finally { await db.close(); }
    const changed = await openTestDb();
    try {
      await changed.query("UPDATE studyc_schema_migrations SET checksum=repeat('b',64)");
      await expect(checkMigrations(changed)).rejects.toThrow(/history mismatch/);
    } finally { await changed.close(); }
  });

  it('runtime check is read-only and detects constraint removal after adoption', async () => {
    const db = await openTestDb();
    try {
      const readonly = { ...db, query: db.query.bind(db), exec: async () => { throw new Error('Unexpected write'); },
        tx: async () => { throw new Error('Unexpected transaction'); }, close: db.close.bind(db) };
      await checkMigrations(readonly);
      await db.exec('ALTER TABLE study_materials DROP CONSTRAINT study_materials_body_check');
      await expect(checkMigrations(readonly)).rejects.toThrow(/schema drift/);
    } finally { await db.close(); }
  });
});
