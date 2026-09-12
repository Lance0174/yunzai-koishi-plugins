import { Context, Schema, Session, h, Bot } from 'koishi'
import { Store, models, RequestRow, key } from './store'
import { ActionError, duration, internal, timed, userId } from './onebot'
import { UserError } from './errors'

export const name = 'ember-group-manager'
export const inject = ['database']
export const usage =
  '先填写审核人 QQ、审核通知群和需要管理的群。审核/通知/群管可分别关闭。需要 OneBot 适配器和数据库。'
export interface Config {
  command: string
  reviews: boolean
  notices: boolean
  moderation: boolean
  botIds: string[]
  reviewers: string[]
  reviewGroups: string[]
  managedGroups: string[]
  privateReview: boolean
  inviteAllow: string[]
  inviteDeny: string[]
  requestTtlHours: number
  apiTimeout: number
  pageSize: number
  noticeInterval: number
  auditDays: number
}
export const Config: Schema<Config> = Schema.object({
  command: Schema.string().default('群管理').description('指令根名称。'),
  reviews: Schema.boolean().default(true).description('启用群请求审核。'),
  notices: Schema.boolean().default(true).description('启用群事件摘要通知。'),
  moderation: Schema.boolean().default(true).description('启用基础群管理。'),
  botIds: Schema.array(String)
    .default([])
    .description('限定机器人 QQ；留空适用所有 OneBot 账户，各账户数据独立。'),
  reviewers: Schema.array(String).default([]).description('允许审核的用户 QQ。'),
  reviewGroups: Schema.array(String).default([]).description('接收通知及允许审批的群号。'),
  managedGroups: Schema.array(String)
    .default([])
    .description('允许群管操作及发送事件通知的群号；留空不开放群管。'),
  privateReview: Schema.boolean().default(false).description('允许审核人私聊使用请求编号审批。'),
  inviteAllow: Schema.array(String).default([]).description('机器人允许加入的群；留空不限。始终人工审批。'),
  inviteDeny: Schema.array(String).default([]).description('禁止机器人加入的群。'),
  requestTtlHours: Schema.number().min(1).max(168).default(24).description('本地请求有效期（小时）。'),
  apiTimeout: Schema.number().min(1000).max(60000).default(15000).description('动作等待时间（毫秒）。'),
  pageSize: Schema.number().min(1).max(20).step(1).default(5),
  noticeInterval: Schema.number().min(100).default(1500).description('同一通知群最小发送间隔（毫秒）。'),
  auditDays: Schema.number().min(1).max(365).default(30).description('审计和已结束请求的保留天数。'),
})
const labels: Record<string, string> = {
  pending: '待审核',
  processing: '正在处理',
  approved: '平台已确认同意',
  rejected: '平台已确认拒绝',
  failed: '平台明确失败',
  uncertain: '结果待核实',
  expired: '已过期',
}
const text = (value: unknown) => h.text(String(value ?? ''))

