export interface RequestOptions {
  method?: string;
  body?: unknown;
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
  if (!path.startsWith('/v1/') || path.includes('\\') || /[\r\n]/.test(path)) throw new AuthApiError('invalid_request', '请求地址无效。');
  const headers = new Headers(options.headers);
  if (headers.has('Authorization') || headers.has('Cookie')) throw new AuthApiError('credential_conflict', '请使用浏览器账户会话。');
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(20_000);
    response = await fetcher(path, {
      method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
  } catch {
    throw new AuthApiError('connection_lost', '暂时无法连接账户服务，请检查网络后重试。');
  }
  let value: unknown;
  try { value = await response.json(); } catch { throw new AuthApiError('invalid_response', '账户服务暂时没有返回有效回复，请稍后重试。', response.status); }
  if (!response.ok) {
    const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new AuthApiError(typeof error?.code === 'string' ? error.code : 'request_failed', typeof error?.message === 'string' ? error.message : '这次请求未完成，请重试。', response.status);
  }
  return value as T;
}
