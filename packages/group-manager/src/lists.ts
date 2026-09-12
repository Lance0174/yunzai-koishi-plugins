import { Session } from 'koishi'
import { Config } from './config'
import { State } from './state'
import { UserError } from './errors'
import type { Host } from './support'
import { userId } from './onebot'

// Feature reference: yenai-plugin groupWhiteListCtrl and GroupEntry_Plugin
// blacklistManager. Blacklisted messages are ignored as requested for this port.
export class Lists {
  constructor(
    readonly state: State,
    readonly config: Config,
  ) {}
  private async contains(bot: string, guild: string, kind: string, ref: string, defaults: string[] = []) {
    const row = await this.state.get(bot, guild, kind, ref)
    return row ? row.state === 'enabled' : defaults.includes(ref)
  }
  async ignored(bot: string, guild = '', user = '') {
    return (
      (!!guild && (await this.contains(bot, '', 'ignore-group', guild, this.config.blackGroups))) ||
      (!!user &&
        ((await this.contains(bot, '', 'ignore', user, this.config.blackUsers)) ||
          (!!guild && (await this.contains(bot, guild, 'ignore', user)))))
    )
  }
  async exempt(bot: string, guild: string, user: string) {
    if (await this.ignored(bot, guild, user)) return false
    return (
      (await this.contains(bot, '', 'exempt-group', guild, this.config.whiteGroups)) ||
      (await this.contains(bot, '', 'exempt', user, this.config.whiteUsers)) ||
      (await this.contains(bot, guild, 'exempt', user))
    )
  }
  async groupExempt(bot: string, guild: string) {
    return (
      !(await this.ignored(bot, guild)) &&
      (await this.contains(bot, '', 'exempt-group', guild, this.config.whiteGroups))
    )
  }
}
export function isManager(host: Pick<Host, 'config' | 'active'>, s: Session) {
  return (
    host.active(s.bot) &&
    !!s.userId &&
    (host.config.reviewers.includes(s.userId) ||
      ((s.user as { authority?: number } | undefined)?.authority ?? 0) >= 4)
  )
}
export function installLists(host: Host) {
  for (const [label, kind] of [
    ['黑名单', 'ignore'],
    ['白名单', 'exempt'],
  ] as const) {
    const command = host.root
      .subcommand(
        `.${label} <operation:string> [target:string]`,
        '添加/删除/列表；默认本群成员，可用 --全局 或 --群',
        { authority: 0 },
      )
      .option('global', '--全局')
      .option('guild', '--群')
      .userFields(['authority'])
    if (host.config.shortcuts) command.alias(label)
    command.action(({ session, options }, operation, target) =>
      host.guard(async () => {
        const s = session!,
          global = !!options?.global || !!options?.guild || !s.guildId
        if (global) {
          if (!isManager(host, s)) throw new UserError('全局用户和群名单仅允许机器人管理员设置。')
        } else await host.permission(s)
        const guild = global ? '' : s.guildId!,
          bot = host.botKey(s.bot)
        const type = kind + (options?.guild ? '-group' : '')
        const defaults = global
          ? options?.guild
            ? kind === 'ignore'
              ? host.config.blackGroups
              : host.config.whiteGroups
            : kind === 'ignore'
              ? host.config.blackUsers
              : host.config.whiteUsers
          : []
        if (operation === '列表') {
          const entries = new Set(defaults)
          for (const row of await host.lists.state.list(bot, guild, type)) {
            if (row.state === 'enabled') entries.add(row.ref)
            else entries.delete(row.ref)
          }
          return `${global ? '全局' : '本群'}${options?.guild ? '群' : '用户'}${label}：\n${[...entries].join('\n') || '空'}`
        }
        if (!['添加', '删除'].includes(operation)) throw new UserError('操作为添加、删除或列表。')
        const id = userId(target)
        if (
          kind === 'ignore' &&
          operation === '添加' &&
          !options?.guild &&
          (id === s.userId || id === s.selfId)
        )
          throw new UserError('不能把当前操作人或机器人自己加入黑名单。')
        await host.lists.state.put(
          bot,
          guild,
          type,
          id,
          s.userId!,
          {},
          0,
          operation === '添加' ? 'enabled' : 'disabled',
        )
        await host.store.audit({
          bot,
          guildId: guild,
          actor: s.userId!,
          action: `${type}-${operation}`,
          target: id,
          state: 'acknowledged',
          detail: '',
        })
        return `${label}已${operation} ${id}。${kind === 'ignore' ? '黑名单消息会被忽略。' : '白名单豁免处罚和入群验证，不增加管理权限。'}`
      }),
    )
  }
  host.ctx.middleware(async (s, next) => {
    if (host.active(s.bot) && (await host.lists.ignored(host.botKey(s.bot), s.guildId, s.userId))) return
    return next()
  }, true)
}
