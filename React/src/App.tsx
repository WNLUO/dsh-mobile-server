/*
 * 路由表。
 *
 * `/login` 刻意不套 AppLayout：登录页不该出现主导航。
 * `/activate` 也放在外壳里，但它自身匿名可用（授权码即凭证），
 * 这样未登录用户也能从顶部栏进去绑定设备。
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { RequireAdmin, RequireAuth } from './components/guards';
import { AccountPage } from './pages/AccountPage';
import { ActivatePage } from './pages/ActivatePage';
import { BuyPage } from './pages/BuyPage';
import { LicensesPage } from './pages/LicensesPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrdersPage } from './pages/OrdersPage';
import { AdminPage } from './pages/admin/AdminPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<AppLayout />}>
        <Route
          index
          element={
            <RequireAuth>
              <AccountPage />
            </RequireAuth>
          }
        />
        <Route
          path="buy"
          element={
            <RequireAuth>
              <BuyPage />
            </RequireAuth>
          }
        />
        <Route
          path="orders"
          element={
            <RequireAuth>
              <OrdersPage />
            </RequireAuth>
          }
        />
        <Route
          path="licenses"
          element={
            <RequireAuth>
              <LicensesPage />
            </RequireAuth>
          }
        />
        <Route path="activate" element={<ActivatePage />} />
        <Route
          path="admin"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
        <Route path="settings" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
