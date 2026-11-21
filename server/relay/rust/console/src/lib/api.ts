/** 节点新鲜度使用同源响应时间，管理写入错误保持为失败响应。 */
/**
 * 控制台的接口层：同源会话请求统一超时、取消和响应校验。
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
  /** 主控端希望它用的模式；空值表示交还被控端自己决定。 */
  desiredMode: string | null
  /** 被主控端移除的时间。有值只剩一条记录给人看，不能再下发任何东西。 */
  revokedAt: string | null
  licenseCount: number
  deviceCount: number
  tunnelOnline: boolean
  /** 与 lastSeenAt 来自同一次上报；旧节点未报告时为空。 */
  reportIntervalSeconds: number | null
  lastSeenAt: string | null
  createdAt: string
}

export interface Overview {
  ok: true
  serverTime: string
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
  /** 这台中转跑的是哪一版。 */
  version: string
  /** 自动更新：开没开、源、待验证版本、以及上一轮失败后的停手记录。 */
  selfUpdate: {
    enabled: boolean
    sources: string[]
    intervalSeconds: number
    /** 换上去但还没验明的版本；空＝没有待验证的升级。 */
    pending: string
    /** 最后一次验明成功的版本。 */
    confirmed: string
    /** 非空＝上一轮升级失败、已经停手，等人处理。 */
    rollback: string
  }
}

/** 业务错误：带着中转回的那句人话。 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** 网络失败可能发生在服务端已接收写入之后，调用方不能自动重发。 */
export class NetworkError extends Error {}

export function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const external = init.signal
  let timedOut = false
  if (external?.aborted) controller.abort()
  else external?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 15_000)
  try {
    const response = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError')
    if (response.status === 401) throw new ApiError(401, '登录已过期，请重新登录。')
    if (response.status === 204) return undefined as T
    // 超时覆盖正文读取，不能只等到响应头就撤掉计时器。
    const text = await response.text()
    if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError')
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      if (response.ok) throw new NetworkError('响应不是有效的 JSON，请重试。')
    }
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      if (body && typeof body === 'object' && 'error' in body) {
        const raw = (body as { error: unknown }).error
        if (typeof raw === 'string' && raw) message = raw
      }
      throw new ApiError(response.status, message)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new NetworkError('响应内容不完整，请重试。')
    }
    return body as T
  } catch (error) {
    if (external?.aborted) throw new DOMException('请求已取消', 'AbortError')
    if (timedOut) throw new NetworkError('请求超时，请重试。')
    if (error instanceof ApiError || error instanceof NetworkError) throw error
    throw new NetworkError('网络异常，请重试。')
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', cancel)
    controller.abort()
  }
}

/** 当前登录用户；没登录抛 `ApiError(401)`。 */
export function fetchMe(signal?: AbortSignal): Promise<{ ok: true; user: User }> {
  return request('/me', { signal })
}

export function fetchOverview(signal?: AbortSignal): Promise<Overview> {
  return request('/overview', { signal })
}

export function fetchLicenses(signal?: AbortSignal): Promise<{ ok: true; licenses: License[] }> {
  return request('/licenses', { signal })
}

export function createLicense(signal?: AbortSignal): Promise<{ ok: true; license: License }> {
  return request('/licenses', { method: 'POST', signal })
}

export function toggleLicense(licenseId: string, signal?: AbortSignal): Promise<{ ok: true; status: string }> {
  return request(`/licenses/${licenseId}/status`, { method: 'POST', signal })
}

export function fetchDevices(licenseId: string, signal?: AbortSignal): Promise<{ ok: true; devices: Device[] }> {
  return request(`/licenses/${licenseId}/devices`, { signal })
}

export function unbindDevice(licenseId: string, deviceId: string, signal?: AbortSignal): Promise<{ ok: true; removed: boolean }> {
  return request(`/licenses/${licenseId}/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', signal })
}

export function fetchNodes(signal?: AbortSignal): Promise<{ ok: true; nodes: Node[]; serverTime: string }> {
  return request('/nodes', { signal })
}

export function createNode(signal?: AbortSignal): Promise<{ ok: true; node: Node }> {
  return request('/nodes', { method: 'POST', signal })
}

export function revokeNode(nodeId: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return request(`/nodes/${nodeId}`, { method: 'DELETE', signal })
}

/** 把一条已移除的记录彻底删掉。只在确认那台再也不会回来时用。 */
export function forgetNode(nodeId: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return request(`/nodes/${nodeId}/forget`, { method: 'DELETE', signal })
}

/** 只写期望值，真正生效要等被控端下一次上报；auto 把决定权交回它自己。 */
export function setNodeMode(
  nodeId: string,
  mode: 'open' | 'restricted' | 'auto',
  signal?: AbortSignal,
): Promise<{ ok: true; desiredMode: string }> {
  return request(`/nodes/${nodeId}/mode?mode=${mode}`, { method: 'POST', signal })
}

export function setAdmissionMode(mode: 'open' | 'restricted', signal?: AbortSignal): Promise<{ ok: true; admissionMode: string }> {
  return request(`/settings/mode?mode=${mode}`, { method: 'POST', signal })
}

/** 登录：整页跳走，不走 fetch（要跟随 302 到登录系统）。 */
export function loginUrl(next = '/'): string {
  return `${API}/auth/login?next=${encodeURIComponent(next)}`
}

export async function logout(signal?: AbortSignal): Promise<void> {
  await request('/auth/logout', { method: 'POST', signal })
}
