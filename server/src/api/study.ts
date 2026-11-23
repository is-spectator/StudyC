import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { SharedRateLimiter } from '../runtime/rate-limit.js';
import {
  StudyError, StudyInputError, createStudySet, listStudySets, getStudySet, updateStudySet,
  createTextMaterial, listTextMaterials, getTextMaterial, updateTextMaterial,
} from '../services/study-data.js';

type Env = { Variables: { userId: string } };
const smallRequestBytes = 16 * 1024;
const materialRequestBytes = 2 * 1024 * 1024;
const textBytes = 1024 * 1024;
const uuid = z.uuid().transform(value => value.toLowerCase());
// PostgreSQL text cannot preserve NUL or unpaired UTF-16 surrogates.
const text = z.string().refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value), '文本包含不支持的字符');
const title = (max: number) => text.transform(value => value.trim()).refine(value => {
  const length = Array.from(value).length;
  return length >= 1 && length <= max;
}, '标题长度不正确');
const version = z.number().int().min(1).max(2147483646);
const createSet = z.object({ clientRequestId: uuid, title: title(60) }).strict();
const updateSet = z.object({ version, title: title(60) }).strict();
const createMaterial = z.object({ clientRequestId: uuid, title: title(120), body: text }).strict();
const updateMaterial = z.object({ version, title: title(120).optional(), body: text.optional() }).strict()
  .refine(value => value.title !== undefined || value.body !== undefined, '请提供标题或正文');
const page = z.object({
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().max(100)).optional().default(50),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();

/** Always count actual streamed bytes, even with an absent or misleading Content-Length. */
export async function readJson(c: Context<Env>, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(c.req.header('content-type') ?? '')) {
    throw new StudyInputError('请使用 application/json 提交。');
  }
  const declared = c.req.header('content-length');
  if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new StudyInputError('请求长度无效。');
  }
  if (declared !== undefined && Number(declared) > maxBytes) throw oversized();
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new StudyInputError('缺少 JSON 请求。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw oversized();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)); }
  catch { throw new StudyInputError('请求必须是有效的 UTF-8 文本。'); }
  return JSON.parse(decoded);
}

function oversized(): StudyError {
  return new StudyError('payload_too_large', '资料内容过长，这次没有保存。');
}

function checkBody(body: string | undefined): void {
  if (body !== undefined && Buffer.byteLength(body, 'utf8') > textBytes) throw oversized();
}

function listOptions(c: Context<Env>) {
  // Reject duplicate query keys rather than interpreting different values across layers.
  const query = c.req.queries();
  if (Object.values(query).some(values => values.length !== 1)) throw new StudyInputError('分页参数无效。');
  return page.parse(c.req.query());
}

/** Registered only after the shared authenticated-user / Cookie-CSRF middleware. */
export function registerStudyRoutes(app: Hono<Env>, db: Db, limits: SharedRateLimiter): void {
  const uid = (c: Context<Env>) => c.get('userId');
  const setId = (c: Context<Env>) => uuid.parse(c.req.param('setId'));
  const materialId = (c: Context<Env>) => uuid.parse(c.req.param('materialId'));

  app.post('/v1/study/sets', async c => {
    await limits.consume('write', uid(c), 120);
    const input = createSet.parse(await readJson(c, smallRequestBytes));
    const result = await createStudySet(db, uid(c), input);
    return c.json({ studySet: result.studySet }, result.replayed ? 200 : 201);
  });
  app.get('/v1/study/sets', async c => c.json(await listStudySets(db, uid(c), listOptions(c))));
  app.get('/v1/study/sets/:setId', async c => c.json({ studySet: await getStudySet(db, uid(c), setId(c)) }));
  app.patch('/v1/study/sets/:setId', async c => {
    await limits.consume('write', uid(c), 120);
    const id = setId(c);
    const input = updateSet.parse(await readJson(c, smallRequestBytes));
    return c.json({ studySet: await updateStudySet(db, uid(c), id, input) });
  });
  app.post('/v1/study/sets/:setId/materials', async c => {
    await limits.consume('write', uid(c), 120);
    const id = setId(c);
    const input = createMaterial.parse(await readJson(c, materialRequestBytes));
    checkBody(input.body);
    const result = await createTextMaterial(db, uid(c), id, input);
    return c.json({ material: result.material }, result.replayed ? 200 : 201);
  });
  app.get('/v1/study/sets/:setId/materials', async c => c.json(await listTextMaterials(db, uid(c), setId(c), listOptions(c))));
  app.get('/v1/study/sets/:setId/materials/:materialId', async c => c.json({
    material: await getTextMaterial(db, uid(c), setId(c), materialId(c)),
  }));
  app.patch('/v1/study/sets/:setId/materials/:materialId', async c => {
    await limits.consume('write', uid(c), 120);
    const parent = setId(c), id = materialId(c);
    const input = updateMaterial.parse(await readJson(c, materialRequestBytes));
    checkBody(input.body);
    return c.json({ material: await updateTextMaterial(db, uid(c), parent, id, input) });
  });
}
