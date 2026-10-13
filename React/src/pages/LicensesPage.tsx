/*
 * 授权页：查看自己所有授权码、设备名额与已绑定设备，并解绑。
 * 授权码的产生只有一条路径——购买订单支付成功后由后端签发，所以这里没有「新建」。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { buttonVariants } from '@appica/ui-react/button';
import { EmptyNotice, ErrorAlert, Loading } from '../components/Feedback';
import { LicenseCard } from '../components/LicenseCard';
import { PageHeading } from '../components/blocks';
import { api } from '../lib/api';
import { describe } from '../lib/auth';
import type { License } from '../lib/types';

export function LicensesPage() {
  const [licenses, setLicenses] = useState<License[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.listLicenses();
      setLicenses(data.licenses);
      setError(null);
    } catch (cause) {
      setLicenses([]);
      setError(describe(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function unbind(licenseId: string, deviceId: string) {
    await api.unbindDevice(licenseId, deviceId);
    await load();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageHeading>授权</PageHeading>
        <Link to="/buy" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
          购买授权
        </Link>
      </div>
      <ErrorAlert message={error} />

      {licenses === null ? (
        <Loading label="正在加载授权" />
      ) : licenses.length === 0 ? (
        <EmptyNotice>还没有授权码</EmptyNotice>
      ) : (
        <div className="flex flex-col gap-4">
          {licenses.map((license) => (
            <LicenseCard
              key={license.id}
              license={license}
              onUnbind={(deviceId) => unbind(license.id, deviceId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
