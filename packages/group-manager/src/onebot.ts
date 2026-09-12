import { Bot, h } from 'koishi'
import { UserError } from './errors'

export class ActionError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    super(message)
  }
}
export interface Member {
  user_id: string | number
  role: string
  card?: string
  nickname?: string
  title?: string
  join_time?: number
  last_sent_time?: number
  shut_up_timestamp?: number
  level?: string | number
}
export interface Internal {
  _get(action: string, params: Record<string, unknown>): Promise<unknown>
  getGroupMemberInfo(guild: string, user: string, fresh: boolean): Promise<Member>
  getGroupMemberList(guild: string): Promise<Member[]>
  getGroupList(
    fresh?: boolean,
  ): Promise<{ group_id: number | string; group_name: string; member_count?: number }[]>
  getGroupInfo(
    guild: string,
    fresh?: boolean,
  ): Promise<{ group_name: string; member_count?: number; max_member_count?: number }>
  setGroupAdmin(guild: string, user: string, enable: boolean): Promise<unknown>
  setGroupSpecialTitle(guild: string, user: string, title: string, duration?: number): Promise<unknown>
  setGroupName(guild: string, name: string): Promise<unknown>
  setGroupPortrait(guild: string, file: string, cache?: number): Promise<unknown>
  setGroupLeave(guild: string, dismiss?: boolean): Promise<unknown>
  sendGroupNotice(guild: string, content: string): Promise<unknown>
  getGroupNotice(guild: string): Promise<any[]>
  delGroupNotice(guild: string, id: string): Promise<unknown>
  setEssenceMsg(id: string): Promise<unknown>
  deleteEssenceMsg(id: string): Promise<unknown>
  getEssenceMsgList(guild: string): Promise<any[]>
  getGroupHonorInfo(guild: string, type: string): Promise<any>
  getGroupSignedList(guild: string): Promise<any>
  getGroupSystemMsg(): Promise<any>
  getMsg(id: string): Promise<{
    group_id?: string | number
    message_type?: string
    user_id?: string | number
    sender?: { user_id: string | number }
  }>
  setGroupCard(guild: string, user: string, card: string): Promise<unknown>
  getVersionInfo(): Promise<{ app_name?: string; app_version?: string; protocol_version?: string }>
}
export function internal(bot: Bot): Internal {
  if (bot.platform !== 'onebot' || !bot.internal) throw new UserError('此功能需要官方 OneBot 适配器。')
  return bot.internal as unknown as Internal
}
export async function timed<T>(action: () => Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ActionError('请求超时，结果待核实；请勿重复操作。', true)),
          timeout,
        )
      }),
    ])
  } catch (error) {
    if (error instanceof ActionError) throw error
    const response = error as { retcode?: unknown; code?: unknown }
    const code = response?.retcode ?? response?.code
    if (typeof code === 'number') throw new ActionError(`平台拒绝操作（retcode=${code}）。`, false)
    throw new ActionError('连接或响应异常，结果待核实；请勿重复操作。', true)
  } finally {
    clearTimeout(timer)
  }
}
export function duration(input: string) {
  const match = /^(\d+)(s|m|h|d|秒|分|分钟|时|小时|天)$/.exec(input.trim())
  if (!match) throw new UserError('时长格式：30s、10m、2h 或 1d。')
  const units: Record<string, number> = {
    s: 1,
    秒: 1,
    m: 60,
    分: 60,
    分钟: 60,
    h: 3600,
    时: 3600,
    小时: 3600,
    d: 86400,
    天: 86400,
  }
  const seconds = Number(match[1]) * units[match[2]]
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 30 * 86400)
    throw new UserError('禁言时长须在 1 秒到 30 天之间。')
  return seconds * 1000
}
export function userId(input?: string) {
  if (!input) throw new UserError('请指定一名群成员。')
  const elements = h.parse(input)
  const mention =
    elements.length === 1 &&
    elements[0].type === 'at' &&
    (!elements[0].attrs.platform || elements[0].attrs.platform === 'onebot')
      ? String(elements[0].attrs.id ?? '')
      : ''
  const id = /^(?:onebot:|@)?(\d{1,20})$/.exec(mention || input)?.[1]
  if (!id) throw new UserError('成员格式须为 @成员或 QQ 号。')
  return id
}
