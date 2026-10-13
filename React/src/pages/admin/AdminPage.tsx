/*
 * 后台页。六个只读视图 + 两个写操作（设置用户管理员、改授权状态）。
 *
 * 所有数据都来自 /api/platform/v1/admin/*，后端已有 requireAdmin 兜底；
 * 这里只负责渲染和把失败原因显示出来。
 */
import { useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@appica/ui-react/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@appica/ui-react/tabs';
import { EmptyNotice, ErrorAlert, Loading } from '../../components/Feedback';
import { PageHeading, StatTile } from '../../components/blocks';
import { DeviceStatusBadge, LicenseStatusBadge, OrderStatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { describe, useAuth } from '../../lib/auth';
import { formatDateTime, formatYuan } from '../../lib/format';
import { useResource } from '../../lib/useResource';
import type { AdminLicense, AdminUser, AuditLogRow, LicenseDevice, Order } from '../../lib/types';

export function AdminPage() {
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>后台</PageHeading>
      <ErrorAlert message={error} />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="users">用户</TabsTrigger>
          <TabsTrigger value="orders">订单</TabsTrigger>
          <TabsTrigger value="licenses">授权</TabsTrigger>
          <TabsTrigger value="devices">设备</TabsTrigger>
          <TabsTrigger value="audit">审计</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab onError={setError} />
        </TabsContent>
        <TabsContent value="orders">
          <OrdersTab />
        </TabsContent>
        <TabsContent value="licenses">
          <LicensesTab onError={setError} />
        </TabsContent>
        <TabsContent value="devices">
          <DevicesTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h2 />}>{title}</CardTitle>
      </CardHeader>
      {children}
    </Card>
  );
}

