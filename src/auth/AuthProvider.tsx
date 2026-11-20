import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { authApi, AuthApiError, isUserId, parseSession, parseUser, sessionHeaders, type AccountUser, type CodeResponse, type CookieSession, type RequestOptions } from './api';
import type { AuthState, AuthStatus } from './session-state';

export const previewAvailable = import.meta.env.DEV && !import.meta.env.PROD;
type AuthContextValue = AuthState & {
  isPreview: boolean;
  refresh: () => Promise<boolean>;
  authenticate: (body: Record<string, string>) => Promise<void>;
  requestCode: (email: string) => Promise<CodeResponse>;
  resetPassword: (body: Record<string, string>) => Promise<void>;
  request: <T>(path: string, options?: RequestOptions) => Promise<T>;
  logout: () => Promise<void>;
  enterPreview: () => void;
  leavePreview: () => void;
};
const AuthContext = createContext<AuthContextValue | null>(null);
const initialPreview = previewAvailable && import.meta.env.VITE_AUTH_MODE === 'preview';
const messageOf = (error: unknown) => error instanceof Error ? error.message : '账户请求未完成，请重试。';
const invalidIdentity = (error: unknown) => error instanceof AuthApiError && (error.status === 401 || error.code === 'account_mismatch');

async function withSessionLock<T>(task: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request('planplan-browser-session', task);
  return task();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: initialPreview ? 'preview' : 'checking', user: null, message: '' });
  const session = useRef<CookieSession | null>(null);
  const confirmedUser = useRef<AccountUser | null>(null);
  const sequence = useRef(0);
  const epoch = useRef(0);
  const preview = useRef(initialPreview);
  const mutation = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const mounted = useRef(true);

  const clear = useCallback((status: AuthStatus, message = '') => {
    ++sequence.current;
    ++epoch.current;
    session.current = null;
    confirmedUser.current = null;
    if (mounted.current) setState({ status, user: null, message });
  }, []);

  const lock = useCallback((status: 'verifying' | 'unavailable', message = '') => {
    ++sequence.current;
    ++epoch.current;
    session.current = null;
    if (mounted.current) setState({ status, user: confirmedUser.current, message });
  }, []);

  const readSession = useCallback(async (expectedId?: string): Promise<boolean> => {
    if (preview.current) return false;
    const attempt = ++sequence.current;
    try {
      const nextSession = parseSession(await authApi('/v1/auth/web/session'));
      if (attempt !== sequence.current || !mounted.current) return false;
      if (expectedId && nextSession.userId !== expectedId.toLowerCase()) throw new AuthApiError('account_mismatch', '登录账户发生变化，请重新登录。', 409);
      const user = parseUser(await authApi('/v1/me', { headers: sessionHeaders(nextSession) }), nextSession.userId);
      if (attempt !== sequence.current || !mounted.current) return false;
      if (session.current?.userId !== user.id) ++epoch.current;
      session.current = nextSession;
      confirmedUser.current = user;
      setState({ status: 'authenticated', user, message: '' });
      return true;
    } catch (error) {
      if (attempt !== sequence.current || !mounted.current) return false;
      if (invalidIdentity(error)) clear('anonymous', '请登录后继续学习。');
      else lock('unavailable', messageOf(error));
      return false;
    }
  }, [clear, lock]);

  const refresh = useCallback(() => readSession(), [readSession]);
  const broadcast = () => channel.current?.postMessage('changed');

  useEffect(() => {
    mounted.current = true;
    if (!preview.current) void readSession();
    const verify = () => {
      if (preview.current || mutation.current || document.visibilityState === 'hidden') return;
      // Keep same-account drafts mounted but invisible/inert during verification.
      // Pending local saves still belong to the previous account. Protected API
      // calls are blocked until the cookie identity has been checked again.
      if (confirmedUser.current) lock('verifying');
      void readSession();
    };
    const offline = () => { if (!preview.current) lock('unavailable', '网络已断开。重新连接后验证账户，即可继续学习。'); };
    const changed = () => { if (!preview.current) verify(); };
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('planplan-session');
      channel.current.addEventListener('message', changed);
    }
    const timer = window.setInterval(() => { if (!preview.current && !mutation.current && document.visibilityState === 'visible' && navigator.onLine) void readSession(); }, 30_000);
    window.addEventListener('focus', verify);
    window.addEventListener('online', verify);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', verify);
    return () => {
      mounted.current = false;
      ++sequence.current;
      window.clearInterval(timer);
      channel.current?.close();
      channel.current = null;
      window.removeEventListener('focus', verify);
      window.removeEventListener('online', verify);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', verify);
    };
  }, [clear, lock, readSession]);

  const request = useCallback(async <T,>(path: string, options: RequestOptions = {}): Promise<T> => {
    const current = session.current;
    const started = epoch.current;
    if (!current || preview.current) throw new AuthApiError('unauthorized', '请先登录。', 401);
    try {
      const result = await authApi<T>(path, { ...options, headers: { ...options.headers, ...sessionHeaders(current) } });
      if (epoch.current !== started || session.current?.userId !== current.userId) throw new AuthApiError('account_mismatch', '账户已切换，请重新核对。', 409);
      return result;
    } catch (error) {
      if (epoch.current === started) {
        if (invalidIdentity(error)) clear('anonymous', messageOf(error));
        else if (error instanceof AuthApiError && (error.code === 'connection_lost' || error.status >= 500)) lock('unavailable', messageOf(error));
      }
      throw error;
    }
  }, [clear, lock]);

  async function authenticate(body: Record<string, string>) {
    if (mutation.current) throw new AuthApiError('busy', '请等待当前账户操作完成。');
    mutation.current = true;
    try {
      await withSessionLock(async () => {
        const result = await authApi<{ userId: string }>('/v1/auth/web/email/login', { method: 'POST', body });
        if (!isUserId(result?.userId)) throw new AuthApiError('invalid_response', '暂时无法确认登录结果，请重新验证账户。');
        preview.current = false;
        clear('checking');
        broadcast();
        if (!await readSession(result.userId)) throw new AuthApiError('session_unverified', '账户已提交验证，请重新检查登录状态。');
      });
    } finally { mutation.current = false; }
  }

  async function requestCode(email: string) {
    const result = await authApi<CodeResponse>('/v1/auth/web/email/code', { method: 'POST', body: { email, purpose: 'reset' } });
    if (!isUserId(result?.challengeId) || !Number.isFinite(result.retryAfter) || result.retryAfter < 0 || typeof result.message !== 'string') throw new AuthApiError('invalid_response', '暂时无法确认验证码发送结果，请重试。');
    return result;
  }

  async function resetPassword(body: Record<string, string>) {
    if (mutation.current) throw new AuthApiError('busy', '请等待当前账户操作完成。');
    mutation.current = true;
    try {
      await withSessionLock(async () => {
        const result = await authApi<{ reset: boolean }>('/v1/auth/web/email/reset', { method: 'POST', body });
        if (result?.reset !== true) throw new AuthApiError('invalid_response', '暂时无法确认密码重置结果，请重试。');
        clear('anonymous', '密码已重置，所有旧会话已退出。请使用新密码登录。');
        broadcast();
      });
    } finally { mutation.current = false; }
  }

  async function logout() {
    if (mutation.current) return;
    const current = session.current;
    if (!current) { clear('anonymous'); return; }
    mutation.current = true;
    clear('checking');
    try {
      await withSessionLock(async () => {
        const result = await authApi<{ ok: boolean }>('/v1/logout', { method: 'POST', headers: sessionHeaders(current) });
        if (result?.ok !== true) throw new AuthApiError('invalid_response', '暂时无法确认退出结果，请重新验证账户。');
        clear('anonymous', '已退出此账户的所有设备。');
        broadcast();
      });
    } catch (error) {
      clear(invalidIdentity(error) ? 'anonymous' : 'unavailable', invalidIdentity(error) ? '登录已失效，请重新登录。' : '暂时无法确认退出结果。请重新连接并验证账户。');
    } finally { mutation.current = false; }
  }

  function enterPreview() {
    if (!previewAvailable || mutation.current) return;
    preview.current = true;
    clear('preview');
  }
  function leavePreview() {
    preview.current = false;
    clear('checking');
    void readSession();
  }

  return <AuthContext.Provider value={{ ...state, isPreview: previewAvailable && state.status === 'preview', refresh, authenticate, requestCode, resetPassword, request, logout, enterPreview, leavePreview }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is required');
  return value;
}
