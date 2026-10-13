/*
 * 平台 API 的响应类型。
 * 字段名对应 lib/platform/router.js 里的 publicUser / publicOrder / publicLicense / publicDevice
 * 序列化函数（后端一律 camelCase）；审计日志是唯一例外，直接透出 SQLite 的 snake_case 行。
 */

export interface PlatformUser {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export type OrderStatus = 'created' | 'paying' | 'paid' | 'closed';

export interface Order {
  id: string;
  outTradeNo: string;
  deviceCount: number;
  months: number;
  unitCents: number;
  amountCents: number;
  amountYuan: string;
  status: OrderStatus;
  payTradeNo: string | null;
  payUrl: string | null;
  transactionId: string | null;
  licenseId: string | null;
  paidAt: string | null;
  createdAt: string;
}

export type LicenseStatus = 'active' | 'revoked' | 'expired';

export interface LicenseDevice {
  id: string;
  deviceId: string;
  deviceName: string | null;
  platform: string | null;
  status: string;
  boundAt: string;
  lastSeenAt: string | null;
}

export interface License {
  id: string;
  code: string;
  deviceLimit: number;
  months: number;
  startsAt: string;
  expiresAt: string;
  status: LicenseStatus;
  orderId: string | null;
  note: string | null;
  createdAt: string;
  deviceCount: number;
  devices: LicenseDevice[];
}

export interface PlanTerm {
  months: number;
  amountCents: number;
  amountYuan: string;
}

export interface PricingPlans {
  unitCents: number;
  unitYuan: string;
  maxMonths: number;
  maxDevices: number;
  currency: string;
  months: PlanTerm[];
}

export interface PlatformConfig {
  publicBaseUrl: string;
  apiPrefix: string;
  webPrefix: string;
  pricing: PricingPlans;
  payEnabled: boolean;
  oidcEnabled: boolean;
}

export interface MeStats {
  licenseCount: number;
  activeLicenseCount: number;
  deviceCount: number;
  paidCents: number;
}

export interface MeResponse {
  user: PlatformUser;
  licenses: License[];
  orders: Order[];
  stats: MeStats;
}

export interface AdminOverview {
  userCount: number;
  orderCount: number;
  paidOrderCount: number;
  licenseCount: number;
  activeLicenseCount: number;
  deviceCount: number;
  revenueCents: number;
  recentOrders: Order[];
  recentLicenses: License[];
}

export interface AdminUser extends PlatformUser {
  licenseCount: number;
  orderCount: number;
}

/** 后台授权列表：在 publicLicense 上多带一个归属人。 */
export interface AdminLicense extends License {
  userId: string;
  owner: string;
}

/** 审计日志由 store.listAuditLogs 直接返回数据库行，字段是 snake_case。 */
export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  created_at: string;
}

export interface BindResult {
  license: License;
  device: LicenseDevice;
}

export type VerifyReason =
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'device_not_bound'
  | 'device_unbound'
  | 'device_limit';

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyReason | string;
  licenseId?: string;
  expiresAt?: string;
  deviceLimit?: number;
  deviceCount?: number;
}
