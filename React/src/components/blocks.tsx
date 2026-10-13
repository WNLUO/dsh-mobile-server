/*
 * 页面里反复出现的排版积木：标题、指标块、键值行、带标题的卡片。
 * 刻意不含任何说明性文案——项目当前的要求是标题下、区域下都不写描述。
 */
import type { ReactNode } from 'react';
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card';

export function PageHeading({ children }: { children: ReactNode }) {
  return <h1 className="text-foreground-intense text-xl font-semibold">{children}</h1>;
}

export function SectionCard({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle render={<h2 />}>{title}</CardTitle>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      </CardHeader>
      {children}
    </Card>
  );
}

export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card className="min-w-40 flex-1">
      <p className="text-foreground-muted">{label}</p>
      <p className="text-foreground-intense mt-1 text-2xl font-semibold">{value}</p>
    </Card>
  );
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2 last:border-b-0">
      <span className="text-foreground-muted">{label}</span>
      <span className="text-foreground-intense">{children}</span>
    </div>
  );
}
