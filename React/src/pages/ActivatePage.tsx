/*
 * 绑定设备页（唯一不需要登录的页面）。
 *
 * 授权码本身就是凭证：用户先买后绑，所以这个页面可以匿名访问——引导界面和
 * 移动端插件要走的也是同一个接口（POST /licenses/bind）。
 * 这里刻意不显示授权码归属人，也不允许解绑，避免它变成越权入口。
 */
import { useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card';
import { Field, FieldLabel } from '@appica/ui-react/field';
import { Input } from '@appica/ui-react/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@appica/ui-react/select';
import { Alert, AlertDescription, AlertTitle } from '@appica/ui-react/alert';
import { ErrorAlert } from '../components/Feedback';
import { LicenseCard } from '../components/LicenseCard';
import { PageHeading } from '../components/blocks';
import { api } from '../lib/api';
import { describe } from '../lib/auth';
import { VERIFY_REASON_LABEL } from '../lib/format';
import type { BindResult, VerifyResult } from '../lib/types';

const PLATFORMS = [
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
  { value: 'desktop', label: '桌面端' },
  { value: 'other', label: '其它' },
];

export function ActivatePage() {
  const [code, setCode] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [platform, setPlatform] = useState('android');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState<BindResult | null>(null);
  const [verified, setVerified] = useState<VerifyResult | null>(null);

  const ready = code.trim().length > 0 && deviceId.trim().length > 0;

  async function bind() {
    setBusy(true);
    setError(null);
    setVerified(null);
    try {
      setBound(
        await api.bindLicense({
          code: code.trim(),
          deviceId: deviceId.trim(),
          deviceName: deviceName.trim(),
          platform,
        }),
      );
    } catch (cause) {
      setBound(null);
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    setBound(null);
    try {
      setVerified(await api.verifyLicense({ code: code.trim(), deviceId: deviceId.trim() }));
    } catch (cause) {
      setVerified(null);
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>绑定设备</PageHeading>
      <ErrorAlert message={error} />

      <Card>
        <CardHeader>
          <CardTitle render={<h2 />}>授权码</CardTitle>
        </CardHeader>

        <div className="flex flex-wrap gap-4">
          <Field className="min-w-60 flex-1">
            <FieldLabel>授权码</FieldLabel>
            <Input
              value={code}
              placeholder="DSH-XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>

          <Field className="min-w-60 flex-1">
            <FieldLabel>设备标识</FieldLabel>
            <Input
              value={deviceId}
              placeholder="APP 里显示的设备标识"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDeviceId(event.target.value)}
            />
          </Field>

          <Field className="min-w-60 flex-1">
            <FieldLabel>设备名称</FieldLabel>
            <Input
              value={deviceName}
              autoComplete="off"
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </Field>

          <Field className="w-40">
            <FieldLabel>平台</FieldLabel>
            <Select value={platform} onValueChange={(value) => setPlatform(String(value))}>
              <SelectTrigger>
                <SelectValue placeholder="选择平台" />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="md" disabled={busy || !ready} onClick={() => void bind()}>
            {busy ? '正在处理' : '绑定设备'}
          </Button>
          <Button variant="outline" size="md" disabled={busy || code.trim().length === 0} onClick={() => void verify()}>
            检查授权
          </Button>
        </div>
      </Card>

      {verified ? (
        verified.ok ? (
          <Alert variant="success">
            <AlertTitle>这台设备可以正常使用</AlertTitle>
            <AlertDescription>{`到期时间 ${verified.expiresAt || '—'}`}</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="warning">
            <AlertTitle>这台设备无法使用</AlertTitle>
            <AlertDescription>
              {VERIFY_REASON_LABEL[verified.reason ?? ''] ?? verified.reason ?? '未知原因'}
            </AlertDescription>
          </Alert>
        )
      ) : null}

      {bound ? <LicenseCard license={bound.license} /> : null}
    </div>
  );
}
