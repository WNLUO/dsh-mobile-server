/**
 * 控制台的接口层。
 *
 * 所有请求都走中转自己（同源），不带任何 token —— 登录态是**同站 Cookie**，
 * 由中转在登录回调里种下。所以这里不需要 `authHeaders`，也不该往 localStorage 塞东西。
 */

/** 控制台 API 前缀。中转端 `PLATFORM_API_PREFIX` 固定这个值。 */
const API = '/api/platform/v1'

/** 页面基址；登录跳转要带回去，登录完原路返回。 */
export const WEB_PREFIX = '/platform'

export interface User {
  id: string
  subject: string
  displayName: string
  avatarUrl: string
  isAdmin: boolean
  status: string
  createdAt: string
  lastLoginAt: string | null
}

export interface License {
  id: string
  ownerId: string | null
  code: string
  deviceLimit: number
  status: 'active' | 'revoked' | string
  note: string
  createdAt: string
  updatedAt: string
}

export interface Device {
  id: string
  licenseId: string
  deviceId: string
  deviceName: string
  platform: string
  status: string
  boundAt: string
  lastSeenAt: string | null
}

export interface Node {
  id: string
  claimCode: string
  name: string
  publicUrl: string
  /** 它**实际在用的**模式（被控端自己报上来的）。 */
  admissionMode: string
  /** 主控端希望它用的模式：'open' / 'restricted'；空串＝主控端不管，由它自己决定。 */
  desiredMode: string
  /** 被主控端移除的时间。有值只剩一条记录给人看，不能再下发任何东西。 */
  revokedAt: string | null
  licenseCount: number
  deviceCount: number
  tunnelOnline: boolean
  lastSeenAt: string | null
  createdAt: string
}

export interface Overview {
  ok: true
  admissionMode: 'open' | 'restricted' | string
  licenseCount: number
  activeLicenseCount: number
  deviceCount: number
  tunnelConnected: boolean
  /** 这台是被控端还是自成一体的中转。 */
  role: 'master' | 'slave' | string
  masterUrl: string
  /** 被控端专用：上次报成功的时间。 */
  masterLastReportAt: string | null
  /** 被控端专用：上次报失败的原因。空表示最近一次是成功的。 */
  masterLastError: string | null
  reportIntervalSeconds: number
  /** 准入模式是否已被主控端接管。为真时本地面板不许改。 */
  modeControlled: boolean
}

/** 业务错误：带着中转回的那句人话。 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (response.status === 401) throw new ApiError(401, 'not signed in')
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    if (body && typeof body === 'object' && 'error' in body) {
      const raw = (body as { error: unknown }).error
      if (typeof raw === 'string' && raw) message = raw
    }
    throw new ApiError(response.status, message)
  }
  return body as T
}

/** 当前登录用户；没登录抛 `ApiError(401)`。 */
export function fetchMe(): Promise<{ ok: true; user: User }> {
  return request('/me')
}

export function fetchOverview(): Promise<Overview> {
  return request('/overview')
}

export function fetchLicenses(): Promise<{ ok: true; licenses: License[] }> {
  return request('/licenses')
}

export function createLicense(): Promise<{ ok: true; license: License }> {
  return request('/licenses', { method: 'POST' })
}

export function toggleLicense(licenseId: string): Promise<{ ok: true; status: string }> {
  return request(`/licenses/${licenseId}/status`, { method: 'POST' })
}

export function fetchDevices(licenseId: string): Promise<{ ok: true; devices: Device[] }> {
  return request(`/licenses/${licenseId}/devices`)
}

export function unbindDevice(licenseId: string, deviceId: string): Promise<{ ok: true; removed: boolean }> {
  return request(`/licenses/${licenseId}/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
}

export function fetchNodes(): Promise<{ ok: true; nodes: Node[] }> {
  return request('/nodes')
}

export function createNode(): Promise<{ ok: true; node: Node }> {
  return request('/nodes', { method: 'POST' })
}

export function revokeNode(nodeId: string): Promise<{ ok: true }> {
  return request(`/nodes/${nodeId}`, { method: 'DELETE' })
}

/**
 * 让某台被控端换准入模式。`auto` 是把决定权交回它自己。
 *
 * 只写主控端这边的期望值，**真正生效要等它下一次上报**（最长 5 分钟）——
 * 主控端从不主动连被控端，做不到即时。
 */
/** 把一条已移除的记录彻底删掉。只在确认那台再也不会回来时用。 */
export function forgetNode(nodeId: string): Promise<{ ok: true }> {
  return request(`/nodes/${nodeId}/forget`, { method: 'DELETE' })
}

export function setNodeMode(
  nodeId: string,
  mode: 'open' | 'restricted' | 'auto',
): Promise<{ ok: true; desiredMode: string }> {
  return request(`/nodes/${nodeId}/mode?mode=${mode}`, { method: 'POST' })
}

export function setAdmissionMode(mode: 'open' | 'restricted'): Promise<{ ok: true; admissionMode: string }> {
  return request(`/settings/mode?mode=${mode}`, { method: 'POST' })
}

/** 登录：整页跳走，不走 fetch（要跟随 302 到登录系统）。 */
export function loginUrl(next = '/'): string {
  return `${API}/auth/login?next=${encodeURIComponent(next)}`
}

export async function logout(): Promise<void> {
  await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'same-origin' })
}
