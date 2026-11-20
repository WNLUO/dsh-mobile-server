/** 控制台请求生命周期、动作确认与可见页刷新共用同一个串行入口。 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError, NetworkError, fetchDevices, fetchLicenses, fetchMe, fetchNodes, fetchOverview,
  isCancelled, logout, type Device, type License, type Node, type Overview, type User,
} from './api.ts'

type Scope = {
  active: boolean
  user: User | null
  signedOut: boolean
  selected: License | null
  reading: Promise<boolean> | null
  readController: AbortController | null
  actionController: AbortController | null
  working: boolean
  locked: boolean
}

export type ConsoleAction = (signal: AbortSignal) => Promise<void>

function message(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return '这个账号不是管理员，看不到激活码。让搭建这台中转的人登录来管。'
  }
  return error instanceof Error ? error.message : String(error)
}

/** 周期与最近上报属于节点自身的同一快照，不借主控端周期猜在线。 */
export function nodeStatus(node: Node, now: number): { online: boolean; text: string } {
  if (node.revokedAt) return { online: false, text: '已移除' }
  if (!node.lastSeenAt) return { online: false, text: '尚未上报' }
  const last = Date.parse(node.lastSeenAt)
  if (!Number.isFinite(last) || last > now) return { online: false, text: '上报时间异常' }
  const interval = node.reportIntervalSeconds
  if (!interval || !Number.isFinite(interval) || interval <= 0) {
    return { online: false, text: '上报周期未知' }
  }
  const age = now - last
  if (age > interval * 3_000) {
    return { online: false, text: `失联 ${Math.max(1, Math.floor(age / 60_000))} 分钟` }
  }
  return { online: node.tunnelOnline, text: node.tunnelOnline ? '隧道在线' : '隧道离线' }
}

