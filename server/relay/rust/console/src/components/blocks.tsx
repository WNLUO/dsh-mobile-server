import type { ReactNode } from 'react'

import { cn, toneDot, toneText, type Tone } from '../lib/format.ts'

/** 一枚小圆点，颜色说明这一行此刻好不好。 */
export function Dot({ tone }: { tone: Tone }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', toneDot[tone])} aria-hidden />
}

type InfoRowProps = {
  label: string
  tone?: Tone
  mono?: boolean
  children: ReactNode
}

/** 只读信息行：左边标签、右边值。 */
export function InfoRow({ label, tone, mono, children }: InfoRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-2 last:border-b-0">
      <dt className="shrink-0 text-sm text-foreground-muted">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right text-sm break-all',
          mono ? 'font-mono text-xs text-foreground-strong' : 'text-foreground',
          tone && toneText[tone],
        )}
      >
        {children}
      </dd>
    </div>
  )
}

export function InfoList({ children }: { children: ReactNode }) {
  return <dl className="mt-1">{children}</dl>
}

/** 值 + 一枚状态点，用于「隧道 已连接」这类行。 */
export function ToneValue({ tone, text, detail }: { tone: Tone; text: string; detail?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
      <Dot tone={tone} />
      <span>{text}</span>
      {detail ? <span className="text-xs text-foreground-muted">{detail}</span> : null}
    </span>
  )
}

/** 一块卡片：标题 + 可选说明 + 内容。 */
export function Card({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-xl border border-border bg-background-raised p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground-strong">{title}</h2>
          {description ? <p className="mt-1 text-sm text-foreground-muted">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** 空状态：说明这里什么都还没有，以及下一步做什么。 */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-foreground-muted">{children}</p>
}
