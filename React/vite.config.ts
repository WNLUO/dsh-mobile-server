import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 平台前端的构建配置。
 *
 * base 必须是 `/platform/`：产物由 dsh-mobile-server 的静态服务挂在
 * {PLATFORM_PUBLIC_BASE_URL}/platform/ 下（nginx 的 `location /` 直接反代到
 * 中转端口，所以没有额外的 rewrite）。
 *
 * outDir 指到后端仓的 `public/platform`，让「构建 → 部署」只搬一个目录。
 */
export default defineConfig({
  base: '/platform/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../public/platform',
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    // 本地开发把 API 转发到 platform-server.js（默认 8790），
    // 这样前端不需要知道后端端口。
    proxy: {
      '/api/platform': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: false,
      },
    },
  },
});
