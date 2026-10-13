/*
 * 订单页。这里是「支付没走完」时的唯一补救入口：
 * 未支付的订单可以再跳一次 pay_url，也可以主动向 Pay 查一次状态。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@appica/ui-react/table';
import { EmptyNotice, ErrorAlert, Loading } from '../components/Feedback';
import { PageHeading } from '../components/blocks';
import { OrderStatusBadge } from '../components/StatusBadge';
import { api } from '../lib/api';
import { describe, useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { Order } from '../lib/types';

export function OrdersPage() {
  const { reload } = useAuth();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.listOrders();
      setOrders(data.orders);
      setError(null);
    } catch (cause) {
      setOrders([]);
      setError(describe(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(id: string, action: (id: string) => Promise<Order>) {
    setPendingId(id);
    setError(null);
    try {
      await action(id);
      await load();
      await reload();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPendingId(null);
    }
  }

  const busy = pendingId !== null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>订单</PageHeading>
      <ErrorAlert message={error} />

      {orders === null ? (
        <Loading label="正在加载订单" />
      ) : orders.length === 0 ? (
        <EmptyNotice>还没有订单</EmptyNotice>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单号</TableHead>
              <TableHead>规格</TableHead>
              <TableHead>金额</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>支付时间</TableHead>
              <TableHead className="text-end">操作</TableHead>
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
                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {order.status !== 'paid' && order.payUrl ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.location.assign(order.payUrl as string)}
                      >
                        去支付
                      </Button>
                    ) : null}
                    {order.status !== 'paid' ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void run(order.id, api.syncOrder)}
                        >
                          同步
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void run(order.id, api.closeOrder)}
                        >
                          关闭
                        </Button>
                      </>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
