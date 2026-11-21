import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { SharedRateLimiter } from '../runtime/rate-limit.js';
import { StudyInputError } from '../services/study-data.js';
import {
  PDF_FILE_MAX_BYTES, PDF_MULTIPART_OVERHEAD_BYTES, listSourceFiles, readSourceFile, sourceFailureMessage, uploadPdf, type SourceFileRecord,
} from '../services/study-files.js';

type Env = { Variables: { userId: string } };
const uuid = z.uuid().transform(value => value.toLowerCase());

function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function jsonFile(file: SourceFileRecord, replayed: boolean) {
  const failure = file.status === 'ready' ? null : { code: file.status, message: sourceFailureMessage[file.status] };
  const status = file.status === 'ready' ? (replayed ? 200 : 201) : (replayed ? 200 : 422);
  return { body: failure ? { file, error: failure } : { file }, status } as const;
}

export function registerFileRoutes(app: Hono<Env>, db: Db, limits: SharedRateLimiter, fileRoot: string): void {
  const uid = (c: Context<Env>) => c.get('userId');
  const setId = (c: Context<Env>) => uuid.parse(c.req.param('setId'));
  const fileId = (c: Context<Env>) => uuid.parse(c.req.param('fileId'));
  const limit = bodyLimit({
    maxSize: PDF_FILE_MAX_BYTES + PDF_MULTIPART_OVERHEAD_BYTES,
    onError: c => c.json({ error: { code: 'payload_too_large', message: 'PDF 不能超过 8 MiB，这次没有保存。' } }, 413),
  });

  app.post('/v1/study/sets/:setId/files', limit, async c => {
    await limits.consume('write', uid(c), 120);
    const parent = setId(c);
    const form = await c.req.formData();
    const keys = [...form.keys()];
    if (keys.some(key => key !== 'file' && key !== 'clientRequestId') || form.getAll('file').length !== 1 || form.getAll('clientRequestId').length !== 1) {
      throw new StudyInputError('请提交一个 PDF 文件和一次上传标识。');
    }
    const requestId = uuid.parse(form.get('clientRequestId'));
    const file = form.get('file');
    if (!(file instanceof File)) throw new StudyInputError('请上传 PDF 文件。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await uploadPdf(db, fileRoot, uid(c), parent, { clientRequestId: requestId, filename: file.name, bytes });
    const response = jsonFile(result.file, result.replayed);
    return c.json(response.body, response.status);
  });
  app.get('/v1/study/sets/:setId/files', async c => c.json({ items: await listSourceFiles(db, uid(c), setId(c)) }));
  app.get('/v1/study/sets/:setId/files/:fileId/content', async c => {
    const file = await readSourceFile(db, fileRoot, uid(c), setId(c), fileId(c));
    return new Response(new Uint8Array(file.bytes), {
      headers: { 'content-type': 'application/pdf', 'content-disposition': disposition(file.name), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
    });
  });
}
