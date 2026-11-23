import { createHash } from 'node:crypto';
import type { Db, Queryable, Transaction } from './db.js';
import { STUDY_FILES_SQL } from './study-files-schema.js';
import { STUDY_SCHEMA_SQL } from './study-schema.js';
import { GENERATION_IMMUTABLE_BODY, GENERATION_SCHEMA_SQL } from './generation-schema.js';

const name = 'studyc_sets_and_text_materials';
const checksum = createHash('sha256').update(`${name}\n${STUDY_SCHEMA_SQL}`).digest('hex');
const fileName = 'studyc_source_files';
const fileChecksum = createHash('sha256').update(`${fileName}\n${STUDY_FILES_SQL}`).digest('hex');
const generationName = 'studyc_generation_tasks';
const generationChecksum = createHash('sha256').update(`${generationName}\n${GENERATION_SCHEMA_SQL}`).digest('hex');
const registrySql = `CREATE TABLE IF NOT EXISTS studyc_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  schema_fingerprint text NOT NULL CHECK (schema_fingerprint ~ '^[0-9a-f]{64}$'),
  adopted boolean NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** Existing shared identity contract. This definition is validated, never installed by StudyC. */
export const SHARED_ACTIVE_USER_BODY = `
BEGIN
  PERFORM 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account no longer accepts writes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
`;

type MigrationRow = { version: number; name: string; checksum: string; schema_fingerprint: string; adopted: boolean };
type Column = { name: string; type: string; required: boolean; default: string | null; identity: string; generated: string };
const whitespace = (value: string) => value.trim().replace(/\s+/g, ' ');
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

async function exists(q: Queryable, table: string) {
  const [row] = await q.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
  return row!.present;
}

async function columns(q: Queryable, table: string): Promise<Column[]> {
  return q.query<Column>(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS default,
    a.attidentity AS identity, a.attgenerated AS generated
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [table]);
}

async function requireSharedIdentity(q: Queryable): Promise<void> {
  const userColumns = await columns(q, 'users');
  if (!userColumns.some(c => c.name === 'id' && c.type === 'uuid' && c.required)
    || !userColumns.some(c => c.name === 'deleted_at' && c.type === 'timestamp with time zone')) {
    throw new Error('Shared identity users schema is missing or incompatible; StudyC does not create accounts');
  }
  const rates = await columns(q, 'request_rate_limits');
  const types = rates.map(c => `${c.name}:${c.type}:${c.required}`).sort();
  if (stable(types) !== stable(['key_hash:text:true', 'hits:timestamp with time zone[]:true', 'expires_at:timestamp with time zone:true'].sort())) {
    throw new Error('Shared request limiter schema is missing or incompatible');
  }
  const [primary] = await q.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid,true) AS definition FROM pg_constraint
    WHERE conrelid=to_regclass('request_rate_limits') AND contype='p'`);
  if (primary?.definition !== 'PRIMARY KEY (key_hash)') throw new Error('Shared request limiter key constraint is incompatible');
  const [fn] = await q.query<{ body: string; security_definer: boolean; language: string; result: string }>(`SELECT p.prosrc AS body,
    p.prosecdef AS security_definer,l.lanname AS language,p.prorettype::regtype::text AS result
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('planplan_active_user_write()')`);
  if (!fn || fn.security_definer || fn.language !== 'plpgsql' || fn.result !== 'trigger'
    || whitespace(fn.body) !== whitespace(SHARED_ACTIVE_USER_BODY)) throw new Error('Shared account deletion trigger contract is incompatible');
}

