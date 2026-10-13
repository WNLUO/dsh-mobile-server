/*
 * 展示层格式化。金额一律由后端给「分」，前端只做显示转换，不参与计算。
 */

const CURRENCY_SYMBOL = '¥';

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 后端时间统一是 UTC ISO 字符串，这里转成本地时区展示。 */
function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : '—';
}

export function formatDate(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? dateFormatter.format(date) : '—';
}

export function formatYuan(cents: number | null | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return `${CURRENCY_SYMBOL}—`;
  return `${CURRENCY_SYMBOL}${(cents / 100).toFixed(2)}`;
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  created: '待支付',
  paying: '支付中',
  paid: '已支付',
  closed: '已关闭',
};

export const LICENSE_STATUS_LABEL: Record<string, string> = {
  active: '生效中',
  revoked: '已吊销',
  expired: '已过期',
};

/** 取值见 lib/platform/router.js 的 verifyLicense（后端只返回这四个 reason）。 */
export const VERIFY_REASON_LABEL: Record<string, string> = {
  not_found: '授权码不存在',
  revoked: '授权码已被吊销',
  expired: '授权码已过期',
  device_not_bound: '此授权码还没有绑定这台设备',
};
