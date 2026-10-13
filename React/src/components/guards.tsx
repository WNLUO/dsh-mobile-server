/*
 * 路由守卫。
 *
 * 这里只负责「不把页面渲染给不该看的人」；权限的最终判定始终在后端
 * （router.js 的 requireUser / requireAdmin），前端不做安全假设。
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@appica/ui-react/alert';
import { useAuth } from '../lib/auth';
import { Loading } from './Feedback';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Loading label="正在确认登录状态" />;
  if (!me) {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { me } = useAuth();

  if (!me?.user.isAdmin) {
    return (
      <Alert variant="warning">
        <AlertTitle>没有后台权限</AlertTitle>
        <AlertDescription>当前账号不是管理员。</AlertDescription>
      </Alert>
    );
  }
  return <>{children}</>;
}