async function tableShape(q: Queryable, table: string) {
  const [relation] = await q.query<{ kind: string; rls: boolean; force_rls: boolean }>(`SELECT relkind AS kind,
    relrowsecurity AS rls,relforcerowsecurity AS force_rls FROM pg_class WHERE oid=to_regclass($1)`, [table]);
  if (!relation || relation.kind !== 'r') throw new Error('StudyC requires ordinary tables');
  const constraints = await q.query(`SELECT contype,condeferrable,condeferred,convalidated,
    pg_get_constraintdef(oid,true) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1)`, [table]);
  const indexes = await q.query(`SELECT i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indnkeyatts,i.indnatts,
    i.indoption::text AS options, i.indcollation::text AS collations, am.amname AS method,
    pg_get_expr(i.indpred,i.indrelid,true) AS predicate,
    ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true) FROM generate_series(1,i.indnatts) AS key(k)) AS columns
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_am am ON am.oid=idx.relam
    WHERE i.indrelid=to_regclass($1)`, [table]);
  const triggers = await q.query(`SELECT t.tgtype,t.tgenabled,t.tgattr::text AS attributes,encode(t.tgargs,'hex') AS args,
    pg_get_expr(t.tgqual,t.tgrelid,true) AS predicate,p.proname AS function,n.nspname AS function_schema
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE t.tgrelid=to_regclass($1) AND NOT t.tgisinternal`, [table]);
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value)
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_sets/g, 'study_sets')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_materials/g, 'study_materials')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_users/g, 'users'));
  const sorted = (values: unknown[]) => values.map(normalize).sort((a, b) => stable(a).localeCompare(stable(b)));
  return { relation, columns: await columns(q, table), constraints: sorted(constraints), indexes: sorted(indexes), triggers: sorted(triggers) };
}

async function actualShape(q: Queryable) {
  return { sets: await tableShape(q, 'study_sets'), materials: await tableShape(q, 'study_materials') };
}

async function fileShape(q: Queryable) {
  return { files: await tableShape(q, 'study_source_files'), pages: await tableShape(q, 'study_source_pages') };
}

/** The migrator alone creates private temporary reference tables. Runtime checks are read-only. */
async function verifyExactSchema(q: Transaction): Promise<string> {
  const temporarySql = STUDY_SCHEMA_SQL
    .replace(/\bstudy_sets\b/g, 'studyc_expected_sets').replace(/\bstudy_materials\b/g, 'studyc_expected_materials')
    .replace(/\busers\(id\)/g, 'studyc_expected_users(id)')
    .replace(/CREATE TABLE/g, 'CREATE TEMP TABLE')
    .replace(/study_sets_owner_created/g, 'studyc_expected_sets_created').replace(/study_materials_owner_set_created/g, 'studyc_expected_materials_created');
  await q.query('CREATE TEMP TABLE studyc_expected_users (id uuid PRIMARY KEY)');
  await q.exec(temporarySql);
  const expected = { sets: await tableShape(q, 'studyc_expected_sets'), materials: await tableShape(q, 'studyc_expected_materials') };
  const actual = await actualShape(q);
  if (stable(actual) !== stable(expected)) throw new Error('Existing StudyC tables do not exactly match the approved schema; refusing adoption');
  await q.exec('DROP TABLE studyc_expected_materials; DROP TABLE studyc_expected_sets; DROP TABLE studyc_expected_users;');
  return hash(actual);
}

async function readHistory(q: Queryable): Promise<MigrationRow[]> {
  return q.query<MigrationRow>('SELECT version,name,checksum,schema_fingerprint,adopted FROM studyc_schema_migrations ORDER BY version');
}

function requireVersion(row: MigrationRow | undefined, version: number, migrationName: string, migrationChecksum: string): MigrationRow {
  if (!row || row.version !== version || row.name !== migrationName || row.checksum !== migrationChecksum
    || !/^[0-9a-f]{64}$/.test(row.schema_fingerprint)) throw new Error('StudyC migration history mismatch');
  return row;
}

