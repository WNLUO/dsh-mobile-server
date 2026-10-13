/*
 * 加载 / 失败 / 空态的统一外壳，避免每个页面各写一套。
 */
import { Alert, AlertDescription, AlertTitle } from '@appica/ui-react/alert';
import { Spinner } from '@appica/ui-react/spinner';
import type { ReactNode } from 'react';

export function Loading({ label = '加载中' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-foreground-muted">
      <Spinner aria-label={label} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="error">
      <AlertTitle>操作失败</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function EmptyNotice({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-foreground-muted">{children}</p>;
}
