import {requireVisibleSet} from './set-visibility.js';
import { createHash } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import { requireActiveUser } from './identity.js';
import { DomainError } from './errors.js';

export interface StudySet {
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialSummary extends StudySet {
  studySetId: string;
  format: 'plain_text';
}

export interface TextMaterial extends MaterialSummary { body: string }
export interface StudyPageOptions { limit: number; cursor?: string }
export interface StudyPage<T> { items: T[]; nextCursor: string | null }
export interface CreateStudySetInput { clientRequestId: string; title: string }
export interface UpdateStudySetInput { version: number; title: string }
export interface CreateTextMaterialInput extends CreateStudySetInput { body: string }
export interface UpdateTextMaterialInput { version: number; title?: string; body?: string }

/** StudyC-only errors must not extend the existing AI/chat card error protocol. */
export class StudyError extends Error {
  readonly details = {};
  constructor(readonly code: 'idempotency_conflict' | 'payload_too_large', message: string) { super(message); }
}

/** These are route-input errors, without changing PlanPlan's existing DomainError status mapping. */
export class StudyInputError extends Error {
  readonly code = 'invalid_input';
  constructor(message = '分页参数无效，请重新加载列表。') { super(message); }
}

interface SetRow {
  id: string;
  title: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  cursor_time: string;
}
interface MaterialRow extends SetRow { study_set_id: string; format: 'plain_text' }
interface TextRow extends MaterialRow { body: string }
interface Cursor { v: 1; userId: string; scope: string; createdAt: string; id: string }

// Database timestamps retain microseconds here; JS Date serialization alone would lose rows at page boundaries.
const timeColumns = `created_at, updated_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;
const setColumns = `id, title, version, ${timeColumns}`;
const materialColumns = `id, study_set_id, title, format, version, ${timeColumns}`;
const textColumns = `${materialColumns}, body`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utcMicros = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const digest = (input: readonly string[]) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const missing = () => new DomainError('not_found', '没有找到该学习资料。');
const conflict = () => new DomainError('version_conflict', '内容已在另一处修改，请重新读取后再保存。');

const studySet = (row: SetRow): StudySet => ({
  id: row.id, title: row.title, version: row.version,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
});
const summary = (row: MaterialRow): MaterialSummary => ({ ...studySet(row), studySetId: row.study_set_id, format: row.format });
const material = (row: TextRow): TextMaterial => ({ ...summary(row), body: row.body });

function parseCursor(value: string | undefined, userId: string, scope: string): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new StudyInputError();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new StudyInputError();
    const cursor: unknown = JSON.parse(bytes.toString('utf8'));
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new StudyInputError();
    const c = cursor as Record<string, unknown>;
    if (Object.keys(c).length !== 5 || c.v !== 1 || c.userId !== userId || c.scope !== scope
      || typeof c.id !== 'string' || !uuid.test(c.id)
      || typeof c.createdAt !== 'string' || !utcMicros.test(c.createdAt) || c.createdAt.startsWith('0000')) throw new StudyInputError();
    const timestamp = new Date(c.createdAt);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== `${c.createdAt.slice(0, 23)}Z`) throw new StudyInputError();
    return c as unknown as Cursor;
  } catch {
    throw new StudyInputError();
  }
}

function page<T, R extends SetRow>(rows: R[], limit: number, userId: string, scope: string, map: (row: R) => T): StudyPage<T> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({ v: 1, userId, scope, createdAt: last.cursor_time, id: last.id } satisfies Cursor)).toString('base64url')
    : null;
  return { items: visible.map(map), nextCursor };
}

function pageOptions(options: StudyPageOptions, userId: string, scope: string) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new StudyInputError();
  return parseCursor(options.cursor, userId, scope);
}

async function requireStudySet(q: Queryable, userId: string, setId: string): Promise<void> { await requireVisibleSet(q,userId,setId); }

export async function createStudySet(db: Db, userId: string, input: CreateStudySetInput): Promise<{ studySet: StudySet; replayed: boolean }> {
  const title = input.title.trim();
  const requestId = input.clientRequestId.toLowerCase();
  const hash = digest([title]);
  return db.tx(async q => {
    await requireActiveUser(q, userId);
    const [created] = await q.query<SetRow>(`INSERT INTO study_sets (user_id, title, client_request_id, creation_digest)
      VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, client_request_id) DO NOTHING RETURNING ${setColumns}`,
    [userId, title, requestId, hash]);
    if (created) return { studySet: studySet(created), replayed: false };
    const [existing] = await q.query<SetRow & { creation_digest: string }>(`SELECT ${setColumns}, creation_digest
      FROM study_sets WHERE user_id = $1 AND client_request_id = $2`, [userId, requestId]);
    if (!existing || existing.creation_digest !== hash) throw new StudyError('idempotency_conflict', '同一次创建请求的内容已变化，请重新发起创建。');
    await requireStudySet(q,userId,existing.id);
    return { studySet: studySet(existing), replayed: true };
  }, userId);
}

export async function listStudySets(db: Db, userId: string, options: StudyPageOptions): Promise<StudyPage<StudySet>> {
  const cursor = pageOptions(options, userId, 'sets');
  const rows = await db.query<SetRow>(`SELECT ${setColumns} FROM study_sets WHERE user_id = $1 AND NOT EXISTS(SELECT 1 FROM study_set_lifecycle l WHERE l.study_set_id=study_sets.id AND l.user_id=$1 AND l.deleted_at IS NOT NULL)
    ${cursor ? 'AND (created_at, id) < ($3::timestamptz, $4::uuid)' : ''}
    ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, options.limit + 1, ...(cursor ? [cursor.createdAt, cursor.id] : [])]);
  return page(rows, options.limit, userId, 'sets', studySet);
}

