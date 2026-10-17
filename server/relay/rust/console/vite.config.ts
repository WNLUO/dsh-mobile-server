import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 中转控制台的构建配置。
 *
 * base 固定 `/platform/`：产物由中转自己挂在 `{PLATFORM_PUBLIC_BASE_URL}/platform/`
 * 下（nginx 的 `location /` 直接反代到中转端口，没有额外 rewrite）。
 *
 * outDir 落到 `../dist-console`，与 Rust 侧的 `PLATFORM_WEB_ROOT` 默认值对得上；
 * 部署只需要搬这一个目录。
 */
export default defineConfig({
  base: '/platform/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist-console',
    emptyOutDir: true,
    // 单页应用只有一个入口，把资源内联进去省掉静态目录的多文件路由。
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5288,
    strictPort: true,
    // 本地开发把控制台 API 转发给本机起着的那个中转。
    proxy: {
      '/api/platform': { target: process.env.RELAY_DEV_URL ?? 'http://127.0.0.1:18788' },
    },
  },
})
