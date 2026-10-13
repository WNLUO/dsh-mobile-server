/*
 * 顶部栏：站点名 + 主导航 + 账号区。
 *
 * 导航项用 buttonVariants 拿到与 appica Button 一致的视觉，而不是把 <a> 塞进 <Button>。
 * 后台入口只在 isAdmin 时出现——真正的门禁在后端 requireAdmin，这里只是不显示死链。
 */
import { Link, NavLink } from 'react-router-dom';
import { buttonVariants } from '@appica/ui-react/button';
import { useAuth } from '../lib/auth';

const BASE_LINKS = [
  { to: '/', label: '个人中心', end: true },
  { to: '/buy', label: '购买', end: false },
  { to: '/orders', label: '订单', end: false },
  { to: '/licenses', label: '授权', end: false },
  { to: '/activate', label: '绑定设备', end: false },
];

export function TopBar() {
  const { me, logout, login } = useAuth();
  const links = me?.user.isAdmin
    ? [...BASE_LINKS, { to: '/admin', label: '后台', end: false }]
    : BASE_LINKS;

  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link to="/" className="text-foreground-intense font-semibold">
          DSH 中转平台
        </Link>

        <nav aria-label="主导航" className="flex flex-1 flex-wrap items-center gap-1">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                buttonVariants({ variant: isActive ? 'soft' : 'ghost', size: 'sm' })
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {me ? (
            <>
              <span className="text-foreground-muted">{me.user.displayName || '微信用户'}</span>
              <button
                type="button"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                onClick={() => void logout()}
              >
                退出登录
              </button>
            </>
          ) : (
            <button
              type="button"
              className={buttonVariants({ variant: 'primary', size: 'sm' })}
              onClick={() => login()}
            >
              微信登录
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
