import { Bot, Command, Context, Session, h } from 'koishi'
import { Config } from './config'
import { Store } from './store'
import { State } from './state'
import { Member, internal, timed } from './onebot'
import { UserError } from './errors'
import { Lists } from './lists'

export interface Host {
  ctx: Context
  config: Config
  root: Command
  store: Store
  lists: Lists
  active(bot: Bot): boolean
  botKey(bot: Bot): string
  permission(
    s: Session,
    target?: string,
    guild?: string,
    reviewer?: boolean,
  ): Promise<{ actor: Member; self: Member; member?: Member }>
  authorize(
    bot: Bot,
    guild: string,
    actor: string,
    target?: string,
  ): Promise<{ actor: Member; self: Member; member?: Member }>
  perform(s: Session, action: string, target: string, run: () => Promise<unknown>): Promise<string>
  guard<T>(fn: () => Promise<T>): Promise<T | string>
  requireReview(s: Session): void
  flush(): Promise<void>
  notifyVerification(bot: Bot, guild: string, user: string, eventId: string): Promise<void>
}
export const plain = (value: unknown) => h.text(String(value ?? ''))
export function bounded(input: string, label: string, max = 500) {
  const value = h
    .parse(input || '')
    .filter((e) => e.type === 'text')
    .map((e) => e.attrs.content)
    .join('')
    .trim()
  if (!value || [...value].length > max) throw new UserError(`${label}长度须为 1～${max} 字。`)
  return value
}
export const commandFor =
  (host: Host) =>
  <D extends string>(decl: D, description: string, alias?: string) => {
    const cmd = host.root.subcommand(`.${decl}` as const, description, { authority: 0, captureQuote: false })
    if (host.config.shortcuts && alias) cmd.alias(alias)
    return cmd
  }
export async function quoteId(host: Host, s: Session) {
  if (!s.quote?.id) throw new UserError('请引用当前群的一条消息。')
  const message = await timed(() => internal(s.bot).getMsg(s.quote!.id!), host.config.apiTimeout)
  if (String(message.group_id ?? '') !== s.guildId || message.message_type !== 'group')
    throw new UserError('无法确认引用消息属于当前群。')
  return s.quote.id
}
export async function punishable(host: Host, state: State, s: Session, user: string) {
  if (await host.lists.exempt(host.botKey(s.bot), s.guildId!, user))
    throw new UserError('该成员在处罚豁免名单中。')
}
export function finiteTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined
}
export function memberLine(m: Member) {
  return `${m.card || m.nickname || '成员'} (${m.user_id})`
}
export function scope(host: Host, s: Session) {
  return (
    host.config.moderation &&
    host.active(s.bot) &&
    !!s.guildId &&
    !!s.userId &&
    (!host.config.managedGroups.length || host.config.managedGroups.includes(s.guildId))
  )
}
