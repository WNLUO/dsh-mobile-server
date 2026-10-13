/*
 * 前端入口。
 *
 * basename 用 '/platform'：vite 的 base 是 '/platform/'，生产环境由
 * dsh-mobile-server 的静态服务挂在这个前缀下，本地 dev 也走同一前缀。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@appica/ui-react/providers/theme-provider';
import { AuthProvider } from './lib/auth';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter basename="/platform">
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
