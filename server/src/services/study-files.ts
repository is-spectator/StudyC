import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { Db } from '../db/db.js';
import { DomainError } from './errors.js';
import { requireActiveUser } from './identity.js';
import { extractPdfText, PdfTimeoutError, type PdfFailureCode } from './pdf-text.js';
import { StudyError, StudyInputError } from './study-data.js';

export const PDF_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** Multipart boundaries, headers, and the request id. The file itself stays within PDF_FILE_MAX_BYTES. */
export const PDF_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** A crash between writing bytes and committing the row must not delete an in-flight upload. */
export const FILE_ORPHAN_GRACE_MS = 15 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class StudyFileError extends Error {
  readonly details = {};
  constructor(readonly code: PdfFailureCode | 'parse_timeout', message: string) { super(message); }
}

export const sourceFailureMessage: Record<PdfFailureCode, string> = {
  no_extractable_text: '这份 PDF 没有可提取的文字。扫描件暂不支持，这次没有保存正文。',
  encrypted_pdf: '这份 PDF 已加密或需要密码，无法提取文字。',
  invalid_pdf: '文件不是有效的 PDF，或内容已损坏。这次没有保存。',
  text_too_large: '提取出的文字超过 1 MiB，这次没有保存。',
  too_many_pages: 'PDF 超过 30 页，这次没有保存。',
};

export interface SourceFileRecord {
  id: string;
  studySetId: string;
  materialId: string | null;
  displayName: string;
  byteSize: number;
  status: 'ready' | PdfFailureCode;
  pageCount: number;
  pages: { page: number; start: number; end: number }[];
  createdAt: string;
  updatedAt: string;
}

interface FileRow {
  id: string;
  study_set_id: string;
  material_id: string | null;
  display_name: string;
  byte_size: number;
  status: SourceFileRecord['status'];
  page_count: number;
  content_sha256: string;
  creation_digest: string;
  created_at: Date;
  updated_at: Date;
}

export function assertPdf(bytes: Uint8Array): void {
  if (bytes.byteLength > PDF_FILE_MAX_BYTES) throw new StudyError('payload_too_large', 'PDF 不能超过 8 MiB，这次没有保存。');
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 1024))).toString('latin1').trimStart();
  if (bytes.byteLength < 5 || !head.startsWith('%PDF-')) throw new StudyInputError('请上传 PDF 文件。文件内容与扩展名不符，这次没有保存。');
}

export function displayNameOf(filename: string): string {
  const base = filename.split(/[/\\]/).at(-1) ?? '';
  const cleaned = Array.from(base).filter(char => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f && char !== '/' && char !== '\\';
  }).join('').trim().replace(/\s+/g, ' ');
  const limited = Array.from(cleaned).slice(0, 80).join('').trim();
  if (!limited || limited === '.' || limited === '..') return '未命名.pdf';
  return limited.toLowerCase().endsWith('.pdf') ? limited : `${Array.from(limited).slice(0, 76).join('').trim()}.pdf`;
}

function materialTitle(name: string): string {
  const stem = name.replace(/\.pdf$/i, '').trim();
  const title = Array.from(stem || 'PDF 文本').slice(0, 120).join('').trim();
  return title || 'PDF 文本';
}

function userDirectory(root: string, userId: string): string {
  if (!uuidPattern.test(userId)) throw new Error('Invalid storage key');
  const base = resolve(root);
  const path = resolve(base, userId);
  if (!path.startsWith(base + sep)) throw new Error('Invalid storage path');
  return path;
}

function storagePath(root: string, userId: string, fileId: string): string {
  if (!uuidPattern.test(fileId)) throw new Error('Invalid storage key');
  const path = resolve(userDirectory(root, userId), fileId);
  const base = resolve(root);
  if (!path.startsWith(base + sep)) throw new Error('Invalid storage path');
  return path;
}

