import { AuthApiError, throwIfAborted, type RequestOptions } from '../auth/api.ts';

export interface StudySet { id: string; title: string; version: number; createdAt: string; updatedAt: string }
export interface MaterialSummary extends StudySet { studySetId: string; format: 'plain_text' }
export interface TextMaterial extends MaterialSummary { body: string }
export interface StudyPage<T> { items: T[]; nextCursor: string | null }
export interface CreateStudySetInput { clientRequestId: string; title: string }
export interface UpdateStudySetInput { version: number; title: string }
export interface CreateTextMaterialInput extends CreateStudySetInput { body: string }
export interface UpdateTextMaterialInput { version: number; title?: string; body?: string }
export type StudyRequest = <T>(path: string, options?: RequestOptions) => Promise<T>;

export const STUDY_TITLE_MAX = 60;
export const MATERIAL_TITLE_MAX = 120;
export const TEXT_BODY_MAX_BYTES = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unsupportedText = /[\u0000\uD800-\uDFFF]/u;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidResponse = () => new AuthApiError('invalid_response', '学习服务返回的资料格式不正确，请重试。', 502);
const invalidInput = (message: string) => new AuthApiError('invalid_input', message, 400);

/** Client checks match the plain-text API; they never change the text body. */
export function validateStudyTitle(value: string, max = STUDY_TITLE_MAX): string {
  if (typeof value !== 'string' || unsupportedText.test(value)) throw invalidInput('标题包含不支持的字符。');
  const title = value.trim();
  if (!title || Array.from(title).length > max) throw invalidInput(`标题需要 1–${max} 个字符。`);
  return title;
}

export function validateTextBody(value: string): string {
  if (typeof value !== 'string' || unsupportedText.test(value)) throw invalidInput('正文包含不支持的字符。');
  if (new TextEncoder().encode(value).byteLength > TEXT_BODY_MAX_BYTES) {
    throw new AuthApiError('payload_too_large', '正文不能超过 1 MiB，请缩短后再保存。', 413);
  }
  return value;
}

function id(value: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new AuthApiError('invalid_request', '学习资料地址无效。', 400);
  return value.toLowerCase();
}

function version(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2147483646) throw invalidInput('资料版本无效，请重新读取资料。');
  return value;
}

function isCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(value);
}