export async function getStudySet(db: Db, userId: string, setId: string): Promise<StudySet> {
  const [row] = await db.query<SetRow>(`SELECT ${setColumns} FROM study_sets WHERE user_id = $1 AND id = $2 AND NOT EXISTS(SELECT 1 FROM study_set_lifecycle l WHERE l.study_set_id=study_sets.id AND l.user_id=$1 AND l.deleted_at IS NOT NULL)`, [userId, setId]);
  if (!row) throw missing();
  return studySet(row);
}

export async function updateStudySet(db: Db, userId: string, setId: string, input: UpdateStudySetInput): Promise<StudySet> {
  return db.tx(async q => {
    await requireStudySet(q,userId,setId);
    const [updated] = await q.query<SetRow>(`UPDATE study_sets SET title = $3, version = version + 1, updated_at = clock_timestamp()
      WHERE user_id = $1 AND id = $2 AND version = $4 RETURNING ${setColumns}`, [userId, setId, input.title.trim(), input.version]);
    if (updated) return studySet(updated);
    await requireStudySet(q, userId, setId);
    throw conflict();
  }, userId);
}

export async function createTextMaterial(db: Db, userId: string, setId: string, input: CreateTextMaterialInput): Promise<{ material: TextMaterial; replayed: boolean }> {
  const title = input.title.trim();
  const requestId = input.clientRequestId.toLowerCase();
  const hash = digest([setId.toLowerCase(), title, input.body]);
  return db.tx(async q => {
    await requireActiveUser(q, userId);
    await requireStudySet(q, userId, setId);
    const [created] = await q.query<TextRow>(`INSERT INTO study_materials (user_id, study_set_id, title, body, client_request_id, creation_digest)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, client_request_id) DO NOTHING RETURNING ${textColumns}`,
    [userId, setId, title, input.body, requestId, hash]);
    if (created) return { material: material(created), replayed: false };
    const [existing] = await q.query<TextRow & { creation_digest: string }>(`SELECT ${textColumns}, creation_digest
      FROM study_materials WHERE user_id = $1 AND client_request_id = $2`, [userId, requestId]);
    if (!existing || existing.creation_digest !== hash) throw new StudyError('idempotency_conflict', '同一次创建请求的内容已变化，请重新发起创建。');
    return { material: material(existing), replayed: true };
  }, userId);
}

export async function listTextMaterials(db: Db, userId: string, setId: string, options: StudyPageOptions): Promise<StudyPage<MaterialSummary>> {
  const scope = `materials:${setId.toLowerCase()}`;
  const cursor = pageOptions(options, userId, scope);
  await requireStudySet(db, userId, setId);
  const rows = await db.query<MaterialRow>(`SELECT ${materialColumns} FROM study_materials WHERE user_id = $1 AND study_set_id = $2 AND NOT EXISTS(SELECT 1 FROM study_set_lifecycle l WHERE l.user_id=$1 AND l.study_set_id=$2 AND l.deleted_at IS NOT NULL)
    ${cursor ? 'AND (created_at, id) < ($4::timestamptz, $5::uuid)' : ''}
    ORDER BY created_at DESC, id DESC LIMIT $3`, [userId, setId, options.limit + 1, ...(cursor ? [cursor.createdAt, cursor.id] : [])]);
  return page(rows, options.limit, userId, scope, summary);
}

export async function getTextMaterial(db: Db, userId: string, setId: string, materialId: string): Promise<TextMaterial> {
  await requireStudySet(db, userId, setId);
  const [row] = await db.query<TextRow>(`SELECT ${textColumns} FROM study_materials
    WHERE user_id = $1 AND study_set_id = $2 AND id = $3 AND NOT EXISTS(SELECT 1 FROM study_set_lifecycle l WHERE l.user_id=$1 AND l.study_set_id=$2 AND l.deleted_at IS NOT NULL)`, [userId, setId, materialId]);
  if (!row) throw missing();
  return material(row);
}

export async function updateTextMaterial(db: Db, userId: string, setId: string, materialId: string, input: UpdateTextMaterialInput): Promise<TextMaterial> {
  return db.tx(async q => {
    await requireActiveUser(q, userId);
    await requireStudySet(q, userId, setId);
    const [updated] = await q.query<TextRow>(`UPDATE study_materials SET
      title = COALESCE($4::text, title), body = COALESCE($5::text, body), version = version + 1, updated_at = clock_timestamp()
      WHERE user_id = $1 AND study_set_id = $2 AND id = $3 AND version = $6 RETURNING ${textColumns}`,
    [userId, setId, materialId, input.title === undefined ? null : input.title.trim(), input.body ?? null, input.version]);
    if (updated) return material(updated);
    const [existing] = await q.query('SELECT id FROM study_materials WHERE user_id = $1 AND study_set_id = $2 AND id = $3', [userId, setId, materialId]);
    if (!existing) throw missing();
    throw conflict();
  }, userId);
}
