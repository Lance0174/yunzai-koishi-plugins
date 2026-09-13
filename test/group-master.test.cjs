const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { App } = require('koishi')
const sqlite = require('@koishijs/plugin-database-sqlite').default
const group = require('../packages/group-manager/lib')
const { State } = require('../packages/group-manager/lib/state')
const { Store } = require('../packages/group-manager/lib/store')
const { nextRecurring, parseRecur } = require('../packages/group-manager/lib/schedule')
const { protocol } = require('./onebot-fixture.cjs')
const { waitFor } = require('./fixture.cjs')
let app, wire, folder, state, fork
const config = {
  reviewers: ['1001', '1003'],
  reviewGroups: ['500'],
  privateReview: true,
  noticeInterval: 100,
  apiTimeout: 1000,
}
const command = (text, user = 1001, guild = 600, predicate) => wire.command(text, user, guild, predicate)
const last = (action) => wire.actions.findLast((a) => a.action === action)?.params
const count = (action) => wire.actions.filter((a) => a.action === action).length
const quiet = async () => new Promise((resolve) => setTimeout(resolve, 150))
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'yunzai-master-'))
  app = new App({ prefix: [''], delay: { character: 0, message: 0, broadcast: 0 } })
  app.baseDir = folder
  app.plugin(sqlite, { path: path.join(folder, 'db.sqlite') })
  fork = app.plugin(group, config)
  wire = await protocol(app)
  await waitFor(() => app.$commander.resolve('群管理.定时禁言'))
  state = new State(new Store(app.database))
})
after(async () => {
  await wire?.close()
  await fs.rm(folder, { recursive: true, force: true })
})
const emitInvite = async (flag, guild = 700) => {
  wire.emit({
    post_type: 'request',
    request_type: 'group',
    sub_type: 'invite',
    group_id: guild,
    user_id: 2001,
    flag,
    comment: '测试邀请',
  })
  return waitFor(async () => (await app.database.get('ember_group_request', { flag }))[0])
}
const vote = async (text, user = 1001, guild = 600) =>
  /投票 ([A-F0-9]{12})/.exec((await command(text, user, guild)).text)[1]

test('recurring rules resolve the next occurrence with an explicit timezone', () => {
  const from = Date.UTC(2026, 8, 13, 12, 0) // 2026-09-13 是周日；墙钟 20:00（UTC+8）
  assert.equal(nextRecurring(parseRecur('每日22:00+08:00'), from), Date.UTC(2026, 8, 13, 14, 0))
  assert.equal(nextRecurring(parseRecur('每周一09:30+08:00'), from), Date.UTC(2026, 8, 14, 1, 30))
  const rule = parseRecur('每周一09:30+08:00')
  assert.equal(rule.tz, 480)
  assert.equal(rule.day, 1)
  assert.throws(() => parseRecur('每周八09:30'), /周期格式/)
  assert.throws(() => parseRecur('每日25:00'), /24 小时制/)
})

test('masters run group admin from private chat with an explicit group number', async () => {
  assert.match((await command('群管理 禁言 600 2001 2m', 1001, null)).text, /平台已确认/)
  assert.equal(last('set_group_ban').group_id, 600)
  assert.equal(last('set_group_ban').duration, 120)
  assert.match((await command('群管理 全员禁言 600 开', 1001, null)).text, /平台已确认/)
  assert.equal(last('set_group_whole_ban').enable, true)
  await command('群管理 全员禁言 600 关', 1001, null)
  assert.match(
    (
      await command(
        [
          { type: 'text', data: { text: '群管理 禁言 ' } },
          { type: 'at', data: { qq: '2001' } },
          { type: 'text', data: { text: ' 2m' } },
        ],
        1001,
        null,
      )
    ).text,
    /以群号开头/,
  )
  assert.match((await command('群管理 禁言 600 2001 2m', 1002, null)).text, /仅允许机器人管理员/)
})

test('mute and kick accept multiple targets with one shared duration', async () => {
  const bans = count('set_group_ban')
  assert.match((await command('群管理 禁言 2001 2002 2m')).text, /平台已确认/)
  assert.equal(count('set_group_ban'), bans + 2)
  assert.equal(last('set_group_ban').duration, 120)
  const kicks = count('set_group_kick')
  assert.match((await command('群管理 踢人 2001 2002')).text, /平台已确认/)
  assert.equal(count('set_group_kick'), kicks + 2)
  assert.match((await command('群管理 禁言 2001 1003 2m')).text, /1003：无法对该群主/)
  assert.match((await command('群管理 禁言 2001 2m', 2003)).text, /2001：操作人须为/)
})

test('review notices carry the request code to private administrators', async () => {
  const numbered = await emitInvite('numbered-001')
  const privateNotice = await waitFor(() =>
    wire.sent.find((n) => n.action === 'send_private_msg' && n.text.includes(numbered.code)),
  )
  assert.equal(privateNotice.params.user_id, 1001)
  assert.match((await command(`群管理 同意 ${numbered.code}`, 1001, null)).text, /平台已确认同意/)
  await waitFor(
    async () =>
      (await app.database.get('ember_group_request', { id: numbered.id }))[0].state === 'approved',
  )
  assert.equal(
    wire.actions.filter((a) => a.action === 'set_group_add_request' && a.params.flag === 'numbered-001')
      .length,
    1,
  )
})

