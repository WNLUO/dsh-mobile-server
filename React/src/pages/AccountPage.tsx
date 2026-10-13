/*
 * 个人中心。数据一次来自 GET /me（用户 + 授权 + 设备 + 订单摘要），
 * 所以这里不做额外请求，除了解绑设备后的整体刷新。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { buttonVariants } from '@appica/ui-react/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@appica/ui-react/table';
import { EmptyNotice, ErrorAlert } from '../components/Feedback';
import { LicenseCard } from '../components/LicenseCard';
import { InfoRow, PageHeading, SectionCard, StatTile } from '../components/blocks';
import { OrderStatusBadge } from '../components/StatusBadge';
import { api } from '../lib/api';
import { describe, useAuth } from '../lib/auth';
import { formatDateTime, formatYuan } from '../lib/format';

export function AccountPage() {
  const { me, reload } = useAuth();
  const [error, setError] = useState<string | null>(null);

  if (!me) return null;

  const { user, licenses, orders, stats } = me;

  async function unbind(licenseId: string, deviceId: string) {
    setError(null);
    try {
      await api.unbindDevice(licenseId, deviceId);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>个人中心</PageHeading>
      <ErrorAlert message={error} />

      <div className="flex flex-wrap gap-3">
        <StatTile label="授权码" value={stats.licenseCount} />
        <StatTile label="生效中" value={stats.activeLicenseCount} />
        <StatTile label="已绑定设备" value={stats.deviceCount} />
        <StatTile label="累计支付" value={formatYuan(stats.paidCents)} />
      </div>

      <SectionCard title="账号">
        <div>
          <InfoRow label="昵称">{user.displayName || '—'}</InfoRow>
          <InfoRow label="账号状态">{user.status === 'active' ? '正常' : user.status}</InfoRow>
          <InfoRow label="角色">{user.isAdmin ? '管理员' : '普通用户'}</InfoRow>
          <InfoRow label="注册时间">{formatDateTime(user.createdAt)}</InfoRow>
          <InfoRow label="最近登录">{formatDateTime(user.lastLoginAt)}</InfoRow>
        </div>
      </SectionCard>

      <SectionCard
        title="授权码"
        actions={
          <Link to="/licenses" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            管理
          </Link>
        }
      >
        {licenses.length === 0 ? (
          <EmptyNotice>还没有授权码</EmptyNotice>
        ) : (
          <div className="flex flex-col gap-4">
            {licenses.slice(0, 3).map((license) => (
              <LicenseCard
                key={license.id}
                license={license}
                onUnbind={(deviceId) => unbind(license.id, deviceId)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="最近订单"
        actions={
          <Link to="/orders" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            全部
          </Link>
        }
      >
        {orders.length === 0 ? (
          <EmptyNotice>还没有订单</EmptyNotice>
        ) : (
          <Table size="sm">
            <TableHeader>
              <TableRow>
                <TableHead>订单号</TableHead>
                <TableHead>设备数</TableHead>
                <TableHead>时长</TableHead>
                <TableHead>金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>创建时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.slice(0, 5).map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="font-mono">{order.outTradeNo}</TableCell>
                  <TableCell>{order.deviceCount}</TableCell>
                  <TableCell>{order.months} 个月</TableCell>
                  <TableCell>{order.amountYuan}</TableCell>
                  <TableCell>
                    <OrderStatusBadge status={order.status} />
                  </TableCell>
                  <TableCell>{formatDateTime(order.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
