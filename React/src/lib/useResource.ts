/*
 * 拉取远端数据的极简封装：把 loading / error / data 收成一个对象，
 * loader 必须是稳定引用（模块级函数或 useCallback），否则会无限重拉。
 */
import { useCallback, useEffect, useState } from 'react';
import { describe } from './auth';

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useResource<T>(loader: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loader());
      setError(null);
    } catch (cause) {
      setData(null);
      setError(describe(cause));
    } finally {
      setLoading(false);
    }
  }, [loader]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