function pagePath(path: string, cursor?: string): string {
  if (cursor === undefined) return path;
  if (!isCursor(cursor)) throw new AuthApiError('invalid_request', '分页位置无效，请重新加载列表。', 400);
  return `${path}?${new URLSearchParams({ cursor })}`;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function parseSet(value: unknown, titleMax = STUDY_TITLE_MAX): StudySet {
  if (!record(value) || typeof value.id !== 'string' || !uuid.test(value.id)
    || typeof value.title !== 'string' || value.title.trim() !== value.title || !value.title
    || Array.from(value.title).length > titleMax || unsupportedText.test(value.title)
    || typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1 || value.version > 2147483647
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) throw invalidResponse();
  return { id: value.id.toLowerCase(), title: value.title, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function parseSummary(value: unknown, setId: string): MaterialSummary {
  const base = parseSet(value, MATERIAL_TITLE_MAX);
  if (!record(value) || typeof value.studySetId !== 'string' || !uuid.test(value.studySetId)
    || value.studySetId.toLowerCase() !== setId || value.format !== 'plain_text') throw invalidResponse();
  return { ...base, studySetId: setId, format: 'plain_text' };
}

function parseMaterial(value: unknown, setId: string, materialId?: string): TextMaterial {
  const base = parseSummary(value, setId);
  if (!record(value) || typeof value.body !== 'string' || unsupportedText.test(value.body)
    || new TextEncoder().encode(value.body).byteLength > TEXT_BODY_MAX_BYTES
    || (materialId !== undefined && base.id !== materialId)) throw invalidResponse();
  return { ...base, body: value.body };
}

function unwrap(value: unknown, key: 'studySet' | 'material'): unknown {
  if (!record(value) || !(key in value)) throw invalidResponse();
  return value[key];
}

function parsePage<T extends { id: string }>(value: unknown, parse: (item: unknown) => T): StudyPage<T> {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 100
    || (value.nextCursor !== null && !isCursor(value.nextCursor))
    || (value.items.length === 0 && value.nextCursor !== null)) throw invalidResponse();
  const items = value.items.map(parse);
  if (new Set(items.map(item => item.id)).size !== items.length) throw invalidResponse();
  return { items, nextCursor: value.nextCursor as string | null };
}

/** No transport fallback, local persistence, or automatic mutation retry. The
 * caller retains its draft and clientRequestId until the outcome is known. */
export function createStudyApi(request: StudyRequest) {
  const send = async (path: string, options: RequestOptions = {}): Promise<unknown> => {
    throwIfAborted(options.signal);
    const value = await request<unknown>(path, options);
    throwIfAborted(options.signal);
    return value;
  };
  const setResult = (value: unknown, expectedId?: string) => {
    const result = parseSet(unwrap(value, 'studySet'));
    if (expectedId !== undefined && result.id !== expectedId) throw invalidResponse();
    return result;
  };
  return {
    async listSets(cursor?: string, signal?: AbortSignal): Promise<StudyPage<StudySet>> {
      return parsePage(await send(pagePath('/v1/study/sets', cursor), { signal }), item => parseSet(item));
    },
    async getSet(setId: string, signal?: AbortSignal): Promise<StudySet> {
      const target = id(setId);
      return setResult(await send(`/v1/study/sets/${target}`, { signal }), target);
    },
    async createSet(input: CreateStudySetInput, signal?: AbortSignal): Promise<StudySet> {
      const body = { clientRequestId: id(input.clientRequestId), title: validateStudyTitle(input.title) };
      return setResult(await send('/v1/study/sets', { method: 'POST', body, signal }));
    },
    async renameSet(setId: string, input: UpdateStudySetInput, signal?: AbortSignal): Promise<StudySet> {
      const target = id(setId), body = { title: validateStudyTitle(input.title), version: version(input.version) };
      return setResult(await send(`/v1/study/sets/${target}`, { method: 'PATCH', body, signal }), target);
    },
    async listMaterials(setId: string, cursor?: string, signal?: AbortSignal): Promise<StudyPage<MaterialSummary>> {
      const target = id(setId);
      return parsePage(await send(pagePath(`/v1/study/sets/${target}/materials`, cursor), { signal }), item => parseSummary(item, target));
    },
    async getMaterial(setId: string, materialId: string, signal?: AbortSignal): Promise<TextMaterial> {
      const target = id(setId), material = id(materialId);
      return parseMaterial(unwrap(await send(`/v1/study/sets/${target}/materials/${material}`, { signal }), 'material'), target, material);
    },
    async createMaterial(setId: string, input: CreateTextMaterialInput, signal?: AbortSignal): Promise<TextMaterial> {
      const target = id(setId);
      const body = { clientRequestId: id(input.clientRequestId), title: validateStudyTitle(input.title, MATERIAL_TITLE_MAX), body: validateTextBody(input.body) };
      return parseMaterial(unwrap(await send(`/v1/study/sets/${target}/materials`, { method: 'POST', body, signal }), 'material'), target);
    },
    async updateMaterial(setId: string, materialId: string, input: UpdateTextMaterialInput, signal?: AbortSignal): Promise<TextMaterial> {
      const target = id(setId), material = id(materialId);
      if (input.title === undefined && input.body === undefined) throw invalidInput('请提供要保存的标题或正文。');
      const body = { version: version(input.version),
        ...(input.title === undefined ? {} : { title: validateStudyTitle(input.title, MATERIAL_TITLE_MAX) }),
        ...(input.body === undefined ? {} : { body: validateTextBody(input.body) }) };
      return parseMaterial(unwrap(await send(`/v1/study/sets/${target}/materials/${material}`, { method: 'PATCH', body, signal }), 'material'), target, material);
    },
  };
}

export type StudyApi = ReturnType<typeof createStudyApi>;
