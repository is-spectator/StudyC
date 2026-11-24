import { authApi, AuthApiError, isAbortError, sessionHeaders, throwIfAborted, type AccountUser, type CookieSession, type RequestOptions } from './api.ts';

export type AuthStatus = 'checking' | 'verifying' | 'authenticated' | 'anonymous' | 'unavailable' | 'preview';
export type AuthState = { status: AuthStatus; user: AccountUser | null; message: string };

export const invalidIdentity = (error: unknown) => error instanceof AuthApiError && (error.status === 401 || error.code === 'account_mismatch');

interface SessionRequestState {
  session: { current: CookieSession | null };
  epoch: { current: number };
  preview: { current: boolean };
  mounted: { current: boolean };
  clearIdentity: (message: string) => void;
  reverify: (expectedUserId: string) => void;
}

/** Shared by the provider and tests. A business failure never decides whether
 * the account is offline. Only explicit authentication failures change it. */
export async function requestWithSession<T>(path: string, options: RequestOptions, state: SessionRequestState, transport: typeof authApi = authApi): Promise<T> {
  throwIfAborted(options.signal);
  if (!state.mounted.current) throw new DOMException('请求已取消。', 'AbortError');
  const current = state.session.current;
  const started = state.epoch.current;
  if (!current || state.preview.current) throw new AuthApiError('unauthorized', '请先登录。', 401);
  try {
    const headers = new Headers(options.headers);
    for (const [name, value] of Object.entries(sessionHeaders(current))) headers.set(name, value);
    const onEvent: RequestOptions['onEvent'] = options.onEvent ? event => {
      throwIfAborted(options.signal);
      if (!state.mounted.current || state.epoch.current !== started || state.session.current?.userId !== current.userId) {
        throw new AuthApiError('account_mismatch', '账户已切换，请重新核对。', 409);
      }
      options.onEvent!(event);
    } : undefined;
    const result = await transport<T>(path, { ...options, onEvent, headers: Object.fromEntries(headers.entries()) });
    throwIfAborted(options.signal);
    if (!state.mounted.current || state.epoch.current !== started || state.session.current?.userId !== current.userId) {
      throw new AuthApiError('account_mismatch', '账户已切换，请重新核对。', 409);
    }
    return result;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throwIfAborted(options.signal);
    if (state.mounted.current && state.epoch.current === started && state.session.current?.userId === current.userId) {
      if (invalidIdentity(error)) state.clearIdentity(error instanceof Error ? error.message : '请重新登录。');
      else if (error instanceof AuthApiError && error.status === 403 && error.code === 'csrf_invalid') state.reverify(current.userId);
    }
    throw error;
  }
}

/** This is the actual gate decision: pending/offline keeps the previous keyed
 * subtree mounted but never visible. Only verified identity unlocks it. */
export function accountGateView(state: Pick<AuthState, 'status' | 'user'>, allowPreview: boolean) {
  const preview = allowPreview && state.status === 'preview';
  const canRetainAccount = ['authenticated', 'verifying', 'unavailable'].includes(state.status);
  const accountId = preview ? 'preview' : canRetainAccount ? state.user?.id ?? null : null;
  return {
    accountId,
    hidden: accountId !== null && !preview && state.status !== 'authenticated',
    verifying: state.status === 'verifying',
  };
}
