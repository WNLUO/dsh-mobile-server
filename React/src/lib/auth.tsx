/*
 * 登录态。
 *
 * 会话只存在于 HttpOnly cookie 里，前端保持的唯一事实来源是 GET /me 的结果。
 * 因此任何一次写操作之后要刷新界面，都调 reload()，不要在本地拼装用户对象。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { ApiError, api } from './api';
import { API_PREFIX, WEB_PREFIX } from './config';
import type { MeResponse } from './types';

interface AuthContextValue {
  me: MeResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  login: (nextPath?: string) => void;
  setMe: Dispatch<SetStateAction<MeResponse | null>>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setMe(await api.me());
      setError(null);
    } catch (cause) {
      // 未登录不是错误，只是「没有用户」；其它失败才提示。
      setMe(null);
      setError(cause instanceof ApiError && cause.status === 401 ? null : describe(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 会话可能已经过期，本地照样清干净。
    }
    setMe(null);
  }, []);

  const login = useCallback((nextPath?: string) => {
    const next = nextPath ?? `${window.location.pathname.slice(WEB_PREFIX.length)}${window.location.search}`;
    window.location.assign(`${API_PREFIX}/auth/login?next=${encodeURIComponent(next || '/')}`);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ me, loading, error, reload, logout, login, setMe }),
    [me, loading, error, reload, logout, login],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内部使用');
  return value;
}

export function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return '出现未知错误';
}