test('quoting the notification approves from a channel outside the review groups', async () => {
  const quoted = await emitInvite('numbered-002')
  const notice = await waitFor(
    () => wire.sent.find((n) => n.action === 'send_private_msg' && n.text.includes(quoted.code)),
  )
  const response = await command(
    [
      { type: 'reply', data: { id: notice.id } },
      { type: 'text', data: { text: '群管理 同意' } },
    ],
    1001,
    600,
  )
  assert.match(response.text, /平台已确认同意/)
})

test('custom listener groups can approve by request code', async () => {
  await command('群管理 事件监听 开 --群 888', 1001, null)
  const row = await emitInvite('numbered-003')
  await waitFor(() => wire.sent.some((n) => n.params.group_id === 888 && n.text.includes(row.code)))
  assert.match((await command(`群管理 同意 ${row.code}`, 1001, 888)).text, /平台已确认同意/)
  await command('群管理 事件监听 开 --管理员', 1001, null)
  await quiet()
})

test('event notices describe the concrete change instead of a bare summary', async () => {
  wire.emit({
    post_type: 'notice',
    notice_type: 'group_decrease',
    sub_type: 'kick',
    group_id: 600,
    user_id: 3101,
    operator_id: 1001,
  })
  wire.emit({
    post_type: 'notice',
    notice_type: 'group_ban',
    sub_type: 'ban',
    group_id: 600,
    user_id: 3102,
    operator_id: 1001,
    duration: 600,
  })
  wire.emit({
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: 600,
    user_id: 3103,
    operator_id: 1001,
    message_id: 4103,
  })
  await waitFor(() => wire.sent.some((n) => n.action === 'send_private_msg' && n.text.includes('被管理员移出')))
  assert.ok(wire.sent.some((n) => n.text.includes('成员被管理员移出（操作人 1001）') && n.text.includes('用户：3101')))
  assert.ok(wire.sent.some((n) => n.text.includes('被禁言 600 秒') && n.text.includes('用户：3102')))
  assert.ok(wire.sent.some((n) => n.text.includes('群消息撤回') && n.text.includes('发送者 3103')))
})

test('recurring schedules re-queue after executing exactly once', async () => {
  const reply = await command('群管理 定时禁言 每日22:00')
  const code = /任务 ([A-F0-9]{12})/.exec(reply.text)[1]
  const row = await state.get('onebot:900001', '600', 'schedule', code)
  assert.equal(row.state, 'pending')
  assert.equal(row.payload.recur.type, 'daily')
  const weekly = /任务 ([A-F0-9]{12})/.exec(
    (await command('群管理 定时禁言 每周一09:30+08:00 2401 1h')).text,
  )[1]
  assert.equal((await state.get('onebot:900001', '600', 'schedule', weekly)).payload.recur.tz, 480)
  const executed = count('set_group_whole_ban')
  await state.edit(row.id, (r) => {
    r.due = Date.now() - 1
  })
  await waitFor(async () => (await state.get('onebot:900001', '600', 'schedule', code)).payload.lastRun > 0)
  assert.equal(count('set_group_whole_ban'), executed + 1)
  const after = await state.get('onebot:900001', '600', 'schedule', code)
  assert.equal(after.state, 'pending')
  assert.ok(after.due > Date.now())
  await quiet()
  assert.equal(count('set_group_whole_ban'), executed + 1)
})

test('votes support opposition thresholds and separate punishment switches', async () => {
  assert.match((await command('群管理 投票设置 开 --反对 2')).text, /反对即否决/)
  const reject = await vote('群管理 投票踢人 3201', 3202)
  assert.match((await command(`群管理 反对 ${reject}`, 3203)).text, /1\/2/)
  const kicks = count('set_group_kick')
  assert.match((await command(`群管理 反对 ${reject}`, 3204)).text, /已否决/)
  await quiet()
  assert.equal(count('set_group_kick'), kicks)
  assert.equal((await state.get('onebot:900001', '600', 'vote', reject)).state, 'rejected')
})

test('an administrator vote ends the vote immediately and punishes once', async () => {
  const fast = await vote('群管理 投票禁言 3211 2m', 3212)
  assert.match((await command(`群管理 赞成 ${fast}`, 1001)).text, /立即进入执行/)
  await waitFor(async () => (await state.get('onebot:900001', '600', 'vote', fast)).state === 'acknowledged')
  assert.equal(last('set_group_ban').user_id, 3211)
  assert.equal(last('set_group_ban').duration, 120)
})

test('scoped vote switches disable one punishment type only', async () => {
  assert.match((await command('群管理 投票设置 关 --踢人')).text, /投票踢人已关闭/)
  assert.match((await command('群管理 投票踢人 3221', 3222)).text, /单独关闭/)
  const kept = await vote('群管理 投票禁言 3221 2m', 3222)
  assert.match((await command(`群管理 赞成 ${kept}`, 3223)).text, /2\/3/)
  await command(`群管理 取消投票 ${kept}`)
})

test('closing votes remind the group once before the deadline', async () => {
  await command('群管理 投票设置 开 --票数 2 --期限 1m')
  const code = await vote('群管理 投票踢人 3301', 3302)
  await waitFor(() =>
    wire.sent.some(
      (n) => n.params.group_id === 600 && n.text.includes(`投票 ${code}`) && n.text.includes('1 分钟内结束'),
    ),
  )
  assert.equal((await state.get('onebot:900001', '600', 'vote', code)).payload.reminded, true)
})
