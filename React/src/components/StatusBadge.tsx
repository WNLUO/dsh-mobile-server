/*
 * 订单 / 授权 / 设备状态的色块。集中一处，避免各页面各写一份映射。
 */
import { Badge } from '@appica/ui-react/badge';
import { LICENSE_STATUS_LABEL, ORDER_STATUS_LABEL } from '../lib/format';

type BadgeVariant = 'primary' | 'secondary' | 'soft' | 'outline' | 'success' | 'warning' | 'error' | 'info' | 'light';

const ORDER_VARIANT: Record<string, BadgeVariant> = {
  created: 'warning',
  paying: 'info',
  paid: 'success',
  closed: 'outline',
};

const LICENSE_VARIANT: Record<string, BadgeVariant> = {
  active: 'success',
  revoked: 'error',
  expired: 'outline',
};

const DEVICE_LABEL: Record<string, string> = {
  active: '已绑定',
  unbound: '已解绑',
};

export function OrderStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={ORDER_VARIANT[status] ?? 'soft'} size="sm">
      {ORDER_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function LicenseStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={LICENSE_VARIANT[status] ?? 'soft'} size="sm">
      {LICENSE_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function DeviceStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={status === 'active' ? 'success' : 'outline'} size="sm">
      {DEVICE_LABEL[status] ?? status}
    </Badge>
  );
}
