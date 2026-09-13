import { Bot, Session } from 'koishi'
import type { Host } from './support'
import { State } from './state'
import { EventRow, key } from './store'
import { isManager } from './lists'
import { UserError } from './errors'
import { userId } from './onebot'

// Feature references: yenai-plugin apps/events and apps/admin/notice.js;
// GroupEntry_Plugin notifyUsers. This is a separate Koishi event consumer.
export const eventTopics = [
  '群聊变动',
  '成员变动',
  '管理员变动',
  '禁言变动',
  '群撤回',
  '好友变动',
  '好友撤回',
  '好友申请',
  '群邀请',
  '入群申请',
  '入群验证',
  '群消息',
  '私聊消息',
] as const
type Topic = (typeof eventTopics)[number]
type Target = { type: 'group' | 'private'; id: string }
const destination = (target: Target) => `${target.type === 'private' ? 'p' : 'g'}:${target.id}`
export class Notifications {
  constructor(
    readonly host: Host,
    readonly state: State,
  ) {}
  async settings(bot: string) {
    const row = await this.state.get(bot, '', 'listener')
    return {
      enabled: row ? row.state === 'enabled' : this.host.config.listener,
      mode: row?.payload.mode ?? this.host.config.listenerMode,
      targets: (row?.payload.targets ?? this.host.config.listenerTargets) as Target[],
    }
  }
  async targets(bot: string) {
    const settings = await this.settings(bot)
    if (!settings.enabled) return []
    const values: Target[] =
      settings.mode === 'admins'
        ? this.host.config.reviewers.map((id) => ({ type: 'private', id }))
        : settings.targets
    return [...new Set(values.filter((t) => /^\d{1,20}$/.test(t.id)).map(destination))]
  }
  async enabled(bot: string, guild: string, topic: string) {
    for (const [scope, ref] of [
      [guild, topic],
      [guild, '*'],
      ['', topic],
      ['', '*'],
    ]) {
      const row = await this.state.get(bot, scope, 'notice-switch', ref)
      if (row) return row.state === 'enabled'
    }
    return !['群消息', '私聊消息'].includes(topic) && this.host.config.notices
  }
  async canDeliver(bot: Bot, row: EventRow) {
    if (!row.topic) return this.host.config.reviewGroups.includes(row.channel)
    return (
      (await this.targets(this.host.botKey(bot))).includes(row.channel) &&
      (await this.enabled(this.host.botKey(bot), row.guildId, row.topic)) &&
      !(await this.host.lists.ignored(this.host.botKey(bot), row.guildId))
    )
  }
  async receive(s: Session, topic: Topic, description: string) {
    const { host } = this,
      bot = host.botKey(s.bot),
      guild = s.guildId ?? ''
    if (!host.active(s.bot) || (await host.lists.ignored(bot, guild, s.userId))) return
    if (!(await this.enabled(bot, guild, topic))) return
    const targets = await this.targets(bot)
    if (!targets.length) return
    const id = key(
      bot,
      topic,
      guild,
      s.userId ?? '',
      s.operatorId ?? '',
      s.messageId ?? '',
      s.subtype ?? '',
      String(s.event.timestamp ?? ''),
    )
    for (const target of targets) {
      // Do not mirror a destination's own messages back into itself.
      if (topic.endsWith('消息') && target === (guild ? `g:${guild}` : `p:${s.userId}`)) continue
      await host.store.enqueueEvent(
        bot,
        target,
        id,
        `${description}\n机器人：${s.selfId}${guild ? `；群：${guild}` : ''}\n用户：${s.userId || '未知'}；操作人：${s.operatorId || '未知'}`,
        { guildId: guild, topic },
      )
    }
    await host.flush()
  }
  async verificationTimeout(bot: Bot, guild: string, user: string, eventId: string) {
    const account = this.host.botKey(bot)
    if (
      !this.host.active(bot) ||
      (await this.host.lists.ignored(account, guild, user)) ||
      !(await this.enabled(account, guild, '入群验证'))
    )
      return
    for (const target of await this.targets(account))
      await this.host.store.enqueueEvent(
        account,
        target,
        eventId,
        `入群验证超时：群 ${guild}，成员 ${user}。未执行踢出。\n机器人：${bot.selfId}`,
        { guildId: guild, topic: '入群验证' },
      )
    await this.host.flush()
  }
  install() {
    const { host } = this,
      { ctx } = host
    let disposed = false
    const pending = new Set<Promise<void>>()
    const run = (fn: () => Promise<void>) => {
      if (disposed) return Promise.resolve()
      const work = Promise.resolve()
        .then(fn)
        .catch(() => {
          if (!disposed) ctx.logger('yunzai-group-manager').warn('事件监听处理失败，请检查通知投递记录。')
        })
        .finally(() => pending.delete(work))
      pending.add(work)
      return work
    }
    // The adapter stores the raw OneBot payload on session.onebot; detail text
    // keeps the original topic words so switch filtering and tests stay stable.
    const raw = (s: Session) => ((s as any).onebot ?? {}) as Record<string, any>
    const operator = (s: Session) =>
      s.operatorId && s.operatorId !== s.userId ? `（操作人 ${s.operatorId}）` : ''
    const events: [string, Topic, (s: Session) => string][] = [
      ['guild-added', '群聊变动', () => '机器人加入群聊'],
      ['guild-deleted', '群聊变动', (s) => (raw(s).sub_type === 'kick_me' ? '机器人被移出群聊' : '机器人退群/被移出')],
      [
        'guild-member-added',
        '成员变动',
        (s) => `成员加入${raw(s).sub_type === 'invite' ? '（受邀加入）' : '（申请通过）'}`,
      ],
      [
        'guild-member-deleted',
        '成员变动',
        (s) => {
          if (raw(s).sub_type === 'kick') return `成员被管理员移出${operator(s)}`
          if (raw(s).sub_type === 'leave') return '成员主动退出'
          return '成员退出/被移出'
        },
      ],
      ['friend-added', '好友变动', () => '新增好友'],
      ['friend-deleted', '好友变动', () => '删除好友'],
      ['friend-request', '好友申请', () => '收到好友申请'],
      ['guild-request', '群邀请', () => '收到机器人群邀请'],
      ['guild-member-request', '入群申请', () => '收到成员入群申请'],
    ]
    for (const [event, topic, label] of events)
      ctx.on(event as 'guild-added', (s) =>
        run(async () => {
          // With reviews enabled the request flow sends coded notices to the same
          // listener targets; the bare summary would only duplicate it.
          if ((event === 'guild-request' || event === 'guild-member-request') && host.config.reviews)
            return
          await this.receive(s, topic, label(s))
        }),
      )
    ctx.on('guild-member' as 'guild-member-added', (s) =>
      run(async () => {
        if (s.subtype === 'ban') {
          const detail =
            raw(s).sub_type === 'lift_ban'
              ? `被解除禁言${operator(s)}`
              : `被禁言 ${raw(s).duration ?? '未知'} 秒${operator(s)}`
          await this.receive(s, '禁言变动', `禁言状态变更：成员 ${s.userId ?? '未知'} ${detail}`)
        } else if (s.subtype === 'role') {
          const detail = raw(s).sub_type === 'set' ? '获得管理员' : '取消管理员'
          await this.receive(s, '管理员变动', `管理员变更：成员 ${s.userId ?? '未知'} ${detail}`)
        }
      }),
    )
    ctx.on('message-deleted', (s) =>
      run(() =>
        this.receive(
          s,
          s.guildId ? '群撤回' : '好友撤回',
          `${s.guildId ? '群' : '私聊'}消息撤回；消息 ${s.messageId || '未知'}；发送者 ${s.userId || '未知'}${operator(s)}`,
        ),
      ),
    )
    ctx.on('message', (s) =>
      run(async () => {
        if (s.userId === s.selfId) return
        const content = (s.elements ?? [])
          .map((e) => (e.type === 'text' ? e.attrs.content : `[${e.type}]`))
          .join('')
          .slice(0, 700)
        await this.receive(
          s,
          s.guildId ? '群消息' : '私聊消息',
          `收到${s.guildId ? '群' : '私聊'}消息\n${content}`,
        )
      }),
    )
    const listener = host.root
      .subcommand('.事件监听 [value:string]', '独立监听开/关/状态；选择管理员或自定义群聊、私聊收件人', {
        authority: 0,
      })
      .option('admins', '--管理员')
      .option('group', '--群 <id:string>')
      .option('private', '--私聊 <id:string>')
      .userFields(['authority'])
    if (host.config.shortcuts) listener.alias('事件监听')
    listener.action(({ session, options }, value = '状态') =>
      host.guard(async () => {
        const s = session!,
          bot = host.botKey(s.bot)
        if (!isManager(host, s)) throw new UserError('事件监听收件人仅允许机器人管理员设置。')
        const previous = await this.settings(bot)
        if (value === '状态')
          return `事件监听：${previous.enabled ? '开' : '关'}；收件方式：${previous.mode === 'admins' ? '管理员私聊' : '自定义'}\n目标：${(await this.targets(bot)).join('、') || '未设置，请填写管理员 QQ 或自定义目标'}`
        if (!['开', '关', '开启', '关闭'].includes(value)) throw new UserError('参数为开、关或状态。')
        if (options?.admins && (options.group || options.private))
          throw new UserError('请选择管理员或自定义目标中的一种。')
        const custom: Target[] = []
        if (options?.group) custom.push({ type: 'group', id: userId(options.group) })
        if (options?.private) custom.push({ type: 'private', id: userId(options.private) })
        const payload = {
          mode: options?.admins ? 'admins' : custom.length ? 'custom' : previous.mode,
          targets: custom.length ? custom : previous.targets,
        }
        await this.state.put(
          bot,
          '',
          'listener',
          '',
          s.userId!,
          payload,
          0,
          value.startsWith('开') ? 'enabled' : 'disabled',
        )
        // Pending events must never move to newly selected recipients after a route change.
        await ctx.database.set(
          'ember_group_event',
          { bot, state: 'pending', topic: { $ne: '' } },
          { state: 'cancelled' },
        )
        return `事件监听已${value.startsWith('开') ? '开启' : '关闭'}。目标：${(await this.targets(bot)).join('、') || '未设置'}。`
      }),
    )
    const notice = host.root
      .subcommand(
        '.事件通知 [value:string] [event:string]',
        '事件通知默认开启；按当前群切换，可用 --全局。群/私聊消息正文须单独开启',
        { authority: 0 },
      )
      .option('global', '--全局')
      .userFields(['authority'])
    if (host.config.shortcuts) notice.alias('事件通知')
    notice.action(({ session, options }, value = '状态', event = '全部') =>
      host.guard(async () => {
        const s = session!,
          bot = host.botKey(s.bot),
          guild = options?.global || !s.guildId ? '' : s.guildId
        if (!isManager(host, s)) {
          if (!guild) throw new UserError('全局通知开关仅允许机器人管理员设置。')
          await host.authorize(s.bot, guild, s.userId!)
        }
        if (value === '状态') {
          const statuses = await Promise.all(
            eventTopics.map(
              async (topic) => `${topic}：${(await this.enabled(bot, guild, topic)) ? '开' : '关'}`,
            ),
          )
          return `${guild ? `群 ${guild}` : '全局'}事件通知\n${statuses.join('\n')}`
        }
        if (!['开', '关', '开启', '关闭'].includes(value)) throw new UserError('参数为开、关或状态。')
        if (event !== '全部' && !eventTopics.includes(event as Topic))
          throw new UserError(`事件类型：全部、${eventTopics.join('、')}。`)
        await this.state.put(
          bot,
          guild,
          'notice-switch',
          event === '全部' ? '*' : event,
          s.userId!,
          {},
          0,
          value.startsWith('开') ? 'enabled' : 'disabled',
        )
        return `${guild ? `群 ${guild}` : '全局'}的${event}通知已${value.startsWith('开') ? '开启' : '关闭'}。`
      }),
    )
    ctx.on('dispose', async () => {
      disposed = true
      await Promise.allSettled([...pending])
    })
  }
}
