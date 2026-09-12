import { Context, Session, h, Bot } from 'koishi'
import { Store, models, RequestRow, EventRow } from './store'
import { ActionError, duration, internal, timed, userId } from './onebot'
import { UserError } from './errors'
import { State, stateModel } from './state'
import { Lists, installLists } from './lists'
import { Notifications } from './notifications'
import type { Host } from './support'

export const name = 'yunzai-group-manager'
export const inject = ['database']
export const usage =
  '日常群管默认在所有群可用，仍需真实群管理权限。事件监听和事件通知独立且默认开启，默认私聊 reviewers 中的管理员；可用“事件监听 开 --群 群号 --私聊 QQ”和“事件通知 关 成员变动”修改。黑名单忽略消息，白名单豁免处罚和验证。\n\n迁移来源：[yenai-plugin / yeyang52 及贡献者](https://github.com/yeyang52/yenai-plugin)、[GroupEntry_Plugin / A1Panda 及贡献者](https://github.com/A1Panda/GroupEntry_Plugin)。详见安装包 THIRD_PARTY_NOTICES.md。'
export { Config } from './config'
import { Config } from './config'
import { installFeatures } from './features'
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
  stateModel(ctx)
  const store = new Store(ctx.database)
  const lists = new Lists(new State(store), config)
  let notifications: Notifications
  const logger = ctx.logger(name)
  let disposed = false,
    flushing = false
  const background = new Set<Promise<unknown>>()
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
      (!reviewer &&
        (!config.moderation || (config.managedGroups.length > 0 && !config.managedGroups.includes(guild))))
    )
      throw new UserError('此群尚未开放群管理。')
    if (await lists.ignored(botKey(s.bot), guild, s.userId)) throw new UserError('此会话已被黑名单忽略。')
    return authorize(s.bot, guild, s.userId!, target)
  }
  async function authorize(bot: Bot, guild: string, actorId: string, target?: string) {
    if (await lists.ignored(botKey(bot), guild, actorId)) throw new UserError('此会话已被黑名单忽略。')
    const api = internal(bot)
    let actor, self, member
    try {
      ;[actor, self, member] = await timed(
        () =>
          Promise.all([
            api.getGroupMemberInfo(guild, actorId, true),
            api.getGroupMemberInfo(guild, bot.selfId, true),
            target ? api.getGroupMemberInfo(guild, target, true) : Promise.resolve(undefined),
          ]),
        config.apiTimeout,
      )
    } catch {
      throw new UserError('无法核验目标群角色，请稍后再试。')
    }
    if (!['admin', 'owner'].includes(actor.role)) throw new UserError('操作人须为目标群管理员或群主。')
    if (!['admin', 'owner'].includes(self.role)) throw new UserError('机器人没有目标群管理权限。')
    if (target === bot.selfId) throw new UserError('不能对机器人自身执行此操作。')
    if (
      member &&
      (member.role === 'owner' ||
        (member.role === 'admin' && (actor.role !== 'owner' || self.role !== 'owner')))
    )
      throw new UserError('无法对该群主或管理员执行此操作。')
    return { actor, self, member }
  }

  async function flush() {
    if (flushing || disposed) return
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
      for (const bot of ctx.bots.filter(active)) {
        const pending = await ctx.database.get('ember_group_event', { bot: botKey(bot), state: 'pending' })
        for (const channel of new Set(pending.map((row) => row.channel))) {
          if (disposed) break
          const slot = `${botKey(bot)}:${channel}`
          if (Date.now() - (sentAt.get(slot) ?? 0) < config.noticeInterval) continue
          const { rows, claim } = await store.claimEvents(botKey(bot), channel, config.apiTimeout + 30_000)
          if (!rows.length) continue
          const deliverable: EventRow[] = []
          for (const row of rows) {
            if (await notifications.canDeliver(bot, row)) deliverable.push(row)
            else
              await ctx.database.set(
                'ember_group_event',
                { id: row.id, claim },
                { state: 'cancelled', lease: 0 },
              )
          }
          if (!deliverable.length) continue
          sentAt.set(slot, Date.now())
          try {
            const ids = await timed(
              () =>
                (channel.startsWith('p:') ? bot.sendPrivateMessage.bind(bot) : bot.sendMessage.bind(bot))(
                  channel.startsWith('p:') || channel.startsWith('g:') ? channel.slice(2) : channel,
                  text(
                    deliverable
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
    if (
      !config.reviews ||
      !active(s.bot) ||
      !s.guildId! ||
      (await lists.ignored(botKey(s.bot), s.guildId, s.userId))
    )
      return
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
    if (request.state === 'pending') {
      try {
        await features.autoRequest(s, request)
      } catch {
        logger.warn('自动审核条件无法核验，已保留人工审核。')
      }
    }
    if ((await ctx.database.get('ember_group_request', { id: request.id }))[0]?.state === 'pending')
      for (const channel of new Set(config.reviewGroups)) await store.notice(request, channel)
    await flush()
  }
  const guardedEvent = (fn: () => Promise<unknown>) => {
    if (disposed) return Promise.resolve()
    const work = Promise.resolve()
      .then(fn)
      .then(() => {})
      .catch(() => {
        if (!disposed) logger.warn('群事件处理失败，请检查数据库和待处理请求。')
      })
      .finally(() => background.delete(work))
    background.add(work)
    return work
  }
  ctx.on('guild-request', (s) => guardedEvent(() => receive(s, 'invite')))
  ctx.on('guild-member-request', (s) => guardedEvent(() => receive(s, 'member')))

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
  ctx.on('dispose', async () => {
    disposed = true
    await Promise.allSettled([...background])
    sentAt.clear()
    seen.clear()
  })

  const root = ctx
    .command(config.command, '群审核、日常管理与自动规则', { authority: 0 })
    .action(
      () =>
        `${config.command} 请求列表 / 审核 / 同意 / 拒绝 / 禁言 / 解禁 / 全员禁言 / 踢人 / 名片 / 撤回 / 帮助 / 审计 / 诊断`,
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
          if (row.kind === 'member') {
            await permission(s, undefined, row.guildId, true)
            if (approve && (await features.blocked(botKey(s.bot), row.guildId, row.userId)))
              throw new UserError('申请人在本群申请黑名单中，请先移除名单再同意。')
          }
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
          if (!release) await features.punishable(session!, id)
          return perform(session!, release ? 'unmute' : 'mute', id, () =>
            session!.bot.muteGuildMember(session!.guildId!, id, ms),
          )
        }),
    )
  command('踢人 <target:string>', '移出一名群成员')
    .option('block', '--拉黑', { fallback: false })
    .action(({ session, options }, target) =>
      guard(async () => {
        const s = session!,
          id = userId(target)
        await permission(s, id)
        await features.punishable(s, id)
        return perform(s, 'kick', id, () => s.bot.kickGuildMember(s.guildId!, id, options?.block ?? false))
      }),
    )
  command('全员禁言 <value:string>', '切换全员禁言').action(({ session }, value) =>
    guard(async () => {
      const s = session!
      await permission(s)
      if (!['开', '关'].includes(value)) throw new UserError('参数只能是“开”或“关”。')
      if (value === '开' && (await lists.groupExempt(botKey(s.bot), s.guildId!)))
        throw new UserError('该群在处罚豁免白名单中。')
      return perform(s, value === '开' ? 'mute-all' : 'unmute-all', s.guildId!, () =>
        s.bot.muteChannel(s.channelId!, s.guildId!, value === '开'),
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
  const host: Host = {
    ctx,
    config,
    root,
    store,
    lists,
    active,
    botKey,
    permission,
    authorize,
    perform,
    guard,
    requireReview,
    flush,
    notifyVerification: (bot, guild, user, eventId) =>
      notifications.verificationTimeout(bot, guild, user, eventId),
  }
  notifications = new Notifications(host, lists.state)
  notifications.install()
  const features = installFeatures(host)
  installLists(host)
  if (config.shortcuts)
    for (const verb of ['禁言', '解禁', '踢人', '全员禁言', '名片', '撤回']) {
      ctx.$commander.resolve(`${config.command}.${verb}`)?.alias(verb)
    }
}
