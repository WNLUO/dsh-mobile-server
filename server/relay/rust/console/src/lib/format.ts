/** 一点点展示用的纯函数，和接口无关。 */

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

/** 状态点／文字的颜色档：ok 绿、warn 黄、error 红、off 灰。 */
export type Tone = 'ok' | 'warn' | 'error' | 'off'

export const toneDot: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  error: 'bg-error',
  off: 'bg-foreground-subtle',
}

export const toneText: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  error: 'text-error',
  off: 'text-foreground-muted',
}

/** ISO 字符串或毫秒时间戳都吃；空值给破折号，别让界面出现 NaN。 */
export function timeText(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 准入模式的人话。 */
export function admissionText(mode: string): string {
  if (mode === 'restricted') return '限制（需要激活码）'
  return '开放（谁都能用）'
}

export function admissionTone(mode: string): Tone {
  return mode === 'restricted' ? 'ok' : 'warn'
}

/** 激活码状态的人话。 */
export function licenseText(status: string): string {
  return status === 'active' ? '有效' : '已吊销'
}

export function licenseTone(status: string): Tone {
  return status === 'active' ? 'ok' : 'off'
}

/**
 * 抄错的风险提示：授权码字母表去掉了 0/O/1/I/L，用户看代码时最常把这几个搞混。
 * 界面上不做校验，只在他复制时给一句提醒。
 */
export const CODE_HINT = '码里没有 0、O、1、I、L，抄的时候留意。'