function OverviewTab() {
  const { data, error, loading } = useResource(api.adminOverview);

  if (loading) return <Loading label="正在加载概览" />;
  if (error) return <ErrorAlert message={error} />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <StatTile label="用户" value={data.userCount} />
        <StatTile label="订单" value={data.orderCount} />
        <StatTile label="已支付订单" value={data.paidOrderCount} />
        <StatTile label="授权码" value={data.licenseCount} />
        <StatTile label="生效中授权" value={data.activeLicenseCount} />
        <StatTile label="设备" value={data.deviceCount} />
        <StatTile label="累计收入" value={formatYuan(data.revenueCents)} />
      </div>

      <Panel title="最近订单">
        <OrderTable orders={data.recentOrders} />
      </Panel>

      <Panel title="最近授权">
        <Table size="sm">
          <TableHeader>
            <TableRow>
              <TableHead>授权码</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>设备</TableHead>
              <TableHead>到期时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.recentLicenses.map((license) => (
              <TableRow key={license.id}>
                <TableCell className="font-mono">{license.code}</TableCell>
                <TableCell>
                  <LicenseStatusBadge status={license.status} />
                </TableCell>
                <TableCell>{`${license.deviceCount} / ${license.deviceLimit}`}</TableCell>
                <TableCell>{formatDateTime(license.expiresAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}

function UsersTab({ onError }: { onError: (message: string | null) => void }) {
  const { data, error, loading, reload } = useResource(api.adminUsers);
  const { me, reload: reloadMe } = useAuth();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggleAdmin(user: AdminUser) {
    setBusyId(user.id);
    onError(null);
    try {
      await api.adminSetUserAdmin(user.id, !user.isAdmin);
      await reload();
      if (user.id === me?.user.id) await reloadMe();
    } catch (cause) {
      onError(describe(cause));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <Loading label="正在加载用户" />;
  if (error) return <ErrorAlert message={error} />;
  if (!data) return null;
  if (data.users.length === 0) return <EmptyNotice>还没有用户</EmptyNotice>;

  return (
    <Panel title="用户">
      <Table size="sm">
        <TableHeader>
          <TableRow>
            <TableHead>昵称</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>授权数</TableHead>
            <TableHead>订单数</TableHead>
            <TableHead>注册时间</TableHead>
            <TableHead>最近登录</TableHead>
            <TableHead className="text-end">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.users.map((user) => (
            <TableRow key={user.id}>
              <TableCell>{user.displayName || user.id}</TableCell>
              <TableCell>{user.isAdmin ? '管理员' : '普通用户'}</TableCell>
              <TableCell>{user.licenseCount}</TableCell>
              <TableCell>{user.orderCount}</TableCell>
              <TableCell>{formatDateTime(user.createdAt)}</TableCell>
              <TableCell>{formatDateTime(user.lastLoginAt)}</TableCell>
              <TableCell className="text-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId !== null}
                  onClick={() => void toggleAdmin(user)}
                >
                  {user.isAdmin ? '取消管理员' : '设为管理员'}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function OrdersTab() {
  const { data, error, loading } = useResource(api.adminOrders);

  if (loading) return <Loading label="正在加载订单" />;
  if (error) return <ErrorAlert message={error} />;
  if (!data) return null;

  return (
    <Panel title="订单">
      <OrderTable orders={data.orders} />
    </Panel>
  );
}

function LicensesTab({ onError }: { onError: (message: string | null) => void }) {
  const { data, error, loading, reload } = useResource(api.adminLicenses);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function setStatus(license: AdminLicense, status: string) {
    setBusyId(license.id);
    onError(null);
    try {
      await api.adminSetLicenseStatus(license.id, status);
      await reload();
    } catch (cause) {
      onError(describe(cause));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <Loading label="正在加载授权" />;
  if (error) return <ErrorAlert message={error} />;
  if (!data) return null;

  return (
    <Panel title="授权">
      <Table size="sm">
        <TableHeader>
          <TableRow>
            <TableHead>授权码</TableHead>
            <TableHead>归属</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>设备</TableHead>
            <TableHead>到期时间</TableHead>
            <TableHead className="text-end">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.licenses.map((license) => (
            <TableRow key={license.id}>
              <TableCell className="font-mono">{license.code}</TableCell>
              <TableCell>{license.owner || license.userId}</TableCell>
              <TableCell>
                <LicenseStatusBadge status={license.status} />
              </TableCell>
              <TableCell>{`${license.deviceCount} / ${license.deviceLimit}`}</TableCell>
              <TableCell>{formatDateTime(license.expiresAt)}</TableCell>
              <TableCell className="text-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId !== null || license.status === 'revoked'}
                  onClick={() => void setStatus(license, 'revoked')}
                >
                  吊销
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId !== null || license.status === 'active'}
                  onClick={() => void setStatus(license, 'active')}
                >
                  恢复
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function DevicesTab() {
  const { data, error, loading } = useResource(api.adminDevices);

  if (loading) return <Loading label="正在加载设备" />;
  if (error) return <ErrorAlert message={error} />;
  if (!data) return null;

  return (
    <Panel title="设备">
      <Table size="sm">
        <TableHeader>
          <TableRow>
            <TableHead>设备标识</TableHead>
            <TableHead>设备名称</TableHead>
            <TableHead>平台</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>绑定时间</TableHead>
            <TableHead>最近活跃</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.devices.map((device: LicenseDevice) => (
            <TableRow key={device.id}>
              <TableCell className="font-mono">{device.deviceId}</TableCell>
              <TableCell>{device.deviceName || '—'}</TableCell>
              <TableCell>{device.platform || '—'}</TableCell>
              <TableCell>
                <DeviceStatusBadge status={device.status} />
              </TableCell>
              <TableCell>{formatDateTime(device.boundAt)}</TableCell>
              <TableCell>{formatDateTime(device.lastSeenAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function AuditTab() {
  const { data, error, loading } = useResource(api.adminAudit);

  if (loading) return <Loading label="正在加载审计日志" />;
  if (error) return <ErrorAlert message={error} />;
  if (!data) return null;

  return (
    <Panel title="审计日志">
      <Table size="sm">
        <TableHeader>
          <TableRow>
            <TableHead>时间</TableHead>
            <TableHead>动作</TableHead>
            <TableHead>对象</TableHead>
            <TableHead>来源 IP</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.logs.map((log: AuditLogRow) => (
            <TableRow key={log.id}>
              <TableCell>{formatDateTime(log.created_at)}</TableCell>
              <TableCell className="font-mono">{log.action}</TableCell>
              <TableCell className="font-mono">{log.target || log.actor_id || '—'}</TableCell>
              <TableCell>{log.ip || '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function OrderTable({ orders }: { orders: Order[] }) {
  if (orders.length === 0) return <EmptyNotice>还没有订单</EmptyNotice>;
  return (
    <Table size="sm">
      <TableHeader>
        <TableRow>
          <TableHead>订单号</TableHead>
          <TableHead>规格</TableHead>
          <TableHead>金额</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>创建时间</TableHead>
          <TableHead>支付时间</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.id}>
            <TableCell className="font-mono">{order.outTradeNo}</TableCell>
            <TableCell>{`${order.deviceCount} 台 × ${order.months} 个月`}</TableCell>
            <TableCell>{`${order.amountYuan} 元`}</TableCell>
            <TableCell>
              <OrderStatusBadge status={order.status} />
            </TableCell>
            <TableCell>{formatDateTime(order.createdAt)}</TableCell>
            <TableCell>{formatDateTime(order.paidAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
