/*
 * 一张授权码卡片：码本身（可复制）、有效期、设备名额、已绑定设备。
 *
 * 设备解绑走 DELETE /licenses/:id/devices/:deviceId，成功后后端会回整张授权，
 * 由调用方负责刷新（onUnbind 的 promise 由父组件决定怎么处理）。
 */
import { useState } from 'react';
import { CopyButton } from '@appica/ui-react/copy-button';
import { Button } from '@appica/ui-react/button';
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@appica/ui-react/table';
import { DeviceStatusBadge, LicenseStatusBadge } from './StatusBadge';
import { EmptyNotice } from './Feedback';
import { describe } from '../lib/auth';
import { formatDateTime, formatCount } from '../lib/format';
import type { License } from '../lib/types';

export function LicenseCard({
  license,
  onUnbind,
}: {
  license: License;
  onUnbind?: (deviceId: string) => Promise<unknown>;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function unbind(deviceId: string) {
    if (!onUnbind) return;
    setPendingId(deviceId);
    setError(null);
    try {
      await onUnbind(deviceId);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle render={<h3 />} className="font-mono">
            {license.code}
          </CardTitle>
          <div className="flex items-center gap-2">
            <LicenseStatusBadge status={license.status} />
            <CopyButton value={license.code} icon={null} size="sm" variant="outline" label="复制授权码" copiedLabel="已复制">
              复制
            </CopyButton>
          </div>
        </div>
      </CardHeader>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-foreground-muted">
        <span>到期 {formatDateTime(license.expiresAt)}</span>
        <span>
          设备 {formatCount(license.deviceCount)} / {formatCount(license.deviceLimit)}
        </span>
        <span>时长 {formatCount(license.months)} 个月</span>
      </div>

      {error ? <p className="text-error-foreground">{error}</p> : null}

      {license.devices.length === 0 ? (
        <EmptyNotice>还没有绑定设备</EmptyNotice>
      ) : (
        <Table size="sm">
          <TableHeader>
            <TableRow>
              <TableHead>设备标识</TableHead>
              <TableHead>设备名称</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>绑定时间</TableHead>
              <TableHead>最近活跃</TableHead>
              {onUnbind ? <TableHead className="text-end">操作</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {license.devices.map((device) => (
              <TableRow key={device.id}>
                <TableCell className="font-mono">{device.deviceId}</TableCell>
                <TableCell>{device.deviceName || '—'}</TableCell>
                <TableCell>
                  <DeviceStatusBadge status={device.status} />
                </TableCell>
                <TableCell>{formatDateTime(device.boundAt)}</TableCell>
                <TableCell>{formatDateTime(device.lastSeenAt)}</TableCell>
                {onUnbind ? (
                  <TableCell className="text-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={device.status !== 'active' || pendingId !== null}
                      onClick={() => void unbind(device.deviceId)}
                    >
                      解绑
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
