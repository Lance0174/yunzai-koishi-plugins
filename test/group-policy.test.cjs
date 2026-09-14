const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { App } = require('koishi')
const sqlite = require('@koishijs/plugin-database-sqlite').default
const group = require('../packages/group-manager/lib')
const { State } = require('../packages/group-manager/lib/state')
const { Store } = require('../packages/group-manager/lib/store')
const { protocol } = require('./onebot-fixture.cjs')
const { waitFor } = require('./fixture.cjs')
let app, wire, folder, fork, state
const passed = []
const config = { reviewers: ['1001'], reviewGroups: [], noticeInterval: 100, apiTimeout: 1000 }
const cmd = (text, user = 1001, guild = 777, predicate) => wire.command(text, user, guild, predicate)
const join = (user, guild = 777) =>
  wire.emit({
    post_type: 'notice',
    notice_type: 'group_increase',
    sub_type: 'approve',
    group_id: guild,
    user_id: user,
    operator_id: 1001,
  })
const quiet = () => new Promise((resolve) => setTimeout(resolve, 150))
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'yunzai-policies-'))
  app = new App({ prefix: [''], delay: { character: 0, message: 0, broadcast: 0 } })
  app.baseDir = folder
  app.plugin(sqlite, { path: path.join(folder, 'db.sqlite') })
  fork = app.plugin(group, config)
  app.middleware((s, next) => {
    passed.push(s.content)
    return next()
  })
  wire = await protocol(app)
  state = new State(new Store(app.database))
})
after(async () => {
  await wire?.close()
  await fs.rm(folder, { recursive: true, force: true })
})
test('management works with no group allowlist, and default notices go to administrator private chat', async () => {
  assert.deepEqual(group.Config({}).managedGroups, [])
  assert.equal(group.Config({}).listener, true)
  assert.equal(group.Config({}).notices, true)
  assert.match((await cmd('禁言 2001 1m')).text, /平台已确认/)
  join(2002)
  const notification = await waitFor(() =>
    wire.sent.find(
      (r) => r.action === 'send_private_forward_msg' && r.text.includes('成员加入') && r.text.includes('用户：2002'),
    ),
  )
  assert.equal(notification.params.user_id, 1001)
  assert.equal(
    wire.sent.some((r) => r.action === 'send_group_msg' && r.text.includes('成员加入')),
    false,
  )
})
test('blacklisted messages are ignored by commands, automation and downstream middleware without kicking', async () => {
  await cmd('黑名单 添加 2010')
  const actions = wire.actions.length
  wire.emit(wire.event('群管理 帮助', 2010, 777))
  wire.emit(wire.event('blocked-message-marker', 2010, 777))
  await quiet()
  assert.equal(passed.includes('blocked-message-marker'), false)
  assert.equal(
    wire.actions
      .slice(actions)
      .some((a) => ['set_group_kick', 'set_group_ban', 'send_group_msg'].includes(a.action)),
    false,
  )
  await cmd('黑名单 删除 2010')
  wire.emit(wire.event('unblocked-message-marker', 2010, 777))
  await waitFor(() => passed.includes('unblocked-message-marker'))
})
test('whitelisted members are exempt from penalties and verification without gaining operator authority', async () => {
  await cmd('白名单 添加 2020 --全局', 1001, null)
  const actions = wire.actions.length
  assert.match((await cmd('禁言 2020 1m')).text, /豁免/)
  assert.match((await cmd('踢人 2020')).text, /豁免/)
  assert.match((await cmd('禁言 2021 1m', 2020)).text, /管理员或群主/)
  join(2020)
  await quiet()
  assert.equal(await state.get('onebot:900001', '777', 'verify', '2020'), undefined)
  assert.equal(
    wire.actions.slice(actions).some((a) => ['set_group_kick', 'set_group_ban'].includes(a.action)),
    false,
  )
})
test('listener recipients are independent of review groups and per-group notice switches preserve moderation', async () => {
  await cmd('事件监听 开 --群 888 --私聊 1002', 1001, null)
  join(2030)
  await waitFor(() => wire.sent.some((r) => r.text.includes('用户：2030') && r.params.user_id === 1002))
  assert.ok(wire.sent.some((r) => r.text.includes('用户：2030') && r.params.group_id === 888))
  await cmd('事件通知 关 成员变动')
  join(2031)
  await quiet()
  assert.equal(
    wire.sent.some((r) => r.text.includes('成员加入') && r.text.includes('用户：2031')),
    false,
  )
  assert.match((await cmd('禁言 2032 1m')).text, /平台已确认/)
  assert.match((await cmd('事件通知 开 成员变动', 2032)).text, /管理员或群主/)
})

test('group lists persist globally, protect a whitelisted group and give blacklist precedence', async () => {
  await cmd('白名单 添加 779 --群', 1001, null)
  assert.match((await cmd('全员禁言 开', 1001, 779)).text, /豁免/)
  assert.match((await cmd('禁言 2090 1m', 1001, 779)).text, /豁免/)
  await cmd('黑名单 添加 779 --群', 1001, null)
  const from = wire.actions.length
  wire.emit(wire.event('blacklisted-group-marker', 1001, 779))
  await quiet()
  assert.equal(passed.includes('blacklisted-group-marker'), false)
  assert.equal(
    wire.actions.slice(from).some((a) => a.action.startsWith('send_')),
    false,
  )
  await cmd('黑名单 删除 779 --群', 1001, null)
  wire.emit(wire.event('restored-group-marker', 1001, 779))
  await waitFor(() => passed.includes('restored-group-marker'))
})
test('verification timeouts use the independent listener destinations even without review groups', async () => {
  join(2060)
  const row = await waitFor(async () => {
    const value = await state.get('onebot:900001', '777', 'verify', '2060')
    return value?.state === 'verifying' ? value : undefined
  })
  await state.edit(row.id, (value) => {
    value.due = 0
  })
  const notice = await waitFor(() =>
    wire.sent.find(
      (r) => r.action === 'send_private_forward_msg' && r.text.includes('入群验证超时') && r.text.includes('2060'),
    ),
  )
  assert.equal(notice.params.user_id, 1002)
  assert.equal(
    wire.actions.some((a) => a.action === 'set_group_kick' && a.params.user_id === 2060),
    false,
  )
})

test('notification settings and blacklists survive plugin reload; listener still runs with moderation and reviews disabled', async () => {
  await cmd('黑名单 添加 2040 --全局', 1001, null)
  await fork.dispose()
  fork = app.plugin(group, { ...config, moderation: false, reviews: false })
  await waitFor(() => app.$commander.resolve('群管理.事件监听'))
  assert.match((await cmd('事件通知 状态', 1001, null)).text, /成员变动：开/)
  assert.match((await cmd('事件通知 状态')).text, /成员变动：关/)
  assert.match((await cmd('黑名单 列表 --全局', 1001, null)).text, /2040/)
  assert.match((await cmd('事件监听 状态', 1001, null)).text, /g:888.*p:1002/)
  join(2050, 778)
  await waitFor(() => wire.sent.some((r) => r.text.includes('用户：2050') && r.params.user_id === 1002))
  await cmd('事件监听 关', 1001, null)
  join(2051, 778)
  await quiet()
  assert.equal(
    wire.sent.some((r) => r.text.includes('用户：2051')),
    false,
  )
})
