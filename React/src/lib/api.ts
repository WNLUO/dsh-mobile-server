/*
 * 平台 API 客户端。
 *
 * 只做三件事：拼前缀、解后端信封（{success,data} / {success,error}）、把失败统一成 ApiError。
 * 会话靠 cookie（同源、credentials: 'same-origin'），前端不接触任何 token。
 */
import { API_PREFIX } from './config';
import type {
  AdminLicense,
  AdminOverview,
  AdminUser,
  AuditLogRow,
  BindResult,
  License,
  LicenseDevice,
  MeResponse,
  Order,
  PlatformConfig,
  PlatformUser,
  VerifyResult,
} from './types';

type Method = 'GET' | 'POST' | 'DELETE';

/** 业务错误：code 来自后端，401 用来触发「请先登录」。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, init);
  } catch {
    throw new ApiError('网络请求失败，请检查网络后重试', 'NETWORK_ERROR', 0);
  }

  const text = await response.text();
  let payload: Envelope<T> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as Envelope<T>;
    } catch {
      payload = null;
    }
  }

  if (response.ok && payload?.success) {
    return payload.data as T;
  }

  const code = payload?.error?.code ?? `HTTP_${response.status}`;
  const message = payload?.error?.message ?? `请求失败（HTTP ${response.status}）`;
  throw new ApiError(message, code, response.status);
}

export const api = {
  config: () => request<PlatformConfig>('GET', '/config'),

  me: () => request<MeResponse>('GET', '/me'),

  logout: () => request<{ ok: boolean }>('POST', '/auth/logout'),

  createOrder: (payload: { deviceCount: number; months: number }) =>
    request<Order>('POST', '/orders', payload),

  listOrders: () => request<{ orders: Order[] }>('GET', '/orders'),

  getOrder: (id: string) => request<Order>('GET', `/orders/${id}`),

  syncOrder: (id: string) => request<Order>('POST', `/orders/${id}/sync`),

  closeOrder: (id: string) => request<Order>('POST', `/orders/${id}/close`),

  listLicenses: () => request<{ licenses: License[] }>('GET', '/licenses'),

  getLicense: (id: string) => request<License>('GET', `/licenses/${id}`),

  unbindDevice: (licenseId: string, deviceId: string) =>
    request<License>('DELETE', `/licenses/${licenseId}/devices/${encodeURIComponent(deviceId)}`),

  bindLicense: (payload: {
    code: string;
    deviceId: string;
    deviceName?: string;
    platform?: string;
  }) => request<BindResult>('POST', '/licenses/bind', payload),

  verifyLicense: (payload: { code: string; deviceId?: string }) =>
    request<VerifyResult>('POST', '/licenses/verify', payload),

  adminOverview: () => request<AdminOverview>('GET', '/admin/overview'),

  adminUsers: () => request<{ users: AdminUser[] }>('GET', '/admin/users'),

  adminSetUserAdmin: (id: string, isAdmin: boolean) =>
    request<PlatformUser>('POST', `/admin/users/${id}/admin`, { isAdmin }),

  adminOrders: () => request<{ orders: Order[] }>('GET', '/admin/orders'),

  adminLicenses: () => request<{ licenses: AdminLicense[] }>('GET', '/admin/licenses'),

  adminSetLicenseStatus: (id: string, status: string) =>
    request<License>('POST', `/admin/licenses/${id}/status`, { status }),

  adminDevices: () => request<{ devices: LicenseDevice[] }>('GET', '/admin/devices'),

  adminAudit: () => request<{ logs: AuditLogRow[] }>('GET', '/admin/audit'),
};
