import { UserError } from './errors'

// Reference behavior: yenai-plugin model/GroupAdmin.js recurring mute tasks.
// Rules are wall-clock strings with an explicit or server-local fixed offset.
export interface Recur {
  type: 'daily' | 'weekly'
  day?: number
  hh: number
  mm: number
  tz: number
}

const RECUR = /^(每日|每天|每周([一二三四五六日天]))\s*(\d{1,2}):(\d{2})(?:([+-])(\d{2}):(\d{2}))?$/
const WEEKDAYS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }

export function parseRecur(input: string): Recur {
  const match = RECUR.exec(input.trim())
  if (!match)
    throw new UserError(
      '周期格式：每日22:00 或 每周一09:30（一条写法，可用空格分隔成员参数），可带时区后缀（如 +08:00）；一次性任务仍支持 10m 或带时区的 ISO 时间。',
    )
  const hh = Number(match[3]),
    mm = Number(match[4])
  if (hh > 23 || mm > 59) throw new UserError('时间须为 24 小时制的 HH:MM。')
  let tz: number
  if (match[5]) {
    tz = Number(match[6]) * 60 + Number(match[7])
    if (match[5] === '-') tz = -tz
    if (tz <= -14 * 60 || tz >= 14 * 60) throw new UserError('时区偏移须在 -14:00 到 +14:00 之间。')
  } else {
    tz = -new Date().getTimezoneOffset()
  }
  return match[1].startsWith('每周')
    ? { type: 'weekly', day: WEEKDAYS[match[2]], hh, mm, tz }
    : { type: 'daily', hh, mm, tz }
}

export function nextRecurring(recur: Recur, from: number) {
  // Calendar math runs on the wall clock of the rule's fixed offset; DST is
  // out of scope because the offset stays fixed for the life of the rule.
  const wall = new Date(from + recur.tz * 60_000)
  let candidate =
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), recur.hh, recur.mm) -
    recur.tz * 60_000
  if (recur.type === 'weekly')
    while (new Date(candidate + recur.tz * 60_000).getUTCDay() !== recur.day) candidate += 86400_000
  if (candidate <= from) candidate += (recur.type === 'weekly' ? 7 : 1) * 86400_000
  return candidate
}

export function recurLabel(recur: Recur) {
  const time = `${String(recur.hh).padStart(2, '0')}:${String(recur.mm).padStart(2, '0')}`
  const sign = recur.tz < 0 ? '-' : '+'
  const offset = `${sign}${String(Math.floor(Math.abs(recur.tz) / 60)).padStart(2, '0')}:${String(Math.abs(recur.tz) % 60).padStart(2, '0')}`
  const day = ['日', '一', '二', '三', '四', '五', '六'][recur.day ?? 0]
  return recur.type === 'weekly' ? `每周${day} ${time}（UTC${offset}）` : `每日 ${time}（UTC${offset}）`
}
