/*
 * 登录页。整个流程只有一步：把浏览器交给 /auth/login，剩下（微信授权、code 换 token、
 * 建会话、Set-Cookie）都在后端完成，回来时 cookie 已经就位。
 */
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Button, buttonVariants } from '@appica/ui-react/button';
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card';
import { ErrorAlert } from '../components/Feedback';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { me, loading, login } = useAuth();
  const location = useLocation();

  if (loading) return null;

  if (me) {
    const state = location.state as { from?: string } | null;
    return <Navigate to={state?.from || '/'} replace />;
  }

  // 后端在回调失败时会带 ?error= 跳回来（见 router.js 的 callback）。
  const error = new URLSearchParams(location.search).get('error');

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-subtle px-4">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle render={<h1 />}>登录</CardTitle>
          </CardHeader>
          <div className="flex flex-col gap-3">
            <ErrorAlert message={error} />
            <Button variant="primary" size="lg" onClick={() => login()}>
              微信登录
            </Button>
            <Link to="/activate" className={buttonVariants({ variant: 'ghost', size: 'md' })}>
              未登录绑定设备
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
