import { Session, h } from 'koishi'
import {
  Host,
  bounded,
  commandFor,
  plain,
  quoteId,
  punishable,
  finiteTime,
  memberLine,
  scope,
} from './support'
import { State, stateModel } from './state'
import { UserError } from './errors'
import { duration, internal, timed, Member } from './onebot'
import { request, mediaKind, PublicError } from './net'
import { installAutomation } from './automation'

export function installFeatures(host: Host) {
  const { ctx, config, permission, perform, guard, botKey } = host
  const state = new State(host.store),
    cmd = commandFor(host)
  const api = (s: Session) => internal(s.bot)
  const call = <T>(run: () => Promise<T>) => timed(run, config.apiTimeout)
  const members = async (s: Session) => {
    const rows = await call(() => api(s).getGroupMemberList(s.guildId!))
    if (!Array.isArray(rows)) throw new UserError('协议端没有返回有效成员列表。')
    return rows
  }
  const page = <T>(rows: T[], index: number, format: (row: T) => string) =>
    plain(
      rows.length
        ? `共 ${rows.length} 条，第 ${index} 页\n${rows
            .slice((index - 1) * config.pageSize, index * config.pageSize)
            .map(format)
            .join('\n')}`
        : '没有记录。',
    )
  const actorAudit = (s: Session, action: string, target: string, detail = '') =>
    host.store.audit({
      bot: botKey(s.bot),
      guildId: s.guildId!,
      actor: s.userId!,
      action,
      target,
      state: 'acknowledged',
      detail,
    })
  // On QQ a group has one owner. The configured reviewer may control an owner bot.
  const ownerBot = async (s: Session) => {
    const roles = await permission(s)
    if (roles.self.role !== 'owner') throw new UserError('此操作要求机器人为群主。')
    if (roles.actor.role !== 'owner' && !config.reviewers.includes(s.userId!))
      throw new UserError('此群主功能仅开放给配置的审核人。')
  }
  for (const enable of [true, false])
    cmd(
      `${enable ? '设置管理' : '取消管理'} <target:string>`,
      '设置群管理员',
      enable ? '设置管理' : '取消管理',
    ).action(({ session }, target) =>
      guard(async () => {
        const s = session!,
          id = targetId(target)
        await ownerBot(s)
        const member = await call(() => api(s).getGroupMemberInfo(s.guildId!, id, true))
        if (id === s.selfId || member.role === 'owner')
          throw new UserError('不能修改群主或机器人自身的角色。')
        await perform(s, enable ? 'admin-add' : 'admin-remove', id, () =>
          api(s).setGroupAdmin(s.guildId!, id, enable),
        )
        const after = await call(() => api(s).getGroupMemberInfo(s.guildId!, id, true))
        return after.role === (enable ? 'admin' : 'member')
          ? '管理员角色已修改并回读确认。'
          : '设置已提交，回读未确认，请核对群成员角色。'
      }),
    )
  for (const clear of [false, true])
    cmd(
      clear ? '清除头衔 <target:string>' : '头衔 <target:string> <title:text>',
      '设置或清除成员头衔',
      clear ? '清除头衔' : '设置头衔',
    ).action(({ session }, ...args) =>
      guard(async () => {
        const [target, title] = args
        const s = session!,
          id = targetId(target)
        await ownerBot(s)
        const value = clear ? '' : bounded(title ?? '', '头衔', 18)
        await call(() => api(s).getGroupMemberInfo(s.guildId!, id, true))
        return perform(s, 'title', id, () => api(s).setGroupSpecialTitle(s.guildId!, id, value, -1))
      }),
    )
  cmd('头衔申请 <title:text>', '申请自己的群头衔（默认开启，要求机器人为群主）', '申请头衔').action(
    ({ session }, title) =>
      guard(async () => {
        const s = session!
        if (!scope(host, s)) throw new UserError('此群尚未开放群管理。')
        const policy = await state.get(botKey(s.bot), s.guildId!, 'titles')
        if (policy?.state === 'disabled') throw new UserError('此群尚未开启头衔申请。')
        const value = bounded(title, '头衔', 18)
        const words = await state.list(botKey(s.bot), s.guildId!, 'word')
        if (
          words.some(
            (r) =>
              r.state === 'enabled' && (r.payload.mode === 'exact' ? value === r.ref : value.includes(r.ref)),
          )
        )
          throw new UserError('头衔包含当前群屏蔽的词语。')
        const roles = await host.authorize(s.bot, s.guildId!, policy?.actor ?? s.selfId)
        if (roles.self.role !== 'owner') throw new UserError('此操作要求机器人为群主。')
        await call(() => api(s).getGroupMemberInfo(s.guildId!, s.userId!, true))
        return perform(s, 'self-title', s.userId!, () =>
          api(s).setGroupSpecialTitle(s.guildId!, s.userId!, value, -1),
        )
      }),
  )
  cmd('开放头衔 <value:string>', '开/关成员自助头衔').action(({ session }, value) =>
    guard(async () => {
      const s = session!
      await ownerBot(s)
      if (!['开', '关'].includes(value)) throw new UserError('参数只能是开或关。')
      await state.put(
        botKey(s.bot),
        s.guildId!,
        'titles',
        '',
        s.userId!,
        {},
        0,
        value === '开' ? 'enabled' : 'disabled',
      )
      await actorAudit(s, 'titles-policy', value)
      return `头衔申请已${value === '开' ? '开启' : '关闭'}。`
    }),
  )
  cmd('群名 <name:text>', '修改当前群名称', '修改群名').action(({ session }, name) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const value = bounded(name, '群名', 60)
      await perform(s, 'group-name', s.guildId!, () => api(s).setGroupName(s.guildId!, value))
      return (await call(() => api(s).getGroupInfo(s.guildId!, true))).group_name === value
        ? '群名已修改并回读确认。'
        : '设置已提交，回读未确认，请核对群名。'
    }),
  )
  cmd('群头像 [image:text]', '发送或引用图片以设置当前群头像', '设置群头像').action(({ session }) =>
    guard(async () => {
      const s = session!
      await permission(s)
      let elements = s.elements ?? []
      if (s.quote) {
        await quoteId(host, s)
        elements = [...elements, ...(s.quote.elements ?? [])]
      }
      const src = elements.find((e) => ['img', 'image'].includes(e.type))?.attrs.src
      if (typeof src !== 'string') throw new UserError('请随指令发送图片，或引用当前群的一张图片。')
      let bytes: Buffer
      try {
        const response = await request(src, {
          hosts: config.avatarHosts,
          maxBytes: 5 * 1024 * 1024,
          timeout: config.apiTimeout,
        })
        bytes = response.body
        if (mediaKind(bytes) !== 'image') throw new PublicError('返回内容不是图片。')
      } catch (e) {
        throw new UserError(e instanceof PublicError ? e.message : '读取群头像图片失败。')
      }
      return perform(s, 'portrait', s.guildId!, () =>
        api(s).setGroupPortrait(s.guildId!, `base64://${bytes.toString('base64')}`, 0),
      )
    }),
  )
  cmd('公告 <content:text>', '发布群公告', '群公告').action(({ session }, content) =>
    guard(async () => {
      const s = session!
      await permission(s)
      return perform(s, 'notice-add', s.guildId!, () =>
        api(s).sendGroupNotice(s.guildId!, bounded(content, '公告', 2000)),
      )
    }),
  )
  cmd('公告列表 [page:posint]', '查看群公告', '公告列表').action(({ session }, index = 1) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const rows = await call(() => api(s).getGroupNotice(s.guildId!))
      if (!Array.isArray(rows)) throw new UserError('协议端未返回可读取的群公告列表。')
      return page(
        rows,
        index,
        (r) =>
          `${r.notice_id ?? '无可删除编号'}：${String(r.message?.text ?? r.content ?? '').slice(0, 400)}`,
      )
    }),
  )
  cmd('删除公告 <id:string>', '删除当前群的一条公告', '删除公告').action(({ session }, id) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const rows = await call(() => api(s).getGroupNotice(s.guildId!))
      if (!Array.isArray(rows) || !rows.some((r) => String(r.notice_id) === id))
        throw new UserError('当前群没有此公告编号。')
      // Official adapter coerces short numeric *_id values; SnowLuma expects an opaque string.
      return perform(s, 'notice-delete', id, () =>
        api(s)._get('_del_group_notice', { group_id: Number(s.guildId), notice_id: id }),
      )
    }),
  )
  for (const remove of [false, true])
    cmd(remove ? '移精' : '加精', '操作当前群引用消息的精华状态', remove ? '移精' : '加精').action(
      ({ session }) =>
        guard(async () => {
          const s = session!
          await permission(s)
          const id = await quoteId(host, s)
          return perform(s, remove ? 'essence-remove' : 'essence-add', id, () =>
            remove ? api(s).deleteEssenceMsg(id) : api(s).setEssenceMsg(id),
          )
        }),
    )
  cmd('精华列表 [page:posint]', '列出群精华消息', '精华列表').action(({ session }, index = 1) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const rows = await call(() => api(s).getEssenceMsgList(s.guildId!))
      if (!Array.isArray(rows)) throw new UserError('协议端未返回有效精华列表。')
      return page(rows, index, (r) => `消息 ${r.message_id} · ${r.sender_nick ?? r.sender_id ?? '未知成员'}`)
    }),
  )
  cmd('成员 <target:string>', '查询当前群成员信息', '群成员').action(({ session }, target) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const m = await call(() => api(s).getGroupMemberInfo(s.guildId!, targetId(target), true))
      const date = (value?: number) =>
        finiteTime(value) ? new Date(finiteTime(value)!).toLocaleString('zh-CN') : '协议未提供，无法判断'
      return plain(
        `${memberLine(m)}\n身份：${m.role}；头衔：${m.title || '无'}\n入群：${date(m.join_time)}\n最近发言：${date(m.last_sent_time)}`,
      )
    }),
  )
  cmd('禁言列表 [page:posint]', '查看当前禁言成员', '禁言列表').action(({ session }, index = 1) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const rows = await members(s)
      if (rows.length && !rows.some((m) => typeof m.shut_up_timestamp === 'number'))
        throw new UserError('协议成员列表未提供禁言结束时间，无法判断。')
      return page(
        rows.filter((m) => (finiteTime(m.shut_up_timestamp) ?? 0) > Date.now()),
        index,
        (m) => `${memberLine(m)} · 至 ${new Date(finiteTime(m.shut_up_timestamp)!).toLocaleString('zh-CN')}`,
      )
    }),
  )
  cmd('解除全部禁言', '逐个解除当前群成员禁言', '解除全部禁言').action(({ session }) =>
    guard(async () => {
      const s = session!
      await permission(s)
      const rows = await members(s)
      if (rows.length && !rows.some((m) => typeof m.shut_up_timestamp === 'number'))
        throw new UserError('协议成员列表未提供禁言结束时间，无法判断。')
      const muted = rows.filter((m) => (finiteTime(m.shut_up_timestamp) ?? 0) > Date.now()).slice(0, 100)
      const results: string[] = []
      for (const m of muted) {
        const result = await guard(async () => {
          await permission(s, String(m.user_id))
          return perform(s, 'unmute-batch', String(m.user_id), () =>
            s.bot.muteGuildMember(s.guildId!, String(m.user_id), 0),
          )
        })
        results.push(`${m.user_id}：${result}`)
      }
      return plain(results.join('\n') || '没有可解除的成员禁言。')
    }),
  )
  for (const kind of ['活跃排行', '潜水排行', '最近入群'] as const)
    cmd(`${kind} [page:posint]`, '查询成员活动信息', kind).action(({ session }, index = 1) =>
      guard(async () => {
        const s = session!
        await permission(s)
        if (kind === '活跃排行') {
          const rows = await state.list(botKey(s.bot), s.guildId!, 'activity')
          rows.sort((a, b) => Number(b.payload.count) - Number(a.payload.count))
          return plain(
            `自插件记录起累计发言排行（不是 QQ 网页历史统计）\n${page(rows, index, (r) => `${r.ref}：${r.payload.count} 条`)}`,
          )
        }
        const field = kind === '最近入群' ? 'join_time' : 'last_sent_time'
        const rows = await members(s),
          valid = rows.filter((m) => finiteTime(m[field]))
        valid.sort((a, b) => (kind === '最近入群' ? b[field]! - a[field]! : a[field]! - b[field]!))
        return plain(
          `${rows.length - valid.length} 名成员缺少时间，未参与排序。\n${page(valid, index, (m) => `${memberLine(m)} · ${new Date(finiteTime(m[field])!).toLocaleString('zh-CN')}`)}`,
        )
      }),
    )
  cmd('清理潜水 <days:posint>', '查看长期不发言成员；--执行逐个清理', '清理潜水')
    .option('execute', '--执行')
    .action(({ session, options }, days) =>
      guard(async () => {
        const s = session!
        await permission(s)
        if (days > 3650) throw new UserError('天数范围为 1～3650。')
        const cutoff = Date.now() - days * 86400_000
        const stale = (m: Member) =>
          m.role === 'member' &&
          !!finiteTime(m.last_sent_time) &&
          finiteTime(m.last_sent_time)! < cutoff &&
          !!finiteTime(m.join_time) &&
          finiteTime(m.join_time)! < cutoff
        const rows = (await members(s)).filter(stale),
          eligible: Member[] = []
        for (const m of rows)
          if (
            (await state.get(botKey(s.bot), s.guildId!, 'exempt', String(m.user_id)))?.state !== 'enabled' &&
            String(m.user_id) !== s.selfId
          )
            eligible.push(m)
        if (!options?.execute)
          return plain(
            `符合条件 ${eligible.length} 人（忽略缺少时间的成员和豁免成员）：\n${eligible.slice(0, 30).map(memberLine).join('\n')}\n发送“${config.command} 清理潜水 ${days} --执行”执行当前条件；每次最多 30 人。`,
          )
        const results: string[] = []
        for (const m of eligible.slice(0, 30)) {
          const id = String(m.user_id)
          results.push(
            `${id}：${await guard(async () => {
              const roles = await permission(s, id)
              await punishable(host, state, s, id)
              if (!roles.member || !stale(roles.member)) throw new UserError('成员活动或角色已变化，跳过。')
              return perform(s, 'inactive-kick', id, () => s.bot.kickGuildMember(s.guildId!, id, false))
            })}`,
          )
        }
        return plain(results.join('\n') || '没有可清理成员。')
      }),
    )
  cmd('自闭 <time:string>', '只禁言自己', '我要自闭').action(({ session }, time) =>
    guard(async () => {
      const s = session!,
        ms = duration(time)
      if (!scope(host, s)) throw new UserError('此群尚未开放群管理。')
      const [member, self] = await call(() =>
        Promise.all([
          api(s).getGroupMemberInfo(s.guildId!, s.userId!, true),
          api(s).getGroupMemberInfo(s.guildId!, s.selfId, true),
        ]),
      )
      if (member.role !== 'member' || !['admin', 'owner'].includes(self.role))
        throw new UserError('自闭仅支持普通成员，且机器人需要管理权限。')
      const id = state.id(botKey(s.bot), s.guildId!, 'self-mute', s.userId!)
      const claimed = await host.store.atomic(async (db) => {
        const row = (await db.get('ember_group_data', { id }))[0]
        if (row && Date.now() - row.updated < 60_000) return false
        await db.upsert('ember_group_data', [
          {
            id,
            bot: botKey(s.bot),
            guildId: s.guildId!,
            kind: 'self-mute',
            ref: s.userId!,
            actor: s.userId!,
            state: 'enabled',
            payload: {},
            due: 0,
            lease: 0,
            updated: Date.now(),
          },
        ])
        return true
      })
      if (!claimed) throw new UserError('每分钟只能申请一次自闭。')
      return perform(s, 'self-mute', s.userId!, () => s.bot.muteGuildMember(s.guildId!, s.userId!, ms))
    }),
  )
  cmd('群列表 [page:posint]', '查看当前机器人管理范围内的群', '群列表').action(({ session }, index = 1) =>
    guard(async () => {
      const s = session!
      if (!config.reviewers.includes(s.userId!) || !host.active(s.bot)) await permission(s)
      const rows = await call(() => api(s).getGroupList(true))
      return page(
        rows.filter((r) => !config.managedGroups.length || config.managedGroups.includes(String(r.group_id))),
        index,
        (r) => `${r.group_id} · ${r.group_name} (${r.member_count ?? '?'} 人)`,
      )
    }),
  )
  cmd('退群 <group:string>', '退出明确指定的当前群（不会解散）', '机器人退群').action(({ session }, group) =>
    guard(async () => {
      const s = session!
      await permission(s)
      if (group !== s.guildId) throw new UserError('请明确填写当前群号；此命令不接受跨群目标。')
      if (!config.reviewers.includes(s.userId!)) throw new UserError('退群仅允许配置的审核人操作。')
      return perform(s, 'leave', group, () => api(s).setGroupLeave(group, false))
    }),
  )
  cmd('通知 <groups:string> <content:text>', '向指定管理群发送通知，群号用逗号分隔', '发通知').action(
    ({ session }, groups, content) =>
      guard(async () => {
        const s = session!,
          targets = [...new Set(groups.split(/[,，]/))],
          value = bounded(content, '通知', 2000)
        await permission(s)
        if (
          !targets.length ||
          targets.length > 10 ||
          targets.some(
            (g) =>
              !/^\d{1,20}$/.test(g) || (config.managedGroups.length > 0 && !config.managedGroups.includes(g)),
          )
        )
          throw new UserError('通知目标须为可管理的群号，一次最多 10 群。')
        const results: string[] = []
        for (const guild of targets) {
          results.push(
            `${guild}：${await guard(async () => {
              await permission(s, undefined, guild)
              return perform(s, 'broadcast', guild, async () => {
                const ids = await s.bot.sendMessage(guild, plain(value))
                if (!ids.length) throw new Error('Missing acknowledgement')
              })
            })}`,
          )
          if (guild !== targets.at(-1))
            await new Promise<void>((resolve) => ctx.setTimeout(resolve, config.noticeInterval))
        }
        return plain(results.join('\n'))
      }),
  )
  cmd('群荣誉 [type:string]', '查询群龙王等协议提供的荣誉', '群荣誉').action(({ session }, type = 'all') =>
    guard(async () => {
      const s = session!
      await permission(s)
      if (!['all', 'talkative', 'performer', 'legend', 'strong_newbie', 'emotion'].includes(type))
        throw new UserError('类型：all / talkative / performer / legend / strong_newbie / emotion。')
      const result = await call(() => api(s).getGroupHonorInfo(s.guildId!, type))
      return plain(JSON.stringify(result).slice(0, 3000))
    }),
  )
  cmd('打卡列表', '读取协议提供的群打卡列表', '群打卡列表').action(({ session }) =>
    guard(async () => {
      const s = session!
      await permission(s)
      return plain(JSON.stringify(await call(() => api(s).getGroupSignedList(s.guildId!))).slice(0, 3000))
    }),
  )
  cmd('历史申请', '读取平台保留的群申请；无有效 flag 时只能查看').action(({ session }) =>
    guard(async () => {
      const s = session!
      await host.requireReview(s)
      const data = await call(() => api(s).getGroupSystemMsg())
      const rows = [
        ...(Array.isArray(data?.invited_requests) ? data.invited_requests : []),
        ...(Array.isArray(data?.join_requests) ? data.join_requests : []),
      ]
      return page(
        rows,
        1,
        (r) =>
          `群 ${r.group_id} · ${r.requester_uin ?? r.invitor_uin ?? '未知'} · ${String(r.message ?? '').slice(0, 120)} · ${typeof r.flag === 'string' && r.flag ? '含可补录 flag' : '协议未提供可操作 flag，仅供查看'}`,
      )
    }),
  )
  cmd('补录申请', '仅补录平台明确返回有效 flag 的群申请').action(({ session }) =>
    guard(async () => {
      const s = session!
      await host.requireReview(s)
      const data = await call(() => api(s).getGroupSystemMsg())
      let imported = 0,
        skipped = 0
      for (const [field, kind, user] of [
        ['invited_requests', 'invite', 'invitor_uin'],
        ['join_requests', 'member', 'requester_uin'],
      ]) {
        for (const r of (Array.isArray(data?.[field]) ? data[field] : []).slice(0, 100)) {
          if (
            typeof r.flag !== 'string' ||
            !r.flag ||
            r.flag.length > 2048 ||
            !/^\d+$/.test(String(r.group_id)) ||
            !/^\d+$/.test(String(r[user])) ||
            r.checked === true
          ) {
            skipped++
            continue
          }
          const row = await host.store.receive(
            {
              bot: botKey(s.bot),
              selfId: s.selfId,
              kind,
              flag: r.flag,
              guildId: String(r.group_id),
              userId: String(r[user]),
              comment: String(r.message ?? ''),
            },
            config.requestTtlHours * 3600_000,
          )
          if (row.state === 'pending')
            for (const target of config.reviewGroups) await host.store.notice(row, target)
          imported++
        }
      }
      await host.flush()
      return `已录入或去重 ${imported} 条；跳过 ${skipped} 条缺少标识或已处理申请。未把 request_id 当作 flag。`
    }),
  )
  const automation = installAutomation(host, state)
  cmd('帮助', '查看完整群管指令', '群管帮助').action(() =>
    plain(
      `日常：禁言 @成员 10m / 解禁 @成员 / 踢人 @成员 [--拉黑] / 全员禁言 开或关 / 名片 @成员 名称 / 引用后撤回\n` +
        `跨群：管理员私聊发送“禁言 群号 @成员 10m”（解禁、踢人、全员禁言同理），支持一次多名成员\n` +
        `角色：设置管理 / 取消管理 / 设置头衔 / 清除头衔 / ${config.command} 开放头衔 开或关 / 申请头衔\n` +
        `群资料：修改群名 / 设置群头像 / 群公告 / 公告列表 / 删除公告 / 引用后加精或移精 / 精华列表\n` +
        `成员：群成员 QQ / 禁言列表 / 解除全部禁言 / 活跃排行 / 潜水排行 / 最近入群 / 清理潜水 天数 [--执行] / 我要自闭 10m\n` +
        `定时：定时禁言 10m [@成员 30m] / 定时解禁 10m [@成员] / 定时任务 / 取消定时 编号\n` +
        `周期：定时禁言 每日22:00、定时解禁 每周一09:30（可加时区后缀 +08:00）；到点自动执行并按周期重新排队，重启后仍只执行一次\n` +
        `规则：${config.command} 豁免 添加|删除|列表 [QQ] / 申请黑名单 添加|删除|列表 [QQ] / 违禁词 添加|删除|列表|预览 [词语] [--精确] [--禁言 10m]\n` +
        `入群：${config.command} 自动审核 开|关 [--答案 文本] [--等级 数字] / 入群验证 开|关 [--超时 10m] [--踢出] / 验证通过 @成员\n` +
        `投票：投票设置 开|关 [--票数 3] [--反对 3] [--禁言] [--踢人] / 投票禁言 @成员 10m / 投票踢人 @成员 / 赞成 编号 / 反对 编号 / 投票列表 / 取消投票 编号\n` +
        `审核：请求带编号；审核群引用通知审批，管理员私聊或监听目标可直接“${config.command} 同意 编号”\n` +
        `监听：事件监听 开 --管理员 / 开 --群 群号 --私聊 QQ / 关 / 状态；事件通知 开|关 [事件类型] [--全局]\n` +
        `名单：黑名单 添加|删除|列表 [QQ] [--全局] [--群] / 白名单 添加|删除|列表 [QQ] [--全局] [--群]\n` +
        `消息：发通知 群号,群号 正文 / ${config.command} 消息路由 开|关 [--目标 群号] [--转发] [--撤回] [--保留 30]\n` +
        `维护：群列表 / 机器人退群 当前群号 / 群荣誉 / 群打卡列表 / ${config.command} 请求列表|历史申请|补录申请|审计|诊断`,
    ),
  )
  return {
    ...automation,
    blocked: async (bot: string, guild: string, user: string) =>
      (await state.get(bot, guild, 'blocked', user))?.state === 'enabled',
    punishable: (s: Session, id: string, guild?: string) => punishable(host, state, s, id, guild),
  }
}

import { userId as targetId } from './onebot'
