/*
 * 支付页。
 *
 * Pay 只提供微信 JSAPI（没有扫码 / code_url 可轮询），所以这里的做法是：
 * 下单拿到 pay_url → 让浏览器直接跳过去（在微信里就是拉起收银台，在 PC 上
 * Pay 的收银台自己会渲染二维码）→ 回到本页由轮询 /orders/:id/sync 补账。
 * 支付成功后的授权码也从后端拿，前端不猜。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Input } from '@appica/ui-react/input';
import { Field, FieldLabel } from '@appica/ui-react/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@appica/ui-react/select';
import { EmptyNotice, ErrorAlert, Loading } from '../components/Feedback';
import { InfoRow, PageHeading, SectionCard } from '../components/blocks';
import { OrderStatusBadge } from '../components/StatusBadge';
import { api, ApiError } from '../lib/api';
import { describe, useAuth } from '../lib/auth';
import { formatDateTime, formatYuan } from '../lib/format';
import type { License, Order, PricingPlans } from '../lib/types';

const POLL_INTERVAL_MS = 5000;

export function BuyPage() {
  const { reload } = useAuth();
  const [plans, setPlans] = useState<PricingPlans | null>(null);
  const [deviceCount, setDeviceCount] = useState('1');
  const [months, setMonths] = useState('1');
  const [order, setOrder] = useState<Order | null>(null);
  const [license, setLicense] = useState<License | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .config()
      .then((config) => {
        if (alive) setPlans(config.pricing);
      })
      .catch((cause) => {
        if (alive) setError(describe(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  const orderId = order?.id ?? null;
  const pending = order?.status === 'created' || order?.status === 'paying';

  // 支付期间的轮询：Pay 的通知可能晚到或丢失，主动查一次是唯一可靠的兜底。
  useEffect(() => {
    if (!orderId || !pending) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const next = await api.syncOrder(orderId);
          if (!alive) return;
          setOrder(next);
          if (next.status === 'paid' && next.licenseId) {
            setLicense(await api.getLicense(next.licenseId));
            await reload();
          }
        } catch {
          // 单次轮询失败不打断，下一轮继续。
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [orderId, pending, reload]);

  const syncNow = useCallback(async () => {
    if (!orderId) return;
    setSyncing(true);
    setError(null);
    try {
      const next = await api.syncOrder(orderId);
      setOrder(next);
      if (next.status === 'paid' && next.licenseId) {
        setLicense(await api.getLicense(next.licenseId));
        await reload();
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSyncing(false);
    }
  }, [orderId, reload]);

  async function submit() {
    setBusy(true);
    setError(null);
    setLicense(null);
    try {
      const created = await api.createOrder({
        deviceCount: Number(deviceCount),
        months: Number(months),
      });
      setOrder(created);
      await reload();
    } catch (cause) {
      // 502 PAY_UNAVAILABLE 时本地订单已经落库，提示用户去订单页重试而不是重复下单。
      if (cause instanceof ApiError && cause.code === 'PAY_UNAVAILABLE') {
        setError(`${cause.message}（订单已保留，可在「订单」里重新发起支付）`);
      } else {
        setError(describe(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!plans) return <Loading label="正在读取价格" />;

  const devices = Number(deviceCount) || 0;
  const term = Number(months) || 0;
  const amountCents = devices * term * plans.unitCents;

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>购买授权</PageHeading>
      <ErrorAlert message={error} />

      <SectionCard title="选择规格">
        <div className="flex flex-wrap items-end gap-4">
          <Field className="w-40">
            <FieldLabel>设备数量</FieldLabel>
            <Input
              type="number"
              min={1}
              max={plans.maxDevices}
              value={deviceCount}
              onChange={(event) => setDeviceCount(event.target.value)}
            />
          </Field>

          <Field className="w-40">
            <FieldLabel>购买月数</FieldLabel>
            <Select value={months} onValueChange={(value) => setMonths(String(value))}>
              <SelectTrigger>
                <SelectValue placeholder="选择月数" />
              </SelectTrigger>
              <SelectContent>
                {plans.months.map((item) => (
                  <SelectItem key={item.months} value={String(item.months)}>
                    {`${item.months} 个月 · ${item.amountYuan} 元 / 台`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="text-foreground-intense pb-2 text-2xl font-semibold">
            {formatYuan(amountCents)}
          </div>

          <Button
            variant="primary"
            size="md"
            disabled={busy || devices < 1 || term < 1 || devices > plans.maxDevices}
            onClick={() => void submit()}
          >
            {busy ? '正在下单' : '提交订单'}
          </Button>
        </div>
        <p className="text-foreground-muted">
          {`单价 ${plans.unitYuan} 元 / 台 / 月，单次最多 ${plans.maxDevices} 台、${plans.maxMonths} 个月`}
        </p>
      </SectionCard>

      {order ? (
        <SectionCard title="当前订单" actions={<OrderStatusBadge status={order.status} />}>
          <div>
            <InfoRow label="订单号">
              <span className="font-mono">{order.outTradeNo}</span>
            </InfoRow>
            <InfoRow label="规格">{`${order.deviceCount} 台 × ${order.months} 个月`}</InfoRow>
            <InfoRow label="金额">{`${order.amountYuan} 元`}</InfoRow>
            <InfoRow label="创建时间">{formatDateTime(order.createdAt)}</InfoRow>
            <InfoRow label="支付时间">{order.paidAt ? formatDateTime(order.paidAt) : '—'}</InfoRow>
          </div>

          {order.status === 'paid' ? (
            license ? (
              <div className="flex flex-col gap-2">
                <InfoRow label="授权码">
                  <span className="font-mono">{license.code}</span>
                </InfoRow>
                <InfoRow label="到期时间">{formatDateTime(license.expiresAt)}</InfoRow>
              </div>
            ) : (
              <EmptyNotice>支付已完成</EmptyNotice>
            )
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {order.payUrl ? (
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => window.location.assign(order.payUrl as string)}
                >
                  去支付
                </Button>
              ) : null}
              <Button variant="outline" size="md" disabled={syncing} onClick={() => void syncNow()}>
                {syncing ? '正在同步' : '同步支付状态'}
              </Button>
            </div>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
