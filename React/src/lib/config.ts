/*
 * 前端与后端的路径约定，必须与 dsh-mobile-server/lib/platform/config.js 保持一致。
 * 改这里就要同步改那边的 apiPrefix / webPrefix（以及 vite.config.ts 的 base）。
 */
export const API_PREFIX = '/api/platform/v1';
export const WEB_PREFIX = '/platform';
