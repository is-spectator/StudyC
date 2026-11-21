import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export type StudyEnv = { Variables: { userId: string } };
export const STUDY_ORIGIN = 'https://study.clyna.ai';
const sessionEndpoint = 'http://127.0.0.1:8789/v1/auth/web/session';
const secureCookie = '__Host-planplan-session';
const localCookie = 'planplan-local-session';
const sessionTimeoutMs = 2000;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const messages = {
  unauthorized: '请先登录。',
  credential_conflict: '登录信息冲突，请重新登录。',
  account_mismatch: '登录账户已经变化，请重新进入页面后再操作。',
  origin_forbidden: '请求来源无法确认，请从原页面重试。',
  csrf_invalid: '页面已失效，请重新加载后再操作。',
  service_unavailable: '登录验证暂时不可用，请稍后重试。',
} as const;

export class SessionError extends Error {
  readonly details = {};
  constructor(readonly code: keyof typeof messages) { super(messages[code]); }
}

function sessionCookie(headers: Headers): string {
  const raw = headers.get('cookie') ?? '';
  if (raw.length > 16_384) throw new SessionError('unauthorized');
  const credentials = raw.split(';').flatMap(part => {
    const equal = part.indexOf('=');
    if (equal < 0) return [];
    const name = part.slice(0, equal).trim();
    return name === secureCookie || name === localCookie ? [{ name, value: part.slice(equal + 1).trim() }] : [];
  });
  // Reject duplicate names as well as mixed secure/local cookies. Never let a
  // parser choose one credential while the identity service chooses another.
  if (credentials.length > 1 || (credentials.length && headers.has('authorization'))) {
    throw new SessionError('credential_conflict');
  }
  const credential = credentials[0];
  if (!credential || credential.name !== secureCookie || !/^[A-Za-z0-9._~-]{1,8192}$/.test(credential.value)) {
    throw new SessionError('unauthorized');
  }
  return `${secureCookie}=${credential.value}`;
}

type BrowserSession = { userId: string; csrfToken: string };

async function readSession(response: Response): Promise<BrowserSession> {
  if (response.status === 401) {
    await response.body?.cancel();
    throw new SessionError('unauthorized');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new SessionError('service_unavailable');
  }
  // The current Clyna endpoint returns exactly { userId, csrfToken }. Bound the
  // entire body before parsing; upstream errors never become client messages.
  const reader = response.body?.getReader();
  if (!reader) throw new SessionError('service_unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        void reader.cancel().catch(() => undefined);
        throw new SessionError('service_unavailable');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionError('service_unavailable');
  const result = value as Record<string, unknown>;
  if (typeof result.userId !== 'string' || !uuid.test(result.userId)
    || typeof result.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.csrfToken)) {
    throw new SessionError('service_unavailable');
  }
  return { userId: result.userId, csrfToken: result.csrfToken };
}

async function verifySession(cookie: string, sessionFetch: typeof fetch): Promise<BrowserSession> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => readSession(await sessionFetch(sessionEndpoint, {
        method: 'GET', headers: { Cookie: cookie, Accept: 'application/json' },
        redirect: 'error', signal: controller.signal,
      })))(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SessionError('service_unavailable')); }, sessionTimeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError('service_unavailable');
  } finally { clearTimeout(timer); }
}

/** No JWT keys or registration logic live here. Identity is checked on every
 * request against the existing local Clyna service, without a session cache. */
export function requireStudySession(sessionFetch: typeof fetch = fetch): MiddlewareHandler<StudyEnv> {
  return async (c, next) => {
    const session = await verifySession(sessionCookie(c.req.raw.headers), sessionFetch);
    if (c.req.header('X-PlanPlan-Expected-User') !== session.userId) throw new SessionError('account_mismatch');
    if (['POST', 'PATCH'].includes(c.req.method)) {
      if (c.req.header('Origin') !== STUDY_ORIGIN) throw new SessionError('origin_forbidden');
      const digest = (value: string) => createHash('sha256').update(value).digest();
      if (!timingSafeEqual(digest(c.req.header('X-CSRF-Token') ?? ''), digest(session.csrfToken))) {
        throw new SessionError('csrf_invalid');
      }
    }
    c.set('userId', session.userId);
    await next();
  };
}