async function verifyFileSchema(q: Transaction): Promise<string> {
  // Temporary tables cannot reference permanent tables, so the reference copy gets temporary parents.
  await q.exec(`CREATE TEMP TABLE studyc_expected_users (id uuid PRIMARY KEY);
    CREATE TEMP TABLE studyc_expected_sets (id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY (id), UNIQUE (id, user_id));
    CREATE TEMP TABLE studyc_expected_materials (id uuid PRIMARY KEY);`);
  const temporarySql = STUDY_FILES_SQL
    .replace(/\bstudy_source_files\b/g, 'studyc_expected_files').replace(/\bstudy_source_pages\b/g, 'studyc_expected_pages')
    .replace(/\busers\(id\)/g, 'studyc_expected_users(id)')
    .replace(/\bstudy_sets\(id, user_id\)/g, 'studyc_expected_sets(id, user_id)')
    .replace(/\bstudy_materials\(id\)/g, 'studyc_expected_materials(id)')
    .replace(/CREATE TABLE/g, 'CREATE TEMP TABLE')
    .replace('study_source_files_owner_set_created', 'studyc_expected_files_created');
  await q.exec(temporarySql);
  const expected = { files: await tableShape(q, 'studyc_expected_files'), pages: await tableShape(q, 'studyc_expected_pages') };
  const actual = await fileShape(q);
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value)
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_files/g, 'study_source_files')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_pages/g, 'study_source_pages')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_users/g, 'users')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_sets/g, 'study_sets')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_materials/g, 'study_materials'));
  if (stable(normalize(actual)) !== stable(normalize(expected))) throw new Error('Existing StudyC file tables do not exactly match the approved schema; refusing adoption');
  await q.exec('DROP TABLE studyc_expected_pages; DROP TABLE studyc_expected_files; DROP TABLE studyc_expected_materials; DROP TABLE studyc_expected_sets; DROP TABLE studyc_expected_users;');
  return hash(actual);
}

async function generationShape(q: Queryable) {
  const [fn] = await q.query<{ body: string; security_definer: boolean; language: string; result: string }>(`SELECT p.prosrc AS body,
    p.prosecdef AS security_definer,l.lanname AS language,p.prorettype::regtype::text AS result
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('studyc_generation_immutable()')`);
  if (!fn || fn.security_definer || fn.language !== 'plpgsql' || fn.result !== 'trigger'
    || whitespace(fn.body) !== whitespace(GENERATION_IMMUTABLE_BODY)) throw new Error('StudyC generation immutable function drift');
  return { jobs: await tableShape(q, 'study_generation_jobs'), attempts: await tableShape(q, 'study_generation_attempts'),
    budget: await tableShape(q, 'study_generation_daily_budget'), immutable: { ...fn, body: whitespace(fn.body) } };
}

async function verifyGenerationSchema(q: Transaction): Promise<string> {
  await q.exec(`CREATE TEMP TABLE studyc_expected_users (id uuid PRIMARY KEY);
    CREATE TEMP TABLE studyc_expected_sets (id uuid NOT NULL,user_id uuid NOT NULL,PRIMARY KEY(id),UNIQUE(id,user_id));`);
  const temporary = GENERATION_SCHEMA_SQL.slice(GENERATION_SCHEMA_SQL.indexOf('CREATE TABLE study_generation_jobs'))
    .replace(/\bstudy_generation_jobs\b/g, 'studyc_expected_generation_jobs')
    .replace(/\bstudy_generation_attempts\b/g, 'studyc_expected_generation_attempts')
    .replace(/\bstudy_generation_daily_budget\b/g, 'studyc_expected_generation_budget')
    .replace(/\busers\(id\)/g, 'studyc_expected_users(id)')
    .replace(/\bstudy_sets\(id,user_id\)/g, 'studyc_expected_sets(id,user_id)')
    .replace(/CREATE TABLE/g, 'CREATE TEMP TABLE')
    .replace(/study_generation_jobs_owner_set_created/g, 'studyc_expected_generation_created')
    .replace(/study_generation_attempts_queue/g, 'studyc_expected_generation_queue')
    .replace(/study_generation_attempts_budget/g, 'studyc_expected_generation_usage');
  await q.exec(temporary);
  const actual = await generationShape(q);
  const expected = { jobs: await tableShape(q, 'studyc_expected_generation_jobs'), attempts: await tableShape(q, 'studyc_expected_generation_attempts'),
    budget: await tableShape(q, 'studyc_expected_generation_budget'), immutable: actual.immutable };
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value)
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_generation_jobs/g, 'study_generation_jobs')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_generation_attempts/g, 'study_generation_attempts')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_generation_budget/g, 'study_generation_daily_budget')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_users/g, 'users')
    .replace(/(?:pg_temp_\d+\.)?studyc_expected_sets/g, 'study_sets'));
  if (stable(normalize(actual)) !== stable(normalize(expected))) throw new Error('Existing StudyC generation tables do not exactly match the approved schema');
  await q.exec('DROP TABLE studyc_expected_generation_attempts; DROP TABLE studyc_expected_generation_jobs; DROP TABLE studyc_expected_generation_budget; DROP TABLE studyc_expected_sets; DROP TABLE studyc_expected_users;');
  return hash(actual);
}