export function useConsole() {
  const scopeRef = useRef<Scope | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const [checking, setChecking] = useState(true)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [licenses, setLicenses] = useState<License[]>([])
  const [nodes, setNodes] = useState<Node[]>([])
  const [selected, setSelected] = useState<License | null>(null)
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(Date.now())

  const clearSession = useCallback((scope: Scope) => {
    if (!scope.active) return
    scope.user = null
    scope.signedOut = true
    scope.selected = null
    scope.locked = false
    setUser(null)
    setSignedOut(true)
    setOverview(null)
    setLicenses([])
    setNodes([])
    setSelected(null)
    setDevices(null)
    setNeedsRefresh(false)
    setError('')
  }, [])

  const read = useCallback((scope: Scope, quiet = false, failurePrefix = ''): Promise<boolean> => {
    if (!scope.active) return Promise.resolve(false)
    if (scope.reading) return scope.reading
    const controller = new AbortController()
    scope.readController = controller
    const selectedId = scope.selected?.id
    setRefreshing(true)
    setNow(Date.now())
    const pending = (async () => {
      try {
        if (!scope.user) {
          const me = await fetchMe(controller.signal)
          if (!me.user || typeof me.user.id !== 'string') throw new NetworkError('登录信息不完整，请重试。')
          if (!scope.active || controller.signal.aborted) return false
          scope.user = me.user
          scope.signedOut = false
          setUser(me.user)
          setSignedOut(false)
        }
        const [nextOverview, nextLicenses] = await Promise.all([
          fetchOverview(controller.signal), fetchLicenses(controller.signal),
        ])
        if (!Array.isArray(nextLicenses.licenses) || typeof nextOverview.role !== 'string') {
          throw new NetworkError('控制台数据不完整，请重试。')
        }
        const [nextNodes, nextDevices] = await Promise.all([
          nextOverview.role === 'master' ? fetchNodes(controller.signal) : Promise.resolve({ nodes: [] }),
          selectedId ? fetchDevices(selectedId, controller.signal) : Promise.resolve(null),
        ])
        if (!Array.isArray(nextNodes.nodes) || (nextDevices && !Array.isArray(nextDevices.devices))) {
          throw new NetworkError('列表数据不完整，请重试。')
        }
        if (!scope.active || controller.signal.aborted) return false
        setNow(Date.now())
        setOverview(nextOverview)
        setLicenses(nextLicenses.licenses)
        setNodes(nextNodes.nodes)
        if (scope.selected?.id === selectedId) setDevices(nextDevices?.devices ?? null)
        scope.locked = false
        setNeedsRefresh(false)
        setError('')
        return true
      } catch (error) {
        if (!scope.active || controller.signal.aborted || isCancelled(error)) return false
        if (error instanceof ApiError && error.status === 401) clearSession(scope)
        else if (!quiet || scope.locked) setError(`${failurePrefix}${message(error)}`)
        return false
      } finally {
        // Promise.all 一路失败后也结束同轮其它请求，旧轮不能覆盖后来的状态。
        controller.abort()
        if (scope.readController === controller) {
          scope.readController = null
          scope.reading = null
          if (scope.active) setRefreshing(false)
        }
      }
    })()
    scope.reading = pending
    return pending
  }, [clearSession])

  const refresh = useCallback(async () => {
    const scope = scopeRef.current
    if (scope?.active && !scope.working) await read(scope)
  }, [read])

  const run = useCallback(async (action: ConsoleAction, signingOut = false) => {
    const scope = scopeRef.current
    if (!scope?.active || scope.working || (scope.locked && !signingOut) || !scope.user) return
    scope.working = true
    setWorking(true)
    setError('')
    // 动作开始前终止旧快照，动作后的刷新一定重新发起。
    scope.readController?.abort()
    await scope.reading
    if (!scope.active || !scope.user) {
      scope.working = false
      if (scope.active) setWorking(false)
      return
    }
    const controller = new AbortController()
    scope.actionController = controller
    try {
      await action(controller.signal)
      if (!scope.active || controller.signal.aborted) return
      if (signingOut) {
        clearSession(scope)
        return
      }
      scope.locked = true
      setNeedsRefresh(true)
      await read(scope, false, '操作已完成，刷新失败，可点刷新重试。')
    } catch (error) {
      if (!scope.active || controller.signal.aborted || isCancelled(error)) return
      if (error instanceof ApiError && error.status === 401) {
        clearSession(scope)
      } else if (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)) {
        // 写入是否到达服务端无法据网络错误判断；只读回状态，绝不重发动作。
        scope.locked = true
        setNeedsRefresh(true)
        const confirmed = await read(scope, false, '操作结果尚未确认，请先刷新核对。')
        if (confirmed && scope.active) setError('操作结果尚未确认，已刷新当前状态，请核对后再操作。')
      } else {
        setError(message(error))
      }
    } finally {
      scope.actionController = null
      scope.working = false
      if (scope.active) setWorking(false)
    }
  }, [clearSession, read])

  const chooseLicense = useCallback((license: License | null) => {
    const scope = scopeRef.current
    if (!scope?.active || scope.working) return
    scope.selected = license
    setSelected(license)
    setDevices(null)
    scope.readController?.abort()
    void (async () => {
      await scope.reading
      if (scope.active && !scope.working) await read(scope)
    })()
  }, [read])

  useEffect(() => {
    const scope: Scope = {
      active: true, user: null, signedOut: false, selected: null, reading: null,
      readController: null, actionController: null, working: false, locked: false,
    }
    scopeRef.current = scope
    void read(scope).finally(() => { if (scope.active) setChecking(false) })
    const poll = () => {
      if (document.visibilityState !== 'visible' || scope.working || scope.reading || scope.signedOut) return
      void read(scope, true)
    }
    const timer = setInterval(poll, 30_000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      scope.active = false
      scope.readController?.abort()
      scope.actionController?.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [read])

  return {
    user, signedOut, checking, overview, licenses, nodes, selected, devices, error, now,
    busy: working || needsRefresh, working, refreshing, refresh, run, chooseLicense,
    signOut: () => run(logout, true),
  }
}
