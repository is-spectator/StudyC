import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AuthApiError,
  throwIfAborted,
  type RequestOptions,
} from "../../auth/api.ts";
export type Request = <T>(path: string, options?: RequestOptions) => Promise<T>;
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const invalidResponse = (): never => {
  throw new AuthApiError(
    "invalid_response",
    "服务返回的学习记录暂时无法读取，请重试。",
  );
};
export function useOrganization(request: Request) {
  const scope = useRef(new AbortController()),
    epoch = useRef(0),
    pending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState<null | (() => Promise<void>)>(null);
  useEffect(() => {
    const c = new AbortController();
    scope.current = c;
    ++epoch.current;
    pending.current = false;
    return () => {
      c.abort();
      ++epoch.current;
    };
  }, []);
  const call = useMemo(
    () =>
      async <T>(path: string, options: RequestOptions = {}) => {
        const signal = scope.current.signal;
        throwIfAborted(signal);
        const value = await request<T>(path, { ...options, signal });
        throwIfAborted(signal);
        return value;
      },
    [request],
  );
  const run = useCallback(async (fn: () => Promise<void>, retain = false) => {
    if (pending.current) return;
    const e = epoch.current;
    pending.current = true;
    setBusy(true);
    setError("");
    setRetry(null);
    try {
      await fn();
    } catch (cause) {
      if (e === epoch.current && !scope.current.signal.aborted) {
        setError(
          cause instanceof Error ? cause.message : "请求未完成，请重试。",
        );
        const status = (cause as { status?: number }).status ?? 0;
        if (retain && (status === 0 || status >= 500)) setRetry(() => fn);
      }
    } finally {
      if (e === epoch.current && !scope.current.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, []);
  return { call, run, busy, error, retry, clearError: () => setError("") };
}
