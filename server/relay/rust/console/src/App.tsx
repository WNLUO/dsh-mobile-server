import { Spinner } from '@appica/ui-react/spinner'
import { useCallback, useEffect, useState } from 'react'

import { admissionText, admissionTone, licenseText, licenseTone, timeText } from './lib/format.ts'
import {
  ApiError,
  createLicense,
  fetchDevices,
  fetchLicenses,
  createNode,
  fetchMe,
  fetchNodes,
  fetchOverview,
  forgetNode,
  revokeNode,
  loginUrl,
  setAdmissionMode,
  setNodeMode,
  toggleLicense,
  unbindDevice,
  type Device,
  type License,
  type Node,
  type Overview,
  type User,
} from './lib/api.ts'
import { Card, Dot, Empty, InfoList, InfoRow, ToneValue } from './components/blocks.tsx'

/**
 * 中转控制台。
 *
 * 四块内容按「先看状态、再管准入、再看码、最后看设备」排——搭的人打开这一页最先要知道
 * 的是「我的中转活着吗、现在谁能用」，而不是一上来就发码。
 *
 * 没登录时只显示一个微信登录按钮：控制台的账号就是微信账号，第一个登录的人自动是管理员
 * （中转端 `upsert_user` 定的规则），这一页不重复判断权限，403 由接口回。
 */
