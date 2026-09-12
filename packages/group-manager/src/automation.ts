import { Bot, Session, Universal } from 'koishi'
import { randomInt, randomUUID, createHash } from 'node:crypto'
import { Host, bounded, commandFor, plain, scope } from './support'
import { State, DataRow } from './state'
import { RequestRow, key } from './store'
import { ActionError, duration, internal, timed, userId } from './onebot'
import { UserError } from './errors'

export function scheduleTime(input: string, now = Date.now()) {
  if (/^\d+(s|m|h|d|秒|分|分钟|时|小时|天)$/.test(input)) return now + duration(input)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(input))
    throw new UserError('时间格式：10m，或 2026-10-01T22:00:00+08:00（必须带时区）。')
  const due = Date.parse(input)
  if (!Number.isFinite(due) || due <= now || due > now + 366 * 86400_000)
    throw new UserError('时间须在未来一年内。')
  return due
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const freshCode = () => randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
export function installAutomation(host: Host, state: State) {
  const { ctx, config, botKey, permission, guard, store } = host,
    cmd = commandFor(host)
  const logger = ctx.logger('yunzai-group-manager')
  let disposed = false
  const background = new Set<Promise<unknown>>()
  const call = <T>(run: () => Promise<T>) => timed(run, config.apiTimeout)
  const events = (run: () => Promise<unknown>) => {
    if (disposed) return Promise.resolve()
    const work = Promise.resolve()
      .then(run)
      .then(() => {})
      .catch(() => {
        if (!disposed) logger.warn('自动群管处理失败，请检查群管审计和数据库。')
      })
      .finally(() => background.delete(work))
    background.add(work)
    return work
  }
  const record = (s: Session, action: string, target: string, status = 'acknowledged', detail = '') =>
    store.audit({
      bot: botKey(s.bot),
      guildId: s.guildId!,
      actor: s.userId!,
      action,
      target,
      state: status,
      detail,
    })
  const inScope = async (s: Session) =>
    scope(host, s) && s.userId !== s.selfId && !(await host.lists.ignored(botKey(s.bot), s.guildId, s.userId))
  const defaultPolicy = (bot: string, guild: string, kind: string, actor: string): DataRow | undefined => {
    const payload =
      kind === 'vote-policy'
        ? { votes: 3, ttl: 300000 }
        : kind === 'verify-policy'
          ? { ttl: 300000, kick: false }
          : undefined
    return payload
      ? {
          id: state.id(bot, guild, kind),
          bot,
          guildId: guild,
          kind,
          ref: '',
          actor,
          payload,
          state: 'enabled',
          due: 0,
          updated: 0,
          lease: 0,
          claim: '',
        }
      : undefined
  }
  const policy = async (s: Session, kind: string) =>
    (await state.get(botKey(s.bot), s.guildId!, kind)) ??
    defaultPolicy(botKey(s.bot), s.guildId!, kind, s.selfId)
  const on = (value: string) => {
    if (!['开', '关'].includes(value)) throw new UserError('参数只能为开或关。')
    return value === '开'
  }
  async function editPolicy(s: Session, kind: string, value: string, payload: Record<string, any>) {
    await permission(s)
    const enabled = on(value)
    await state.put(
      botKey(s.bot),
      s.guildId!,
      kind,
      '',
      s.userId!,
      payload,
      0,
      enabled ? 'enabled' : 'disabled',
    )
    await record(s, `policy-${kind}`, value)
    return enabled
  }
  async function allowedTarget(bot: Bot, guild: string, actor: string, target: string) {
    const roles = await host.authorize(bot, guild, actor, target)
    if (roles.member?.role !== 'member' || (await host.lists.exempt(botKey(bot), guild, target)))
      throw new UserError('目标是管理员或豁免成员，已跳过。')
  }

  for (const [label, kind] of [
    ['豁免', 'exempt'],
    ['申请黑名单', 'blocked'],
  ] as const)
    cmd(`${label} <operation:string> [target:string]`, '添加/删除/列表，按当前机器人和群保存', label).action(
      ({ session }, operation, target) =>
        guard(async () => {
          const s = session!
          await permission(s)
          if (operation === '列表') {
            const rows = (await state.list(botKey(s.bot), s.guildId!, kind)).filter(
              (r) => r.state === 'enabled',
            )
            return plain(rows.map((r) => r.ref).join('\n') || '名单为空。')
          }
          if (!['添加', '删除'].includes(operation)) throw new UserError('操作为添加、删除或列表。')
          const id = userId(target)
          await state.put(
            botKey(s.bot),
            s.guildId!,
            kind,
            id,
            s.userId!,
            {},
            0,
            operation === '添加' ? 'enabled' : 'disabled',
          )
          await record(s, `${kind}-${operation}`, id)
          return `${label}已${operation} ${id}。`
        }),
    )
  cmd(
    '违禁词 <operation:string> [word:string]',
    '添加/删除/列表/预览，短语使用引号，默认包含匹配并撤回',
    '违禁词',
  )
    .option('exact', '--精确')
    .option('mute', '--禁言 <time:string>')
    .action(({ session, options }, operation, word) =>
      guard(async () => {
        const s = session!
        await permission(s)
        const rows = (await state.list(botKey(s.bot), s.guildId!, 'word')).filter(
          (r) => r.state === 'enabled',
        )
        if (operation === '列表')
          return plain(
            rows
              .map(
                (r) =>
                  `${r.ref} · ${r.payload.mode === 'exact' ? '精确' : '包含'} · 撤回${r.payload.mute ? ` + 禁言 ${r.payload.mute / 1000} 秒` : ''}`,
              )
              .join('\n') || '没有违禁词。',
          )
        const value = bounded(word ?? '', '词语', 100)
        if (operation === '预览')
          return plain(
            rows
              .filter((r) => (r.payload.mode === 'exact' ? r.ref === value : value.includes(r.ref)))
              .map((r) => r.ref)
              .join('\n') || '未命中。',
          )
        if (!['添加', '删除'].includes(operation)) throw new UserError('操作为添加、删除、列表或预览。')
        if (operation === '添加' && rows.length >= 100 && !rows.some((r) => r.ref === value))
          throw new UserError('每群最多 100 条词语规则。')
        await state.put(
          botKey(s.bot),
          s.guildId!,
          'word',
          value,
          s.userId!,
          { mode: options?.exact ? 'exact' : 'contains', mute: options?.mute ? duration(options.mute) : 0 },
          0,
          operation === '添加' ? 'enabled' : 'disabled',
        )
        await record(s, `word-${operation}`, value)
        return `违禁词已${operation}。`
      }),
    )
  for (const mute of [true, false])
    cmd(
      mute
        ? '定时禁言 <when:string> [target:string] [time:string]'
        : '定时解禁 <when:string> [target:string]',
      '创建一次定时任务，省略成员则操作全群',
      mute ? '定时禁言' : '定时解禁',
    ).action(({ session }, ...args) =>
      guard(async () => {
        const [when, target, time] = args
        const s = session!,
          id = target ? userId(target) : ''
        await permission(s, id || undefined)
        if (id && mute && (await host.lists.exempt(botKey(s.bot), s.guildId!, id)))
          throw new UserError('该成员在处罚豁免名单中。')
        if (mute && id && !time)
          throw new UserError('成员定时禁言需要提供禁言时长，例如：定时禁言 10m @成员 30m。')
        const due = scheduleTime(when),
          code = freshCode()
        if (
          (await state.list(botKey(s.bot), s.guildId!, 'schedule')).filter((r) => r.state === 'pending')
            .length >= 50
        )
          throw new UserError('每群最多 50 个待执行定时任务。')
        await state.put(
          botKey(s.bot),
          s.guildId!,
          'schedule',
          code,
          s.userId!,
          { action: mute ? 'mute' : 'unmute', target: id, duration: mute && id ? duration(time!) : 0 },
          due,
          'pending',
        )
        await record(s, 'schedule-create', code)
        return plain(
          `定时任务 ${code} 已保存：${new Date(due).toISOString()}（UTC），${id || '全群'}${mute ? '禁言' : '解禁'}。`,
        )
      }),
    )
  cmd('定时任务', '查看本群定时任务', '定时任务').action(({ session }) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const rows = (await state.list(botKey(s.bot), s.guildId!, 'schedule')).slice(0, 30)
      return plain(
        rows
          .map(
            (r) =>
              `${r.ref} · ${new Date(r.due).toISOString()} · ${r.payload.target || '全群'} ${r.payload.action} · ${r.state}${r.payload.result ? ` · ${r.payload.result}` : ''}`,
          )
          .join('\n') || '没有定时任务。',
      )
    }),
  )
  cmd('取消定时 <code:string>', '取消本群尚未执行的定时任务', '取消定时').action(({ session }, code) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const ok = await state.edit(
        state.id(botKey(s.bot), s.guildId!, 'schedule', code.toUpperCase()),
        (row) => {
          if (row.state !== 'pending') return false
          row.state = 'cancelled'
          return true
        },
      )
      if (ok) await record(s, 'schedule-cancel', code)
      return ok ? '定时任务已取消。' : '任务不存在或已开始执行。'
    }),
  )
  cmd('投票设置 <value:string>', '开启/关闭群投票处罚', '投票设置')
    .option('votes', '--票数 <count:posint>', { fallback: 3 })
    .option('ttl', '--期限 <time:string>', { fallback: '5m' })
    .action(({ session, options }, value) =>
      guard(async () => {
        if (options!.votes! < 2 || options!.votes! > 50) throw new UserError('通过票数须为 2～50。')
        const ttl = duration(options!.ttl!)
        if (ttl > 3600_000) throw new UserError('投票期限最多 1 小时。')
        const enabled = await editPolicy(session!, 'vote-policy', value, { votes: options!.votes, ttl })
        return enabled
          ? `已开启投票处罚：${options!.votes} 票通过，期限 ${ttl / 1000} 秒。`
          : '投票处罚已关闭，未执行的投票不会再处罚。'
      }),
    )
  for (const kick of [false, true])
    cmd(
      kick ? '投票踢人 <target:string>' : '投票禁言 <target:string> <time:string>',
      '发起群成员投票',
      kick ? '投票踢人' : '投票禁言',
    ).action(({ session }, ...args) =>
      guard(async () => {
        const [target, time] = args
        const s = session!
        if (!(await inScope(s))) throw new UserError('此群尚未开放群管理。')
        const p = await policy(s, 'vote-policy'),
          id = userId(target)
        if (p?.state !== 'enabled') throw new UserError('管理员尚未开启投票处罚。')
        await call(() => internal(s.bot).getGroupMemberInfo(s.guildId!, s.userId!, true))
        await allowedTarget(s.bot, s.guildId!, p.actor, id)
        if (id === s.userId) throw new UserError('不能对自己发起处罚投票。')
        const code = freshCode(),
          now = Date.now(),
          ms = kick ? 0 : duration(time!)
        await store.atomic(async (db) => {
          const live = await db.get('ember_group_data', {
            bot: botKey(s.bot),
            guildId: s.guildId!,
            kind: 'vote',
            state: { $in: ['voting', 'pending', 'processing'] },
          })
          if (live.some((r) => r.payload.target === id)) throw new UserError('该成员已有进行中的处罚投票。')
          if (live.length >= 10 || live.some((r) => r.payload.initiator === s.userId))
            throw new UserError('当前投票过多，或你已有进行中的投票。')
          await db.create('ember_group_data', {
            id: state.id(botKey(s.bot), s.guildId!, 'vote', code),
            bot: botKey(s.bot),
            guildId: s.guildId!,
            kind: 'vote',
            ref: code,
            actor: p.actor,
            state: 'voting',
            due: now + p.payload.ttl,
            lease: 0,
            updated: now,
            payload: {
              action: kick ? 'kick' : 'mute',
              target: id,
              duration: ms,
              initiator: s.userId!,
              voters: [s.userId!],
              required: p.payload.votes,
            },
          })
        })
        await record(s, 'vote-create', code)
        return `投票 ${code}：${kick ? '踢出' : `禁言 ${ms / 1000} 秒`} ${id}，1/${p.payload.votes} 票。发送“赞成 ${code}”投票。`
      }),
    )
  cmd('赞成 <code:string>', '当前群每名成员只能投一票', '赞成').action(({ session }, code) =>
    guard(async () => {
      const s = session!
      if (!(await inScope(s))) throw new UserError('此群尚未开放群管理。')
      if ((await policy(s, 'vote-policy'))?.state !== 'enabled') throw new UserError('投票处罚已关闭。')
      await call(() => internal(s.bot).getGroupMemberInfo(s.guildId!, s.userId!, true))
      const result = await state.edit(
        state.id(botKey(s.bot), s.guildId!, 'vote', code.toUpperCase()),
        (row) => {
          if (row.state !== 'voting' || row.due <= Date.now()) throw new UserError('投票已结束或过期。')
          if (row.payload.voters.includes(s.userId)) throw new UserError('你已经投过票。')
          row.payload.voters.push(s.userId)
          if (row.payload.voters.length >= row.payload.required) {
            row.state = 'pending'
            row.due = Date.now()
          }
          return `${row.payload.voters.length}/${row.payload.required} 票${row.state === 'pending' ? '，已达到通过票数。' : '。'}`
        },
      )
      if (!result) throw new UserError('本群没有此投票。')
      await record(s, 'vote-cast', code)
      events(tick)
      return result
    }),
  )
  cmd('投票列表', '查看当前群的投票', '投票列表').action(({ session }) =>
    guard(async () => {
      const s = session!
      if (!(await inScope(s))) throw new UserError('此群尚未开放群管理。')
      const rows = (await state.list(botKey(s.bot), s.guildId!, 'vote')).slice(0, 20)
      return plain(
        rows
          .map(
            (r) =>
              `${r.ref} · ${r.payload.target} · ${r.payload.voters.length}/${r.payload.required} · ${r.state}`,
          )
          .join('\n') || '没有投票。',
      )
    }),
  )
  cmd('取消投票 <code:string>', '管理员取消未执行投票', '取消投票').action(({ session }, code) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const ok = await state.edit(state.id(botKey(s.bot), s.guildId!, 'vote', code.toUpperCase()), (row) => {
        if (!['voting', 'pending'].includes(row.state)) return false
        row.state = 'cancelled'
        return true
      })
      if (ok) await record(s, 'vote-cancel', code)
      return ok ? '投票已取消。' : '投票不存在或已开始执行。'
    }),
  )
  cmd('入群验证 <value:string>', '新成员验证码验证，默认超时只提醒', '入群验证')
    .option('ttl', '--超时 <time:string>', { fallback: '10m' })
    .option('kick', '--踢出')
    .action(({ session, options }, value) =>
      guard(async () => {
        const ttl = duration(options!.ttl!)
        if (ttl < 30_000 || ttl > 86400_000) throw new UserError('验证期限须在 30 秒到 1 天之间。')
        const enabled = await editPolicy(session!, 'verify-policy', value, { ttl, kick: !!options?.kick })
        return enabled
          ? `新成员验证已开启，期限 ${ttl / 1000} 秒；超时${options?.kick ? '踢出' : '仅提醒'}。`
          : '入群验证已关闭；未完成验证不会再处罚。'
      }),
    )
  cmd('验证 <code:string>', '提交自己的入群验证码', '验证').action(({ session }, code) =>
    guard(async () => {
      const s = session!
      if (!(await inScope(s))) throw new UserError('当前会话没有入群验证。')
      const ok = await state.edit(state.id(botKey(s.bot), s.guildId!, 'verify', s.userId!), (row) => {
        if (row.state !== 'verifying' || row.due <= Date.now())
          throw new UserError('验证已过期、结束或已开始处理。')
        if (row.payload.hash !== hash(code)) {
          row.payload.attempts = (row.payload.attempts || 0) + 1
          return false
        }
        if (row.payload.attempts >= 10) throw new UserError('错误次数已达上限，请联系管理员验证通过。')
        row.state = 'verified'
        return true
      })
      if (ok) await record(s, 'verify-pass', s.userId!)
      return ok ? '验证通过，欢迎加入。' : '验证码错误或没有待验证记录。'
    }),
  )
  cmd('验证通过 <target:string>', '管理员跳过成员验证；已踢出成员需重新邀请', '验证通过').action(
    ({ session }, target) =>
      guard(async () => {
        const s = session!,
          id = userId(target)
        await permission(s)
        const ok = await state.edit(state.id(botKey(s.bot), s.guildId!, 'verify', id), (row) => {
          if (!['verifying', 'pending'].includes(row.state)) return false
          row.state = 'verified'
          return true
        })
        if (ok) await record(s, 'verify-override', id)
        return ok ? '已通过该成员的验证。' : '没有可通过的待验证记录；已执行的踢出不能自动撤销。'
      }),
  )
  cmd('自动审核 <value:string>', '启用本群成员申请名单、答案和等级策略', '自动审核')
    .option('answers', '--答案 <answers:string>')
    .option('contains', '--包含')
    .option('level', '--等级 <level:posint>')
    .action(({ session, options }, value) =>
      guard(async () => {
        const answers = options?.answers
          ? bounded(options.answers, '答案', 200).split('|').filter(Boolean)
          : []
        await editPolicy(session!, 'review-policy', value, {
          answers,
          contains: !!options?.contains,
          minLevel: options?.level ?? 0,
        })
        return value === '开'
          ? '自动审核已开启：黑名单拒绝；匹配答案才自动同意；缺少等级或没有同意条件时保留人工审核。'
          : '自动审核已关闭。'
      }),
    )
  cmd('审核预览 <content:text>', '预览当前群自动审核答案匹配，不处理申请').action(({ session }, content) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const p = await policy(s, 'review-policy')
      if (!p) return '没有配置自动审核。'
      const match = p.payload.answers.some((answer: string) =>
        p.payload.contains ? content.includes(answer) : content.trim() === answer,
      )
      return `答案${match ? '命中' : '未命中'}；${p.payload.minLevel ? '等级需等待协议事件提供，缺失保留人工审核。' : '没有等级条件。'}`
    }),
  )
  cmd('消息路由 <value:string>', '按本群配置文本转发及撤回恢复；默认不缓存正文')
    .option('target', '--目标 <group:string>')
    .option('forward', '--转发')
    .option('recall', '--撤回')
    .option('retention', '--保留 <minutes:posint>', { fallback: 30 })
    .action(({ session, options }, value) =>
      guard(async () => {
        const s = session!
        if (value === '开') {
          if (
            !options?.target ||
            options.target === s.guildId ||
            !config.reviewGroups.includes(options.target)
          )
            throw new UserError('目标必须是审核通知群，且不能等于来源群。')
          if (!options.forward && !options.recall) throw new UserError('请至少选择 --转发 或 --撤回。')
          if (options.retention! > 1440) throw new UserError('正文最多保留 1440 分钟。')
          // Validate that the configured receiver is a real group of this bot.
          await call(() => internal(s.bot).getGroupInfo(options.target!, true))
        }
        await editPolicy(s, 'route', value, {
          target: options?.target ?? '',
          forward: !!options?.forward,
          recall: !!options?.recall,
          retention: options?.retention ?? 30,
        })
        if (value === '关' || !options?.recall)
          await store.atomic((db) =>
            db.remove('ember_group_data', { bot: botKey(s.bot), guildId: s.guildId!, kind: 'message' }),
          )
        return `消息路由已${value === '开' ? '开启' : '关闭'}。只转发文本，并按设置的期限清理撤回缓存。`
      }),
    )

  async function autoRequest(s: Session, row: RequestRow) {
    let decision: boolean | undefined,
      reason = '',
      actor = 'auto-invite'
    if (row.kind === 'invite') {
      if (
        !config.autoInvite ||
        !config.inviteAllow.includes(row.guildId) ||
        config.inviteDeny.includes(row.guildId)
      )
        return
      decision = true
    } else {
      if (
        !config.moderation ||
        (config.managedGroups.length > 0 && !config.managedGroups.includes(row.guildId))
      )
        return
      const p = await state.get(row.bot, row.guildId, 'review-policy')
      if (p?.state !== 'enabled') return
      actor = p.actor
      await host.authorize(s.bot, row.guildId, p.actor)
      if ((await state.get(row.bot, row.guildId, 'blocked', row.userId))?.state === 'enabled') {
        decision = false
        reason = '申请黑名单'
      } else {
        const level = (s as any).onebot?.level
        if (p.payload.minLevel && (typeof level !== 'number' || !Number.isFinite(level))) return
        if (p.payload.minLevel && level < p.payload.minLevel) {
          decision = false
          reason = '等级不足'
        } else if (
          p.payload.answers.length &&
          p.payload.answers.some((a: string) =>
            p.payload.contains ? row.comment.includes(a) : row.comment.trim() === a,
          )
        )
          decision = true
      }
    }
    if (decision === undefined) return
    const claim = await store.claim(row, actor, decision, config.apiTimeout + 30_000)
    if (!claim) return
    try {
      await call(() =>
        row.kind === 'invite'
          ? s.bot.handleGuildRequest(row.flag, decision!, reason)
          : s.bot.handleGuildMemberRequest(row.flag, decision!, reason),
      )
      await store.finish(row.id, claim, decision ? 'approved' : 'rejected')
    } catch (e) {
      await store.finish(
        row.id,
        claim,
        e instanceof ActionError && !e.uncertain ? 'failed' : 'uncertain',
        e instanceof ActionError ? e.message : '自动审核结果待核实。',
      )
    }
  }
  async function joining(s: Session) {
    if (!(await inScope(s))) return
    const p = await policy(s, 'verify-policy')
    if (p?.state !== 'enabled') return
    try {
      await allowedTarget(s.bot, s.guildId!, p.actor, s.userId!)
    } catch {
      return
    }
    const code = String(randomInt(100000, 1000000)),
      now = Date.now()
    const id = state.id(botKey(s.bot), s.guildId!, 'verify', s.userId!)
    const created = await store.atomic(async (db) => {
      const previous = (await db.get('ember_group_data', { id }))[0]
      if (previous && ['verifying', 'pending', 'processing'].includes(previous.state)) return false
      await db.upsert('ember_group_data', [
        {
          id,
          bot: botKey(s.bot),
          guildId: s.guildId!,
          kind: 'verify',
          ref: s.userId!,
          actor: p.actor,
          due: now + p.payload.ttl,
          updated: now,
          lease: 0,
          state: 'verifying',
          payload: { hash: hash(code), kick: p.payload.kick, attempts: 0 },
        },
      ])
      return true
    })
    if (!created) return
    try {
      const ids = await call(() =>
        s.bot.sendMessage(
          s.guildId!,
          plain(
            `欢迎 ${s.userId}。请在 ${p.payload.ttl / 1000} 秒内发送“验证 ${code}”。${p.payload.kick ? '超时会被移出。' : '超时仅通知管理员。'}`,
          ),
        ),
      )
      if (!ids.length) throw new Error('Missing acknowledgement')
    } catch {
      await state.edit(id, (row) => {
        if (row.state === 'verifying' && row.payload.hash === hash(code)) row.state = 'uncertain'
      })
      await record(s, 'verify-notify', s.userId!, 'uncertain', '验证通知未确认送达，不执行超时处罚。')
    }
  }
  ctx.on('guild-member-added', (s) => events(() => joining(s)))
  ctx.on('guild-member-deleted' as 'guild-member-added', (s) =>
    events(async () => {
      if (!(await inScope(s))) return
      await state.edit(state.id(botKey(s.bot), s.guildId!, 'verify', s.userId!), (row) => {
        if (['verifying', 'pending'].includes(row.state)) row.state = 'cancelled'
      })
      const votes = await state.list(botKey(s.bot), s.guildId!, 'vote')
      for (const vote of votes.filter((r) => r.payload.target === s.userId))
        await state.edit(vote.id, (row) => {
          if (['voting', 'pending'].includes(row.state)) row.state = 'cancelled'
        })
    }),
  )

  ctx.middleware(async (s, next) => {
    if (!(await inScope(s)) || !s.messageId) return next()
    try {
      const bot = botKey(s.bot),
        guild = s.guildId!,
        user = s.userId!,
        message = s.messageId
      const content = (s.elements ?? [])
        .filter((e) => e.type === 'text')
        .map((e) => String(e.attrs.content ?? ''))
        .join('')
        .slice(0, 4000)
      // Message IDs also deduplicate rule actions and forwarding, including after a restart.
      const seenId = state.id(bot, guild, 'seen', message)
      const fresh = await store.atomic(async (db) => {
        if ((await db.get('ember_group_data', { id: seenId })).length) return false
        const now = Date.now()
        await db.create('ember_group_data', {
          id: seenId,
          bot,
          guildId: guild,
          kind: 'seen',
          ref: message,
          actor: user,
          state: 'enabled',
          due: now + 3600_000,
          updated: now,
          lease: 0,
          payload: {},
        })
        const id = state.id(bot, guild, 'activity', user),
          row = (await db.get('ember_group_data', { id }))[0]
        await db.upsert('ember_group_data', [
          {
            id,
            bot,
            guildId: guild,
            kind: 'activity',
            ref: user,
            actor: user,
            state: 'enabled',
            due: 0,
            lease: 0,
            updated: now,
            payload: { count: (row?.payload.count ?? 0) + 1, last: now },
          },
        ])
        return true
      })
      if (!fresh) return
      let route = await policy(s, 'route')
      if (route?.state === 'enabled') {
        try {
          await host.authorize(s.bot, guild, route.actor)
        } catch {
          route = undefined
        }
      }
      if (route?.state === 'enabled' && config.reviewGroups.includes(route.payload.target)) {
        if (route.payload.recall) {
          await state.put(
            bot,
            guild,
            'message',
            message,
            user,
            { content, target: route.payload.target },
            Date.now() + route.payload.retention * 60_000,
          )
          // Retention has both a time and per-group count bound.
          await store.atomic(async (db) => {
            const excess = await db.get(
              'ember_group_data',
              { bot, guildId: guild, kind: 'message' },
              { sort: { updated: 'desc' }, offset: 1000, limit: 100 },
            )
            if (excess.length) await db.remove('ember_group_data', { id: { $in: excess.map((r) => r.id) } })
          })
        }
        if (route.payload.forward && content)
          await store.enqueueEvent(
            bot,
            route.payload.target,
            key(bot, guild, message, 'forward'),
            `[群消息 ${guild}] ${user}\n${content}`,
          )
      }
      const words = (await state.list(bot, guild, 'word')).filter(
        (r) =>
          r.state === 'enabled' &&
          (r.payload.mode === 'exact' ? r.ref === content.trim() : content.includes(r.ref)),
      )
      if (words.length && !(await host.lists.exempt(bot, guild, user))) {
        const strongest = words.sort((a, b) => b.payload.mute - a.payload.mute)[0]
        try {
          await allowedTarget(s.bot, guild, strongest.actor, user)
          const task = await state.put(
            bot,
            guild,
            'word-action',
            message,
            strongest.actor,
            { target: user, duration: strongest.payload.mute },
            Date.now(),
            'pending',
          )
          const claim = await state.claim(task.id, config.apiTimeout * 3 + 30_000)
          if (claim) {
            try {
              await call(() => s.bot.deleteMessage(s.channelId!, message))
              if (strongest.payload.mute)
                await call(() => s.bot.muteGuildMember(guild, user, strongest.payload.mute))
              await state.finish(
                task.id,
                claim.claim,
                'acknowledged',
                '已撤回违禁词消息' + (strongest.payload.mute ? '并提交禁言' : ''),
              )
            } catch (e) {
              await state.finish(
                task.id,
                claim.claim,
                e instanceof ActionError && !e.uncertain ? 'failed' : 'uncertain',
                '撤回或禁言未全部确认，请核对审计与实际状态。',
              )
            }
            return
          }
        } catch (e) {
          if (!(e instanceof UserError)) throw e
        }
      }
    } catch {
      logger.warn('消息规则处理失败；没有绕过权限执行自动处罚。')
    }
    return next()
  }, true)
  ctx.on('message-deleted', (s) =>
    events(async () => {
      if (!scope(host, s) || !s.messageId || (await host.lists.ignored(botKey(s.bot), s.guildId, s.userId)))
        return
      const route = await policy(s, 'route')
      if (
        route?.state !== 'enabled' ||
        !route.payload.recall ||
        !config.reviewGroups.includes(route.payload.target)
      )
        return
      const cached = await state.get(botKey(s.bot), s.guildId!, 'message', s.messageId)
      const body =
        cached && cached.due > Date.now()
          ? `${cached.actor}\n${cached.payload.content || '[无文本正文]'}`
          : '未缓存或已过期，无法恢复正文。'
      await store.enqueueEvent(
        botKey(s.bot),
        route.payload.target,
        key(botKey(s.bot), s.guildId!, s.messageId, 'recall'),
        `[撤回恢复 ${s.guildId}] 消息 ${s.messageId}\n${body}`,
      )
      await host.flush()
    }),
  )

  let busy = false
  async function execute(bot: Bot, row: DataRow) {
    if (row.kind === 'verify') {
      const p =
        (await state.get(row.bot, row.guildId, 'verify-policy')) ??
        defaultPolicy(row.bot, row.guildId, 'verify-policy', bot.selfId)
      if (p?.state !== 'enabled') throw new UserError('入群验证已关闭。')
      await allowedTarget(bot, row.guildId, row.actor, row.ref)
      if (row.payload.kick && p.payload.kick)
        await call(() => bot.kickGuildMember(row.guildId, row.ref, false))
      else {
        await host.notifyVerification(bot, row.guildId, row.ref, key(row.id, String(row.updated), 'timeout'))
      }
      return
    }
    if (row.kind === 'vote') {
      const p =
        (await state.get(row.bot, row.guildId, 'vote-policy')) ??
        defaultPolicy(row.bot, row.guildId, 'vote-policy', bot.selfId)
      if (p?.state !== 'enabled') throw new UserError('投票处罚已关闭。')
      await allowedTarget(bot, row.guildId, row.actor, row.payload.target)
    } else {
      await host.authorize(bot, row.guildId, row.actor, row.payload.target || undefined)
      if (
        row.payload.target &&
        row.payload.action === 'mute' &&
        (await host.lists.exempt(row.bot, row.guildId, row.payload.target))
      )
        throw new UserError('目标在处罚豁免名单。')
    }
    if (
      !row.payload.target &&
      row.payload.action === 'mute' &&
      (await host.lists.groupExempt(row.bot, row.guildId))
    )
      throw new UserError('该群在处罚豁免白名单中。')
    if (row.payload.action === 'kick')
      await call(() => bot.kickGuildMember(row.guildId, row.payload.target, false))
    else if (row.payload.target)
      await call(() =>
        bot.muteGuildMember(
          row.guildId,
          row.payload.target,
          row.payload.action === 'mute' ? row.payload.duration : 0,
        ),
      )
    else await call(() => bot.muteChannel(row.guildId, row.guildId, row.payload.action === 'mute'))
  }
  async function tick() {
    if (busy || disposed || !ctx.bots.some(host.active)) return
    busy = true
    try {
      await state.recover()
      const now = Date.now()
      await store.atomic(async (db) => {
        await db.set(
          'ember_group_data',
          { kind: 'vote', state: 'voting', due: { $lte: now } },
          { state: 'expired' },
        )
        await db.set(
          'ember_group_data',
          { kind: 'verify', state: 'verifying', due: { $lte: now } },
          { state: 'pending' },
        )
        await db.remove('ember_group_data', { kind: { $in: ['seen', 'message'] }, due: { $lte: now } })
        await db.remove('ember_group_data', {
          kind: { $in: ['vote', 'schedule', 'verify', 'word-action'] },
          state: { $in: ['acknowledged', 'failed', 'uncertain', 'expired', 'cancelled', 'verified'] },
          updated: { $lt: now - config.auditDays * 86400_000 },
        })
      })
      const due = await store.db.get(
        'ember_group_data',
        { kind: { $in: ['schedule', 'vote', 'verify'] }, state: 'pending', due: { $lte: now } },
        { sort: { due: 'asc' }, limit: 30 },
      )
      for (const task of due) {
        if (disposed) break
        const bot = ctx.bots.find(
          (b) => host.active(b) && botKey(b) === task.bot && b.status === Universal.Status.ONLINE,
        )
        if (!bot) continue
        const row = await state.claim(task.id, config.apiTimeout * 3 + 30_000)
        if (!row) continue
        try {
          if (
            !config.moderation ||
            (config.managedGroups.length > 0 && !config.managedGroups.includes(row.guildId))
          )
            throw new UserError('当前群已移出管理范围。')
          await execute(bot, row)
          await state.finish(row.id, row.claim, 'acknowledged', '平台操作已确认，或提醒已入队。')
        } catch (e) {
          await state.finish(
            row.id,
            row.claim,
            e instanceof UserError
              ? 'cancelled'
              : e instanceof ActionError && !e.uncertain
                ? 'failed'
                : 'uncertain',
            e instanceof UserError || e instanceof ActionError ? e.message : '自动操作结果待核实。',
          )
        }
      }
    } finally {
      busy = false
    }
  }
  ctx.on('ready', () => events(tick))
  ctx.setInterval(() => events(tick), 1000)
  ctx.on('dispose', async () => {
    disposed = true
    await Promise.allSettled([...background])
  })
  return { autoRequest }
}