async function writePrivate(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

export function resolveFileRoot(root: string): string {
  if (!root || !isAbsolute(root)) throw new Error('STUDYC_FILE_ROOT must be an absolute directory');
  return resolve(root);
}

const toRecord = (row: FileRow, pages: SourceFileRecord['pages']): SourceFileRecord => ({
  id: row.id, studySetId: row.study_set_id, materialId: row.material_id, displayName: row.display_name,
  byteSize: row.byte_size, status: row.status, pageCount: row.page_count, pages,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
});

async function pagesFor(db: Db, userId: string, fileId: string): Promise<SourceFileRecord['pages']> {
  const rows = await db.query<{ page_number: number; char_start: number; char_end: number }>(
    'SELECT page_number, char_start, char_end FROM study_source_pages WHERE user_id = $1 AND source_file_id = $2 ORDER BY page_number',
    [userId, fileId]);
  return rows.map(row => ({ page: row.page_number, start: row.char_start, end: row.char_end }));
}

export async function uploadPdf(db: Db, root: string, userId: string, setId: string, input: { clientRequestId: string; filename: string; bytes: Uint8Array }): Promise<{ file: SourceFileRecord; replayed: boolean }> {
  assertPdf(input.bytes);
  const archived = Buffer.from(input.bytes);
  const contentSha = createHash('sha256').update(archived).digest('hex');
  const digest = createHash('sha256').update(JSON.stringify([setId.toLowerCase(), contentSha])).digest('hex');
  const requestId = input.clientRequestId.toLowerCase();
  const existing = await db.tx(async q => {
    await requireActiveUser(q, userId);
    const [set] = await q.query('SELECT id FROM study_sets WHERE user_id = $1 AND id = $2', [userId, setId]);
    if (!set) throw new DomainError('not_found', '没有找到该学习资料。');
    const [row] = await q.query<FileRow>(`SELECT id, study_set_id, material_id, display_name, byte_size, status, page_count,
      content_sha256, creation_digest, created_at, updated_at FROM study_source_files WHERE user_id = $1 AND client_request_id = $2`, [userId, requestId]);
    return row;
  }, userId);
  if (existing) {
    if (existing.creation_digest !== digest || existing.study_set_id !== setId) {
      throw new StudyError('idempotency_conflict', '同一次上传请求的文件已变化，请重新选择文件。');
    }
    return { file: toRecord(existing, await pagesFor(db, userId, existing.id)), replayed: true };
  }
  let extracted: Awaited<ReturnType<typeof extractPdfText>>;
  try { extracted = await extractPdfText(Uint8Array.from(archived)); }
  catch (error) {
    if (error instanceof PdfTimeoutError) throw new StudyFileError('parse_timeout', 'PDF 解析超时，文件没有保存。请用同一次上传重试。');
    throw error;
  }
  const fileId = randomUUID();
  const displayName = displayNameOf(input.filename);
  const ready = extracted.ok;
  const path = storagePath(root, userId, fileId);
  let committed = false;
  if (ready) await writePrivate(path, archived);
  try {
    const saved = await db.tx(async q => {
      await requireActiveUser(q, userId);
      const [set] = await q.query('SELECT id FROM study_sets WHERE user_id = $1 AND id = $2', [userId, setId]);
      if (!set) throw new DomainError('not_found', '没有找到该学习资料。');
      let materialId: string | null = null;
      if (extracted.ok) {
        const [material] = await q.query<{ id: string }>(`INSERT INTO study_materials
          (user_id, study_set_id, title, body, client_request_id, creation_digest)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [userId, setId, materialTitle(displayName), extracted.value.body, randomUUID(),
          createHash('sha256').update(JSON.stringify([displayName, extracted.value.body])).digest('hex')]);
        materialId = material!.id;
      }
      const [row] = await q.query<FileRow>(`INSERT INTO study_source_files
        (id, user_id, study_set_id, material_id, client_request_id, creation_digest, content_sha256, display_name, byte_size, status, page_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (user_id, client_request_id) DO NOTHING
        RETURNING id, study_set_id, material_id, display_name, byte_size, status, page_count, content_sha256, creation_digest, created_at, updated_at`,
      [fileId, userId, setId, materialId, requestId, digest, contentSha, displayName, archived.byteLength,
        extracted.ok ? 'ready' : extracted.code, extracted.ok ? extracted.value.pageCount : 0]);
      if (row && extracted.ok) {
        for (const range of extracted.value.ranges) {
          await q.query(`INSERT INTO study_source_pages (source_file_id, user_id, page_number, char_start, char_end)
            VALUES ($1,$2,$3,$4,$5)`, [row.id, userId, range.page, range.start, range.end]);
        }
      }
      if (row) return row;
      if (materialId) await q.query('DELETE FROM study_materials WHERE user_id = $1 AND id = $2', [userId, materialId]);
      const [winner] = await q.query<FileRow>(`SELECT id, study_set_id, material_id, display_name, byte_size, status, page_count,
        content_sha256, creation_digest, created_at, updated_at FROM study_source_files WHERE user_id = $1 AND client_request_id = $2`, [userId, requestId]);
      if (!winner || winner.creation_digest !== digest) throw new StudyError('idempotency_conflict', '同一次上传请求的文件已变化，请重新选择文件。');
      return winner;
    }, userId);
    committed = true;
    if (saved.id !== fileId && ready) await rm(path, { force: true });
    const pages = saved.status === 'ready' ? await pagesFor(db, userId, saved.id) : [];
    return { file: toRecord(saved, pages), replayed: saved.id !== fileId };
  } catch (error) {
    if (ready && !committed) await rm(path, { force: true });
    throw error;
  }
}

export async function listSourceFiles(db: Db, userId: string, setId: string): Promise<SourceFileRecord[]> {
  const [set] = await db.query('SELECT id FROM study_sets WHERE user_id = $1 AND id = $2', [userId, setId]);
  if (!set) throw new DomainError('not_found', '没有找到该学习资料。');
  const rows = await db.query<FileRow>(`SELECT id, study_set_id, material_id, display_name, byte_size, status, page_count,
    content_sha256, creation_digest, created_at, updated_at FROM study_source_files
    WHERE user_id = $1 AND study_set_id = $2 ORDER BY created_at DESC, id DESC LIMIT 100`, [userId, setId]);
  const result: SourceFileRecord[] = [];
  for (const row of rows) result.push(toRecord(row, row.status === 'ready' ? await pagesFor(db, userId, row.id) : []));
  return result;
}

export async function readSourceFile(db: Db, root: string, userId: string, setId: string, fileId: string): Promise<{ name: string; bytes: Buffer }> {
  const [row] = await db.query<FileRow>(`SELECT id, study_set_id, material_id, display_name, byte_size, status, page_count,
    content_sha256, creation_digest, created_at, updated_at FROM study_source_files
    WHERE user_id = $1 AND study_set_id = $2 AND id = $3`, [userId, setId, fileId]);
  if (!row || row.status !== 'ready') throw new DomainError('not_found', '没有找到该学习资料。');
  const path = storagePath(root, userId, row.id);
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) throw new DomainError('not_found', '没有找到该学习资料。');
  const bytes = await readFile(path);
  if (bytes.length !== row.byte_size || createHash('sha256').update(bytes).digest('hex') !== row.content_sha256) {
    throw new DomainError('internal', '原文件暂时无法读取，请稍后重试。');
  }
  return { name: row.display_name, bytes };
}

/** Remove PDFs whose account is gone, and files left behind after a row disappeared. */
export async function reconcileStoredFiles(db: Db, root: string, graceMs = FILE_ORPHAN_GRACE_MS): Promise<void> {
  const base = resolveFileRoot(root);
  const entries = await readdir(base, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!uuidPattern.test(entry.name)) continue;
    const userDir = userDirectory(base, entry.name);
    const info = await lstat(userDir).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) { await rm(userDir, { force: true }); continue; }
    if (!info.isDirectory()) continue;
    const [user] = await db.query('SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL', [entry.name]);
    if (!user) { await rm(userDir, { recursive: true, force: true }); continue; }
    const children = await readdir(userDir, { withFileTypes: true });
    for (const child of children) {
      if (!uuidPattern.test(child.name)) continue;
      const path = storagePath(base, entry.name, child.name);
      const fileInfo = await lstat(path).catch(() => null);
      if (!fileInfo) continue;
      if (fileInfo.isSymbolicLink()) { await rm(path, { force: true }); continue; }
      if (!fileInfo.isFile()) continue;
      const [row] = await db.query('SELECT id FROM study_source_files WHERE user_id = $1 AND id = $2', [entry.name, child.name]);
      if (row || Date.now() - fileInfo.mtimeMs < graceMs) continue;
      await rm(path, { force: true });
    }
  }
}