/** Never executes or edits PlanPlan schema_migrations, including its legacy migration 18. */
export async function migrate(db: Db): Promise<void> {
  await db.tx(async q => {
    await requireSharedIdentity(q);
    await q.exec(registrySql);
    let history = await readHistory(q);
    if (!history.length) {
      const hasSets = await exists(q, 'study_sets');
      const hasMaterials = await exists(q, 'study_materials');
      if (hasSets !== hasMaterials) throw new Error('Partial StudyC schema; refusing to overwrite or repair it automatically');
      if (!hasSets) await q.exec(STUDY_SCHEMA_SQL);
      const fingerprint = await verifyExactSchema(q);
      await q.query('INSERT INTO studyc_schema_migrations(version,name,checksum,schema_fingerprint,adopted) VALUES(1,$1,$2,$3,$4)',
        [name, checksum, fingerprint, hasSets]);
      history = await readHistory(q);
    }
    const saved = requireVersion(history[0], 1, name, checksum);
    if (hash(await actualShape(q)) !== saved.schema_fingerprint) throw new Error('StudyC schema drift detected');
    if (history.length === 1) {
      const hasFiles = await exists(q, 'study_source_files');
      const hasPages = await exists(q, 'study_source_pages');
      if (hasFiles !== hasPages) throw new Error('Partial StudyC file schema; refusing to overwrite or repair it automatically');
      if (!hasFiles) await q.exec(STUDY_FILES_SQL);
      const fingerprint = await verifyFileSchema(q);
      await q.query('INSERT INTO studyc_schema_migrations(version,name,checksum,schema_fingerprint,adopted) VALUES(2,$1,$2,$3,$4)',
        [fileName, fileChecksum, fingerprint, hasFiles]);
      history = await readHistory(q);
    }
    const files = requireVersion(history[1], 2, fileName, fileChecksum);
    if (hash(await fileShape(q)) !== files.schema_fingerprint) throw new Error('StudyC migration history mismatch');
    if (history.length === 2) {
      const present: boolean[] = [];
      for (const table of ['study_generation_jobs','study_generation_attempts','study_generation_daily_budget']) present.push(await exists(q, table));
      if (present.some(Boolean) && !present.every(Boolean)) throw new Error('Partial StudyC generation schema');
      if (!present[0]) await q.exec(GENERATION_SCHEMA_SQL);
      const fingerprint = await verifyGenerationSchema(q);
      await q.query('INSERT INTO studyc_schema_migrations(version,name,checksum,schema_fingerprint,adopted) VALUES(3,$1,$2,$3,$4)',
        [generationName, generationChecksum, fingerprint, present[0]]);
      return;
    }
    const generations = requireVersion(history[2], 3, generationName, generationChecksum);
    if (history.length !== 3 || hash(await generationShape(q)) !== generations.schema_fingerprint) throw new Error('StudyC generation schema drift detected');
  }, 'studyc:schema-migrations');
}

export async function checkMigrations(db: Db): Promise<void> {
  await requireSharedIdentity(db);
  if (!await exists(db, 'studyc_schema_migrations')) throw new Error('StudyC migrations have not been applied');
  const history = await readHistory(db);
  const saved = requireVersion(history[0], 1, name, checksum);
  const files = requireVersion(history[1], 2, fileName, fileChecksum);
  const generations = requireVersion(history[2], 3, generationName, generationChecksum);
  if (history.length !== 3) throw new Error('StudyC migration history mismatch');
  if (hash(await actualShape(db)) !== saved.schema_fingerprint || hash(await fileShape(db)) !== files.schema_fingerprint
    || hash(await generationShape(db)) !== generations.schema_fingerprint) {
    throw new Error('StudyC schema drift detected');
  }
}