export function apply(ctx: Context, config: Config) {
  if (!/^[\p{L}\p{N}_-]{1,30}$/u.test(config.command))
    throw new UserError('指令名只能包含文字、数字、下划线或连字符。')
  if (config.inviteAllow.some((id) => config.inviteDeny.includes(id)))
    throw new UserError('邀请黑白名单存在相同群号。')
  models(ctx)
  const store = new Store(ctx.database)
  const logger = ctx.logger(name)
  let disposed = false,
    flushing = false
  const sentAt = new Map<string, number>(),
    seen = new Map<string, number>()
  const active = (bot: Bot) =>
    bot.platform === 'onebot' && (!config.botIds.length || config.botIds.includes(bot.selfId))
  const botKey = (bot: Bot) => `${bot.platform}:${bot.selfId}`
  const canReview = (s: Session) =>
    !!s.userId! &&
    !!s.channelId! &&
    active(s.bot) &&
    config.reviewers.includes(s.userId!) &&
    (s.guildId! ? config.reviewGroups.includes(s.guildId!) : config.privateReview)
  const requireReview = (s: Session) => {
    if (!config.reviews || !canReview(s)) throw new UserError('你没有在此会话审核群请求的权限。')
  }

  async function audit(s: Session, action: string, target: string, state: string, detail = '') {
    await store.audit({
      bot: botKey(s.bot),
      guildId: s.guildId! ?? '',
      actor: s.userId!,
      action,
      target,
      state,
      detail: detail.slice(0, 300),
    })
  }
  async function permission(s: Session, target?: string, guild = s.guildId!, reviewer = false) {
    if (
      !s.userId! ||
      !s.channelId! ||
      !active(s.bot) ||
      !guild ||
      (!reviewer && (!config.moderation || !config.managedGroups.includes(guild)))
    )
      throw new UserError('此群尚未开放群管理。')
    const api = internal(s.bot)
    if (!api.getGroupMemberInfo) throw new UserError('协议端缺少群成员权限查询。')
    let actor, self, member
    try {
      ;[actor, self, member] = await timed(
        () =>
          Promise.all([
            api.getGroupMemberInfo(guild, s.userId!, true),
            api.getGroupMemberInfo(guild, s.selfId, true),
            target ? api.getGroupMemberInfo(guild, target, true) : Promise.resolve(undefined),
          ]),
        config.apiTimeout,
      )
    } catch {
      throw new UserError('无法核验目标群角色，请稍后再试。')
    }
    if (!['admin', 'owner'].includes(actor.role)) throw new UserError('操作人须为目标群管理员或群主。')
    if (!['admin', 'owner'].includes(self.role)) throw new UserError('机器人没有目标群管理权限。')
    if (target === s.selfId) throw new UserError('不能对机器人自身执行此操作。')
    if (
      member &&
      (member.role === 'owner' ||
        (member.role === 'admin' && (actor.role !== 'owner' || self.role !== 'owner')))
    )
      throw new UserError('无法对该群主或管理员执行此操作。')
  }

  async function flush() {
    if (flushing || disposed || (!config.reviews && !config.notices)) return
    flushing = true
    try {
      await store.recover()
      const waiting = config.reviews
        ? await ctx.database.get('ember_group_notice', { state: 'pending' }, { limit: 30 })
        : []
      for (const n of waiting) {
        if (disposed) break
        const bot = ctx.bots.find((b) => botKey(b) === n.bot && active(b))
        if (!bot || !config.reviewGroups.includes(n.channel)) continue
        const slot = `${n.bot}:${n.channel}`
        if (Date.now() - (sentAt.get(slot) ?? 0) < config.noticeInterval) continue
        const request = (await ctx.database.get('ember_group_request', { id: n.requestId }))[0]
        if (!request || request.state !== 'pending') {
          await ctx.database.set('ember_group_notice', { id: n.id, state: 'pending' }, { state: 'cancelled' })
          continue
        }
        const claim = await store.claimNotice(n.id, config.apiTimeout + 30_000)
        if (!claim) continue
        sentAt.set(slot, Date.now())
        try {
          const ids = await timed(
            () =>
              bot.sendMessage(
                n.channel,
                text(
                  format(request) + `\n引用本通知发送“${config.command} 同意”或“${config.command} 拒绝”。`,
                ),
              ),
            config.apiTimeout,
          )
          await store.finishNotice(n.id, claim, ids?.[0] ? 'sent' : 'uncertain', ids?.[0] ?? '')
        } catch (error) {
          await store.finishNotice(
            n.id,
            claim,
            error instanceof ActionError && !error.uncertain ? 'failed' : 'uncertain',
          )
        }
      }
      if (config.notices)
        for (const bot of ctx.bots.filter(active))
          for (const channel of new Set(config.reviewGroups)) {
            if (disposed) break
            const slot = `${botKey(bot)}:${channel}`
            if (Date.now() - (sentAt.get(slot) ?? 0) < config.noticeInterval) continue
            const { rows, claim } = await store.claimEvents(botKey(bot), channel, config.apiTimeout + 30_000)
            if (!rows.length) continue
            sentAt.set(slot, Date.now())
            try {
              const ids = await timed(
                () =>
                  bot.sendMessage(
                    channel,
                    text(
                      rows
                        .map((row) => `${row.summary}${row.count > 1 ? `（${row.count} 条）` : ''}`)
                        .join('\n\n'),
                    ),
                  ),
                config.apiTimeout,
              )
              await store.finishEvents(claim, ids?.[0] ? 'sent' : 'uncertain')
            } catch (error) {
              await store.finishEvents(
                claim,
                error instanceof ActionError && !error.uncertain ? 'failed' : 'uncertain',
              )
              logger.warn('群事件摘要发送失败或结果未知；已保留投递状态，不自动重发。')
            }
          }
    } finally {
      flushing = false
    }
  }
  function format(r: RequestRow) {
    const policy =
      r.kind === 'invite' && config.inviteDeny.includes(r.guildId)
        ? '\n命中邀请黑名单'
        : r.kind === 'invite' && config.inviteAllow.length && !config.inviteAllow.includes(r.guildId)
          ? '\n不在邀请白名单'
          : ''
    return `[${r.code}] ${r.kind === 'invite' ? '机器人群邀请' : '成员入群申请'}\n机器人：${r.selfId}\n群：${r.guildId}；申请人：${r.userId}\n状态：${labels[r.state] ?? r.state}\n申请时间：${new Date(r.created).toLocaleString('zh-CN')}\n备注：${r.comment || '无'}${policy}`
  }
  async function receive(s: Session, kind: string) {
    if (!config.reviews || !active(s.bot) || !s.guildId!) return
    const request = await store.receive(
      {
        bot: botKey(s.bot),
        selfId: s.selfId,
        kind,
        flag: s.messageId ?? '',
        guildId: s.guildId!,
        userId: s.userId!,
        comment: s.content ?? '',
      },
      config.requestTtlHours * 3600_000,
    )
    if (request.state === 'pending')
      for (const channel of new Set(config.reviewGroups)) await store.notice(request, channel)
    await flush()
  }
  const guardedEvent = (fn: () => Promise<unknown>) => {
    void fn().catch(() => logger.warn('群事件处理失败，请检查数据库和待处理请求。'))
  }
  ctx.on('guild-request', (s) => guardedEvent(() => receive(s, 'invite')))
  ctx.on('guild-member-request', (s) => guardedEvent(() => receive(s, 'member')))

  const notices = [
    'guild-added',
    'guild-deleted',
    'guild-member-added',
    'guild-member-deleted',
    'guild-member',
    'message-deleted',
  ] as const
  for (const event of notices)
    ctx.on(event as 'guild-added', (s) =>
      guardedEvent(async () => {
        if (!config.notices || !active(s.bot) || !s.guildId! || !config.managedGroups.includes(s.guildId!))
          return
        if (event === 'guild-member' && !['role', 'ban'].includes(s.subtype)) return
        const id = key(
          botKey(s.bot),
          event,
          s.guildId!,
          s.userId! ?? '',
          s.operatorId ?? '',
          s.messageId ?? '',
          s.subtype ?? '',
          String(s.event.timestamp ?? ''),
        )
        const now = Date.now()
        if (seen.has(id) && now - seen.get(id)! < 60_000) return
        seen.set(id, now)
        if (seen.size > 2000) for (const [k, time] of seen) if (now - time > 60_000) seen.delete(k)
        if (seen.size > 2000) seen.delete(seen.keys().next().value!)
        const titles: Record<string, string> = {
          'guild-added': '机器人入群',
          'guild-deleted': '机器人退群/被移出',
          'guild-member-added': '成员加入',
          'guild-member-deleted': '成员退出/被移出',
          'guild-member': s.subtype === 'ban' ? '禁言状态变更' : '管理员变更',
          'message-deleted': '群消息撤回',
        }
        for (const channel of new Set(config.reviewGroups)) {
          await store.enqueueEvent(
            botKey(s.bot),
            channel,
            id,
            `${titles[event]}\n机器人：${s.selfId}；群：${s.guildId!}\n成员：${s.userId! || '未知'}；操作人：${s.operatorId || '未知'}`,
          )
        }
        await flush()
      }),
    )
  ctx.on('ready', () => guardedEvent(flush))
  ctx.setInterval(() => guardedEvent(flush), Math.max(1000, config.noticeInterval))
  ctx.setInterval(
    () =>
      guardedEvent(async () => {
        await store.recover()
        const before = Date.now() - config.auditDays * 86400_000
        await ctx.database.remove('ember_group_audit', { created: { $lt: before } })
        const old = await ctx.database.get(
          'ember_group_request',
          { state: { $in: ['approved', 'rejected', 'expired', 'failed'] }, expires: { $lt: before } },
          { limit: 200 },
        )
        for (const row of old) {
          await ctx.database.remove('ember_group_notice', { requestId: row.id })
          await ctx.database.remove('ember_group_request', { id: row.id })
        }
      }),
    60_000,
  )
  ctx.on('dispose', () => {
    disposed = true
    sentAt.clear()
    seen.clear()
  })

  const root = ctx
    .command(config.command, '群请求审核与基础群管理', { authority: 0 })
    .action(
      () =>
        `${config.command} 请求列表 / 审核 / 同意 / 拒绝 / 禁言 / 解禁 / 全员禁言 / 踢人 / 执行 / 名片 / 撤回 / 审计 / 诊断`,
    )
  const command = <D extends string>(decl: D, description: string) =>
    root.subcommand(`.${decl}` as const, description, { authority: 0, captureQuote: false })
  async function guard<T>(fn: () => Promise<T>): Promise<T | string> {
    try {
      return await fn()
    } catch (error) {
      return error instanceof UserError || error instanceof ActionError
        ? error.message
        : '存储或服务异常，请查看操作状态后再试。'
    }
  }
  command('请求列表 [page:posint]', '列出本账户群请求').action(({ session }, page = 1) =>
    guard(async () => {
      requireReview(session!)
      await store.recover()
      const rows = await ctx.database.get(
        'ember_group_request',
        { bot: botKey(session!.bot) },
        { sort: { created: 'desc' }, offset: (page - 1) * config.pageSize, limit: config.pageSize },
      )
      return text(rows.length ? `第 ${page} 页\n` + rows.map(format).join('\n\n') : '这一页没有群请求。')
    }),
  )
  command('审核 [id:string]', '查看群请求').action(({ session }, id) =>
    guard(async () => {
      requireReview(session!)
      await store.recover()
      const row = await store.locate(botKey(session!.bot), id, session!.channelId, session!.quote?.id)
      return text(row ? format(row) : '找不到此请求；请使用请求列表中的编号，或引用原通知。')
    }),
  )
  for (const [verb, approve] of [
    ['同意', true],
    ['拒绝', false],
  ] as const) {
    command(`${verb} [id:string]`, `${verb}一条群请求`)
      .option('reason', '--原因 <text:text>')
      .action(({ session, options }, id) =>
        guard(async () => {
          const s = session!
          requireReview(s)
          await store.recover()
          const row = await store.locate(botKey(s.bot), id, s.channelId!, s.quote?.id)
          if (!row) throw new UserError('找不到此请求；不接受根据引用正文匹配，请使用编号或原通知。')
          if (row.kind === 'member') await permission(s, undefined, row.guildId, true)
          if (
            approve &&
            row.kind === 'invite' &&
            (config.inviteDeny.includes(row.guildId) ||
              (config.inviteAllow.length && !config.inviteAllow.includes(row.guildId)))
          )
            throw new UserError('此目标群被邀请名单策略限制。')
          const claim = await store.claim(row, s.userId!, approve, config.apiTimeout + 30_000)
          if (!claim) throw new UserError('请求正在处理、已结束或已过期；请刷新查看状态。')
          try {
            const reason = (options?.reason ?? '').slice(0, 300)
            await timed(
              () =>
                row.kind === 'invite'
                  ? s.bot.handleGuildRequest(row.flag, approve, reason)
                  : s.bot.handleGuildMemberRequest(row.flag, approve, reason),
              config.apiTimeout,
            )
            if (!(await store.finish(row.id, claim, approve ? 'approved' : 'rejected')))
              throw new ActionError('本地状态已变化，结果待核实。', true)
            return text(`${row.code}：平台已确认${approve ? '同意' : '拒绝'}。请以实际入群结果为准。`)
          } catch (error) {
            const state = error instanceof ActionError && !error.uncertain ? 'failed' : 'uncertain'
            await store.finish(
              row.id,
              claim,
              state,
              error instanceof ActionError ? error.message : '本地状态保存失败，结果待核实。',
            )
            return text(`${row.code}：${labels[state]}。请查看实际群请求状态，不要重复提交。`)
          }
        }),
      )
  }
  async function perform(s: Session, action: string, target: string, run: () => Promise<unknown>) {
    await audit(s, action, target, 'processing')
    try {
      await timed(run, config.apiTimeout)
      await audit(s, action, target, 'acknowledged')
      return '平台已确认操作，请核对实际群内效果。'
    } catch (error) {
      await audit(
        s,
        action,
        target,
        error instanceof ActionError && !error.uncertain ? 'failed' : 'uncertain',
      )
      throw error
    }
  }
  for (const release of [false, true])
    command(release ? '解禁 <target:string>' : '禁言 <target:string> <time:string>', '修改成员禁言').action(
      ({ session }, ...args) =>
        guard(async () => {
          const [target, time] = args
          const id = userId(target),
            ms = release ? 0 : duration(time ?? '')
          await permission(session!, id)
          return perform(session!, release ? 'unmute' : 'mute', id, () =>
            session!.bot.muteGuildMember(session!.guildId!, id, ms),
          )
        }),
    )
  command('踢人 <target:string>', '预览踢人操作').action(({ session }, target) =>
    guard(async () => {
      const s = session!,
        id = userId(target)
      await permission(s, id)
      const row = await store.confirmation({
        bot: botKey(s.bot),
        guildId: s.guildId!,
        actor: s.userId!,
        action: 'kick',
        target: id,
      })
      return `将从群 ${s.guildId!} 移出成员 ${id}。60 秒内发送：${config.command} 执行 ${row.id}`
    }),
  )
  command('全员禁言 <value:string>', '切换全员禁言').action(({ session }, value) =>
    guard(async () => {
      const s = session!
      await permission(s)
      if (!['开', '关'].includes(value)) throw new UserError('参数只能是“开”或“关”。')
      if (value === '关')
        return perform(s, 'unmute-all', s.guildId!, () => s.bot.muteChannel(s.channelId!, s.guildId!, false))
      const row = await store.confirmation({
        bot: botKey(s.bot),
        guildId: s.guildId!,
        actor: s.userId!,
        action: 'mute-all',
        target: '',
      })
      return `将开启群 ${s.guildId!} 的全员禁言。60 秒内发送：${config.command} 执行 ${row.id}`
    }),
  )
  command('执行 <code:string>', '确认一次群管操作').action(({ session }, code) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const row = await store.consume(code, botKey(s.bot), s.guildId!, s.userId!)
      if (!row) throw new UserError('确认码无效、已使用、已过期或不属于当前用户/群。')
      await permission(s, row.target || undefined)
      return perform(s, row.action, row.target || s.guildId!, () =>
        row.action === 'kick'
          ? s.bot.kickGuildMember(s.guildId!, row.target, false)
          : s.bot.muteChannel(s.channelId!, s.guildId!, true),
      )
    }),
  )
  command('名片 <target:string> <card:text>', '修改群名片').action(({ session }, target, card) =>
    guard(async () => {
      const s = session!,
        id = userId(target)
      await permission(s, id)
      if (!card || [...card].length > 60) throw new UserError('名片长度须为 1～60 字。')
      await perform(s, 'card', id, () => internal(s.bot).setGroupCard(s.guildId!, id, card))
      const actual = await timed(
        () => internal(s.bot).getGroupMemberInfo(s.guildId!, id, true),
        config.apiTimeout,
      )
      return actual.card === card ? '群名片已修改并回读确认。' : '设置已提交，回读未确认，请核对群名片。'
    }),
  )
  command('撤回', '撤回当前群引用的消息').action(({ session }) =>
    guard(async () => {
      const s = session!
      await permission(s)
      if (!s.quote?.id) throw new UserError('请引用当前群的一条消息。')
      const messageId = s.quote.id
      const message = await timed(() => internal(s.bot).getMsg(messageId), config.apiTimeout)
      if (String(message.group_id ?? '') !== s.guildId! || message.message_type !== 'group')
        throw new UserError('无法确认引用消息属于当前群。')
      const target = String(message.sender?.user_id ?? message.user_id ?? '')
      if (target && target !== s.selfId) await permission(s, target)
      return perform(s, 'recall', messageId, () => s.bot.deleteMessage(s.channelId!, messageId))
    }),
  )
  command('审计 [page:posint]', '查看当前范围操作记录').action(({ session }, page = 1) =>
    guard(async () => {
      const s = session!
      if (!canReview(s)) await permission(s)
      const rows = await ctx.database.get(
        'ember_group_audit',
        { bot: botKey(s.bot), ...(!canReview(s) ? { guildId: s.guildId! } : {}) },
        { sort: { created: 'desc' }, limit: config.pageSize, offset: (page - 1) * config.pageSize },
      )
      return text(
        rows.length
          ? rows
              .map(
                (r) =>
                  `${new Date(r.created).toLocaleString('zh-CN')} ${r.action} ${r.target}：${r.state}；操作者 ${r.actor}`,
              )
              .join('\n')
          : '没有操作记录。',
      )
    }),
  )
  command('诊断', '查看账户和模块状态').action(({ session }) =>
    guard(async () => {
      const s = session!
      if (!canReview(s)) await permission(s)
      const version = await timed(() => internal(s.bot).getVersionInfo(), config.apiTimeout)
      return text(
        `账户：${botKey(s.bot)}\n协议端：${version.app_name || '未提供'} ${version.app_version || ''}\n审核 ${config.reviews ? '开' : '关'} / 通知 ${config.notices ? '开' : '关'} / 群管 ${config.moderation ? '开' : '关'}`,
      )
    }),
  )
}
