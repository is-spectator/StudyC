export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Multipart upload. Do not also set body; the browser supplies the boundary. */
  formData?: FormData;
  /** Return the response body as a Blob instead of JSON. Errors remain JSON. */
  binary?: boolean;
  /** Authenticated SSE. Events are delivered only while the account stays current. */
  onEvent?: (event: { event: string; data: unknown; id?: string }) => void;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class AuthApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'AuthApiError';
    this.code = code;
    this.status = status;
  }
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw isAbortError(signal.reason) ? signal.reason : new DOMException('请求已取消。', 'AbortError');
}

export interface CookieSession { userId: string; csrfToken: string }
export interface AccountUser { id: string; signInMethod?: string; aiConsent?: boolean; roles?: string[] }
export interface CodeResponse { challengeId: string; expiresIn: number; retryAfter: number; message: string }
export const isUserId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function parseSession(value: unknown): CookieSession {
  const data = value as Partial<CookieSession> | null;
  if (!data || !isUserId(data.userId) || typeof data.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)) {
    throw new AuthApiError('invalid_response', '暂时无法确认登录状态，请重试。');
  }
  return { userId: data.userId.toLowerCase(), csrfToken: data.csrfToken };
}

export function parseUser(value: unknown, expectedUserId: string): AccountUser {
  const data = value as AccountUser | null;
  if (!data || !isUserId(data.id)) throw new AuthApiError('invalid_response', '暂时无法确认账户信息，请重试。');
  if (data.id.toLowerCase() !== expectedUserId.toLowerCase()) throw new AuthApiError('account_mismatch', '账户已切换，请重新登录。', 409);
  return { ...data, id: data.id.toLowerCase() };
}

export function sessionHeaders(session: CookieSession): Record<string, string> {
  return { 'X-PlanPlan-Expected-User': session.userId, 'X-CSRF-Token': session.csrfToken };
}

/** Credentials never enter JavaScript storage. Only same-origin API URLs are accepted. */
export async function authApi<T>(path: string, options: RequestOptions = {}, fetcher: typeof fetch = fetch): Promise<T> {
  throwIfAborted(options.signal);
  if (!path.startsWith('/v1/') || path.includes('\\') || /[\r\n]/.test(path)) throw new AuthApiError('invalid_request', '请求地址无效。');
  if (options.formData !== undefined && options.body !== undefined) throw new AuthApiError('invalid_request', '请求格式不正确。');
  const headers = new Headers(options.headers);
  if (headers.has('Authorization') || headers.has('Cookie')) throw new AuthApiError('credential_conflict', '请使用浏览器账户会话。');
  headers.set('Accept', options.onEvent ? 'text/event-stream' : options.binary ? 'application/pdf, application/json' : 'application/json');
  if (options.formData === undefined && options.body !== undefined) headers.set('Content-Type', 'application/json');
  const service = path.startsWith('/v1/study/') ? '学习服务' : '账户服务';
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(options.onEvent ? 90_000 : 20_000);
    response = await fetcher(path, {
      method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers,
      body: options.formData ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throwIfAborted(options.signal);
    throw new AuthApiError('connection_lost', `暂时无法连接${service}，请检查网络后重试。`);
  }
  throwIfAborted(options.signal);
  if (options.onEvent && response.ok) {
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      void response.body?.cancel();
      throw new AuthApiError('invalid_response', '回答连接没有返回有效的数据流。');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', bytes = 0;
    try {
      while (true) {
        throwIfAborted(options.signal);
        const part = await reader.read();
        throwIfAborted(options.signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new AuthApiError('invalid_response', '回答数据流超过大小限制。');
        buffer += decoder.decode(part.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          let event = 'message', id: string | undefined;
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('id:')) id = line.slice(3).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!data.length) continue;
          if (frame.length > 256 * 1024 || event.length > 80 || (id?.length ?? 0) > 100) throw new AuthApiError('invalid_response', '回答数据流格式不正确。');
          let value: unknown;
          try { value = JSON.parse(data.join('\n')); } catch { throw new AuthApiError('invalid_response', '回答数据流格式不正确。'); }
          options.onEvent({ event, data: value, ...(id === undefined ? {} : { id }) });
          if (event === 'done') return undefined as T;
        }
        if (buffer.length > 256 * 1024) throw new AuthApiError('invalid_response', '回答数据流格式不正确。');
      }
      decoder.decode();
      throw new AuthApiError('connection_lost', '回答连接已断开，已保存的任务可以重新连接查看。');
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  if (options.binary && response.ok) {
    const blob = await response.blob();
    throwIfAborted(options.signal);
    return blob as T;
  }
  let value: unknown;
  try { value = await response.json(); } catch (error) {
    if (isAbortError(error)) throw error;
    throwIfAborted(options.signal);
    throw new AuthApiError('invalid_response', `${service}暂时没有返回有效回复，请稍后重试。`, response.status);
  }
  throwIfAborted(options.signal);
  if (!response.ok) {
    const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new AuthApiError(typeof error?.code === 'string' ? error.code : 'request_failed', typeof error?.message === 'string' ? error.message : '这次请求未完成，请重试。', response.status);
  }
  return value as T;
}