export function App() {
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(true)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [licenses, setLicenses] = useState<License[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<License | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])

  // 被主控端接管准入模式时，本地面板不许再改——改了下一轮也会被掰回去，
  // 「点了没反应」比灰着更难理解。
  const controlled = overview?.modeControlled === true

  const load = useCallback(async () => {
    setError('')
    try {
      const [nextOverview, nextLicenses] = await Promise.all([fetchOverview(), fetchLicenses()])
      setOverview(nextOverview)
      setLicenses(nextLicenses.licenses)
      // 被控端列表只有这台是「主控端」时才有意义；被控端自己的库是空的。
      const nextNodes = nextOverview.role === 'master' ? await fetchNodes() : { nodes: [] }
      setNodes(nextNodes.nodes)
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setError('这个账号不是管理员，看不到激活码。让搭建这台中转的人登录来管。')
        return
      }
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const me = await fetchMe()
        if (!alive) return
        setUser(me.user)
        await load()
      } catch {
        if (alive) setUser(null)
      } finally {
        if (alive) setChecking(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [load])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center gap-2 p-6 text-sm text-foreground-muted">
        <Spinner />
        正在读取控制台…
      </main>
    )
  }

  if (!user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-semibold text-foreground-strong">DSH 中转控制台</h1>
        <p className="text-sm text-foreground-muted">
          用微信登录来管理这台中转。第一个登录的账号会自动成为管理员。
        </p>
        <a
          className="rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-accent-foreground"
          href={loginUrl('/')}
        >
          微信登录
        </a>
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground-strong">DSH 中转控制台</h1>
          <p className="text-xs text-foreground-muted">
            {user.displayName || user.subject}
            {user.isAdmin ? ' · 管理员' : ''}
          </p>
        </div>
        <button
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground-muted"
          type="button"
          onClick={() => void run(load)}
          disabled={busy}
        >
          刷新
        </button>
      </header>

      {error ? (
        <p className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">{error}</p>
      ) : null}

      <Card title="运行状态" description="这一页只说明中转活着没、宿主连上没，不显示任何密钥。">
        <InfoList>
          <InfoRow label="中转服务">
            <ToneValue tone="ok" text="在线" />
          </InfoRow>
          <InfoRow label="桌面隧道">
            {overview?.tunnelConnected ? (
              <ToneValue tone="ok" text="已连接" />
            ) : (
              <ToneValue tone="off" text="未连接" detail="宿主还没连上来，或者刚好在重连" />
            )}
          </InfoRow>
          <InfoRow label="激活码">
            {overview ? `${overview.activeLicenseCount} 个有效 / 共 ${overview.licenseCount} 个` : '—'}
          </InfoRow>
          <InfoRow label="已绑定设备">{overview?.deviceCount ?? 0} 台</InfoRow>
        </InfoList>
      </Card>

      <Card
        title="准入模式"
        description="决定谁能让自己的电脑挂到这台中转上。手机配对与设备凭据始终由宿主自己管，这里只管「谁能建隧道」。"
      >
        <InfoList>
          <InfoRow label="当前模式" tone={admissionTone(overview?.admissionMode ?? 'open')}>
            <span className="inline-flex items-center gap-2">
              <Dot tone={admissionTone(overview?.admissionMode ?? 'open')} />
              {admissionText(overview?.admissionMode ?? 'open')}
            </span>
          </InfoRow>
        </InfoList>
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-xs"
            type="button"
            disabled={busy || !user.isAdmin || controlled}
            onClick={() => void run(async () => void (await setAdmissionMode('open')))}
          >
            设为开放
          </button>
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-xs"
            type="button"
            disabled={busy || !user.isAdmin || controlled}
            onClick={() => void run(async () => void (await setAdmissionMode('restricted')))}
          >
            设为限制
          </button>
        </div>
        <p className="mt-3 text-xs text-foreground-muted">
          {controlled
            ? '这台被控端的准入模式由它的主控端管理，这里改不了——能改也不会生效，下一轮上报就会被改回去。'
            : '限制模式下，没带有效激活码的隧道会在握手阶段被拒（连不上），宿主需要在它的中转配置里填码。'}
        </p>
      </Card>

      <Card
        title="激活码"
        description="一个码绑一台设备。换设备时先解绑，再把同一个码填到新设备上。"
        actions={
          <button
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
            type="button"
            disabled={busy || !user.isAdmin}
            onClick={() => void run(async () => void (await createLicense()))}
          >
            生成激活码
          </button>
        }
      >
        {licenses.length === 0 ? (
          <Empty>还没有激活码。开放模式下不需要码；要开始限制就先生成一个。</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {licenses.map((license) => (
              <li key={license.id} className="rounded-lg border border-border-muted p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <code className="font-mono text-sm text-foreground-strong">{license.code}</code>
                  <span className="inline-flex items-center gap-2 text-xs">
                    <Dot tone={licenseTone(license.status)} />
                    <span className={licenseTone(license.status) === 'ok' ? 'text-success' : 'text-foreground-muted'}>
                      {licenseText(license.status)}
                    </span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-foreground-muted">生成于 {timeText(license.createdAt)}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    className="rounded-md border border-border px-2 py-1 text-xs"
                    type="button"
                    disabled={busy}
                    onClick={() => setSelected(license)}
                  >
                    看设备
                  </button>
                  <button
                    className="rounded-md border border-border px-2 py-1 text-xs"
                    type="button"
                    disabled={busy}
                    onClick={() => void run(async () => void (await toggleLicense(license.id)))}
                  >
                    {license.status === 'active' ? '吊销' : '恢复'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {overview?.role === 'slave' ? (
        <Card title="这台是被控端" description="它把自己的状态报给主控端，自己不收别人的上报。">
          <InfoList>
            <InfoRow label="主控端" mono>
              {overview.masterUrl || '—'}
            </InfoRow>
            <InfoRow label="上报">
              {overview.masterLastError ? (
                <ToneValue tone="error" text="最近一次失败" detail={overview.masterLastError} />
              ) : (
                <ToneValue
                  tone={overview.masterLastReportAt ? 'ok' : 'warn'}
                  text={overview.masterLastReportAt ? '正常' : '还没报成功过'}
                  detail={overview.masterLastReportAt ? `上次 ${timeText(overview.masterLastReportAt)}` : undefined}
                />
              )}
            </InfoRow>
            <InfoRow label="上报周期">每 {Math.round((overview.reportIntervalSeconds || 300) / 60)} 分钟一次</InfoRow>
          </InfoList>
          <p className="mt-3 text-xs text-foreground-muted">
            {overview.modeControlled
              ? '准入模式由主控端管理，这里改不了——要自己管，让主控端把它「交还给它」。'
              : '准入模式目前由这台自己管。主控端一旦下发，就会接管。'}
          </p>
          <p className="mt-2 text-xs text-foreground-muted">
            要让它自成一体的中转，去掉配置里的 PLATFORM_MASTER_URL 再重启。
          </p>
        </Card>
      ) : (
        <Card
          title="被控端"
          description="把认领码填到另一台中转的配置里，它就会定期把状态报到这台来。主控端只收状态，不碰它的隧道流量。"
          actions={
            <button
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
              type="button"
              disabled={busy || !user.isAdmin}
              onClick={() => void run(async () => void (await createNode()))}
            >
              生成认领码
            </button>
          }
        >
          {nodes.length === 0 ? (
            <Empty>还没有被控端。生成一个认领码，填到那台中转的配置里。</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {nodes.map((node) => (
                <li key={node.id} className="rounded-lg border border-border-muted p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-foreground-strong">
                      {node.name || '（还没报到过）'}
                      {node.revokedAt ? <span className="ml-2 text-xs text-foreground-muted">已移除</span> : null}
                    </span>
                    <span className="inline-flex items-center gap-2 text-xs">
                      <Dot tone={node.tunnelOnline ? 'ok' : 'off'} />
                      <span className={node.tunnelOnline ? 'text-success' : 'text-foreground-muted'}>
                        {node.tunnelOnline ? '隧道在线' : '隧道离线'}
                      </span>
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-foreground-muted">{node.claimCode}</p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    {node.publicUrl || '—'} · 码 {node.licenseCount} 个 · 设备 {node.deviceCount} 台 · 最近 {timeText(node.lastSeenAt)}
                  </p>
                  {node.revokedAt ? (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border-muted pt-2 text-xs">
                      <span className="text-foreground-muted">
                        已于 {timeText(node.revokedAt)} 移除 · 它再上报会被拒（403）
                      </span>
                      <button
                        className="rounded-md border border-border px-2 py-1"
                        type="button"
                        disabled={busy || !user.isAdmin}
                        onClick={() => void run(async () => void (await forgetNode(node.id)))}
                      >
                        彻底删除这条记录
                      </button>
                    </div>
                  ) : (
                    <NodeModeControl node={node} busy={busy} isAdmin={user.isAdmin} onRun={run} />
                  )}
                  {node.revokedAt ? null : (
                    <button
                      className="mt-2 rounded-md border border-border px-2 py-1 text-xs"
                      type="button"
                      disabled={busy}
                      onClick={() => void run(async () => void (await revokeNode(node.id)))}
                    >
                      移除这台
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {selected ? <DevicePanel license={selected} onClose={() => setSelected(null)} onChanged={load} /> : null}
    </main>
  )
}

/**
 * 一台被控端的准入模式：主控端希望它用哪个，它现在实际在用什么。
 *
 * 两个值分开显示是**故意**的：主控端只写期望值，真正生效要等那台下一次上报
 * （最长 5 分钟，主控端从不主动连它）。只显示一个「当前模式」会让点完按钮的人
 * 以为坏了；并排显示「已下发」和「它现在」，等待窗口就是自解释的。
 */
function NodeModeControl({
  node,
  busy,
  isAdmin,
  onRun,
}: {
  node: Node
  busy: boolean
  isAdmin: boolean
  onRun: (action: () => Promise<void>) => Promise<void>
}) {
  // 空串＝主控端不管这台，它用自己的设置。
  const desired = node.desiredMode === 'open' || node.desiredMode === 'restricted' ? node.desiredMode : null
  const pending = desired !== null && desired !== node.admissionMode
  const set = (mode: 'open' | 'restricted' | 'auto') =>
    void onRun(async () => void (await setNodeMode(node.id, mode)))

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border-muted pt-2 text-xs">
      <span className="text-foreground-muted">它现在</span>
      <span className="inline-flex items-center gap-1">
        <Dot tone={admissionTone(node.admissionMode)} />
        {admissionText(node.admissionMode)}
      </span>
      <span className="text-foreground-muted">· 已下发</span>
      <span className={pending ? 'text-warning' : 'text-foreground-muted'}>
        {desired ? admissionText(desired) : '不管（由它自己决定）'}
        {pending ? '（等它下次上报）' : ''}
      </span>
      <span className="flex flex-wrap gap-1">
        <button
          className="rounded-md border border-border px-2 py-1"
          type="button"
          disabled={busy || !isAdmin}
          onClick={() => set('open')}
        >
          开放
        </button>
        <button
          className="rounded-md border border-border px-2 py-1"
          type="button"
          disabled={busy || !isAdmin}
          onClick={() => set('restricted')}
        >
          限制
        </button>
        <button
          className="rounded-md border border-border px-2 py-1"
          type="button"
          disabled={busy || !isAdmin}
          onClick={() => set('auto')}
        >
          交还给它
        </button>
      </span>
    </div>
  )
}

/**
 * 某个码绑了哪些设备。
 *
 * 解绑是**允许改绑**规则的落点：名额只算活跃设备，解绑之后同一个码就能绑到新设备。
 */
function DevicePanel({
  license,
  onClose,
  onChanged,
}: {
  license: License
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const result = await fetchDevices(license.id)
      setDevices(result.devices)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [license.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <Card
      title={`设备 · ${license.code}`}
      description="解绑之后这个码就能绑到新设备。"
      actions={
        <button className="rounded-lg border border-border px-3 py-1.5 text-xs" type="button" onClick={onClose}>
          收起
        </button>
      }
    >
      {error ? <p className="py-2 text-sm text-error">{error}</p> : null}
      {devices === null ? (
        <p className="flex items-center gap-2 py-4 text-sm text-foreground-muted">
          <Spinner />
          正在读取设备…
        </p>
      ) : devices.length === 0 ? (
        <Empty>这个码还没绑设备。把它填到宿主的「中转激活码」里，第一次连上就会绑住这台机器。</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-muted p-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground-strong">{device.deviceName || device.deviceId}</p>
                <p className="text-xs text-foreground-muted">
                  {device.platform || '未知平台'} · 绑定于 {timeText(device.boundAt)} · 最近 {timeText(device.lastSeenAt)}
                </p>
              </div>
              <button
                className="rounded-md border border-border px-2 py-1 text-xs"
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  setError('')
                  void unbindDevice(license.id, device.deviceId)
                    .then(refresh)
                    .then(onChanged)
                    .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setBusy(false))
                }}
              >
                解绑
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
