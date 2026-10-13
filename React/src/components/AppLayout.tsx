/*
 * 页面外壳：顶部栏 + 内容区。登录页与 404 不走这里，所以它们没有导航栏。
 */
import { Outlet } from 'react-router-dom';
import { TopBar } from './TopBar';

export function AppLayout() {
  return (
    <div className="min-h-full bg-background-subtle">
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
