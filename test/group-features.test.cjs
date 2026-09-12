const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { App } = require('koishi')
const sqlite = require('@koishijs/plugin-database-sqlite').default
const group = require('../packages/group-manager/lib')
const { Store } = require('../packages/group-manager/lib/store')
const { State } = require('../packages/group-manager/lib/state')
const { scheduleTime } = require('../packages/group-manager/lib/automation')
const { protocol } = require('./onebot-fixture.cjs')
const { networkFixture, waitFor } = require('./fixture.cjs')
let app, wire, folder, state, fork, network
const config = {
  reviewers: ['1001', '1003'],
  managedGroups: ['600'],
  reviewGroups: ['500'],
  privateReview: true,
  noticeInterval: 100,
  apiTimeout: 1000,
  autoInvite: true,
  inviteAllow: ['700'],
}
const command = (text, user = 1001, guild = 600) => wire.command(text, user, guild)
const count = (action) => wire.actions.filter((a) => a.action === action).length
const last = (action) => wire.actions.findLast((a) => a.action === action)?.params
const row = (kind, ref = '') => state.get('onebot:900001', '600', kind, ref)
const quiet = async () => new Promise((resolve) => setTimeout(resolve, 80))
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-group-features-'))
  network = await networkFixture(() => Buffer.from('89504e470d0a1a0a0000000049454e44', 'hex'))
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
  await network?.close()
  await fs.rm(folder, { recursive: true, force: true })
})

test('short aliases execute directly, while ordinary users and exemptions remain protected', async () => {
  let n = count('set_group_kick')
  assert.match((await command('踢人 2001')).text, /平台已确认/)
  assert.equal(count('set_group_kick'), n + 1)
  assert.equal(last('set_group_kick').reject_add_request, false)
  await command('豁免 添加 2001')
  n = count('set_group_ban')
  assert.match((await command('禁言 2001 10m')).text, /豁免/)
  assert.match((await command('禁言 2002 10m', 2003)).text, /管理员或群主/)
  assert.equal(count('set_group_ban'), n)
  await command('豁免 删除 2001')
  assert.match((await command('禁言 2001 10m')).text, /平台已确认/)
  assert.equal(last('set_group_ban').duration, 600)
})
test('owner-bot role management works for an authorized administrator and rejects other callers', async (t) => {
  assert.match((await command('设置管理 2001')).text, /机器人为群主/)
  wire.roles.set('900001', 'owner')
  t.after(() => wire.roles.set('900001', 'admin'))
  assert.match((await command('设置管理 2001')).text, /回读确认/)
  assert.equal(last('set_group_admin').enable, true)
  assert.match((await command('取消管理 2001')).text, /回读确认/)
  assert.equal(last('set_group_admin').enable, false)
  wire.roles.set('1004', 'admin')
  assert.match((await command('设置管理 2001', 1004)).text, /配置的审核人/)
  assert.match((await command('设置头衔 2001 星星')).text, /平台已确认/)
  assert.equal(last('set_group_special_title').special_title, '星星')
  await command('清除头衔 2001')
  assert.equal(last('set_group_special_title').special_title, '')
  await command('群管理 开放头衔 开')
  await command('违禁词 添加 坏词')
  const titlesBefore = count('set_group_special_title')
  const blockedTitle = wire.event('申请头衔 坏词', 2001, 600)
  wire.emit(blockedTitle)
  await waitFor(() => last('delete_msg')?.message_id === blockedTitle.message_id)
  assert.equal(count('set_group_special_title'), titlesBefore)
  assert.match((await command('申请头衔 新人', 2001)).text, /平台已确认/)
  assert.equal(last('set_group_special_title').user_id, 2001)
  await command('违禁词 删除 坏词')
})
test('group names are read back and avatars are restricted to image bytes from allowed hosts', async () => {
  assert.match((await command('修改群名 新的群名')).text, /回读确认/)
  const response = await command([
    { type: 'text', data: { text: '设置群头像 ' } },
    { type: 'image', data: { file: 'a.jpg', url: 'https://gchat.qpic.cn/avatar.png' } },
  ])
  assert.match(response.text, /平台已确认/)
  assert.ok(last('set_group_portrait').file.startsWith('base64://'))
  const n = count('set_group_portrait')
  assert.match(
    (
      await command([
        { type: 'text', data: { text: '设置群头像 ' } },
        { type: 'image', data: { file: 'a.jpg', url: 'http://127.0.0.1/private' } },
      ])
    ).text,
    /域名|禁止/,
  )
  assert.equal(count('set_group_portrait'), n)
})
test('announcements support create/list/delete and do not accept another group notice id', async () => {
  assert.match((await command('群公告 周末活动')).text, /平台已确认/)
  const list = await command('公告列表')
  assert.match(list.text, /周末活动/)
  const id = /(\d+)：周末活动/.exec(list.text)[1]
  assert.match((await command('删除公告 wrong')).text, /没有此公告/)
  assert.match((await command(`删除公告 ${id}`)).text, /平台已确认/)
  assert.match((await command('公告列表')).text, /没有记录/)
})
const quote = (id, text) => [
  { type: 'reply', data: { id } },
  { type: 'text', data: { text } },
]
test('essence commands validate the quoted message group for both additions and removals', async () => {
  wire.messages.set('9101', { ...wire.event('message', 2001, 600), message_id: 9101 })
  wire.messages.set('9102', { ...wire.event('message', 2001, 700), message_id: 9102 })
  const n = count('set_essence_msg')
  assert.match((await command(quote('9102', '加精'))).text, /无法确认/)
  assert.equal(count('set_essence_msg'), n)
  await command(quote('9101', '加精'))
  assert.equal(last('set_essence_msg').message_id, 9101)
  assert.match((await command('精华列表')).text, /9101/)
  await command(quote('9101', '移精'))
  assert.equal(last('delete_essence_msg').message_id, 9101)
})
test('mute listing rejects missing timestamps and batch unmute reports individual failures', async () => {
  wire.responses.set('get_group_member_list', [{ user_id: 2001, role: 'member' }])
  assert.match((await command('禁言列表')).text, /未提供/)
  wire.responses.delete('get_group_member_list')
  wire.members.set('2001', { shut_up_timestamp: Math.floor(Date.now() / 1000) + 600 })
  wire.members.set('1003', { shut_up_timestamp: Math.floor(Date.now() / 1000) + 600 })
  assert.match((await command('禁言列表')).text, /2001/)
  const result = await command('解除全部禁言')
  assert.match(result.text, /2001：平台已确认/)
  assert.match(result.text, /1003：无法对该群主/)
  assert.equal(last('set_group_ban').duration, 0)
  wire.members.delete('1003')
})
test('inactivity cleanup excludes unknown timestamps, recent joins and exemptions', async () => {
  const now = Math.floor(Date.now() / 1000),
    old = now - 100 * 86400
  wire.responses.set('get_group_member_list', [
    { user_id: 2201, role: 'member', last_sent_time: old, join_time: old },
    { user_id: 2202, role: 'member', last_sent_time: 0, join_time: old },
    { user_id: 2203, role: 'member', last_sent_time: old, join_time: now },
    { user_id: 2204, role: 'member', last_sent_time: old, join_time: old },
  ])
  wire.members.set('2201', { last_sent_time: old, join_time: old })
  await command('豁免 添加 2204')
  const n = count('set_group_kick')
  const preview = await command('清理潜水 30')
  assert.match(preview.text, /符合条件 1 人/)
  assert.equal(count('set_group_kick'), n)
  assert.match((await command('潜水排行')).text, /1 名成员缺少时间/)
  assert.match((await command('最近入群')).text, /2203/)
  await command('清理潜水 30 --执行')
  assert.equal(count('set_group_kick'), n + 1)
  assert.equal(last('set_group_kick').user_id, 2201)
  wire.responses.delete('get_group_member_list')
})
test('self mute only affects the invoking ordinary member and is rate limited', async () => {
  assert.match((await command('我要自闭 2m', 2301)).text, /平台已确认/)
  assert.equal(last('set_group_ban').user_id, 2301)
  assert.equal(last('set_group_ban').duration, 120)
  assert.match((await command('我要自闭 2m', 2301)).text, /每分钟/)
  assert.match((await command('我要自闭 2m')).text, /普通成员/)
})
test('scheduled tasks survive plugin restart, run once, and can be cancelled before execution', async () => {
  assert.throws(() => scheduleTime('2027-01-01T22:00'), /时区/)
  assert.equal(scheduleTime('2m', 1000), 121000)
  const reply = await command('定时禁言 1h 2401 10m')
  const code = /任务 ([A-F0-9]{12})/.exec(reply.text)[1]
  assert.match((await command('定时任务')).text, new RegExp(code))
  await fork.dispose()
  fork = app.plugin(group, config)
  await waitFor(() => app.$commander.resolve('群管理.定时任务'))
  state = new State(new Store(app.database))
  assert.equal((await row('schedule', code)).state, 'pending')
  await state.edit((await row('schedule', code)).id, (r) => {
    r.due = Date.now() - 1
  })
  await waitFor(async () => (await row('schedule', code)).state === 'acknowledged')
  assert.equal(last('set_group_ban').user_id, 2401)
  assert.equal(last('set_group_ban').duration, 600)
  const n = count('set_group_ban')
  await quiet()
  assert.equal(count('set_group_ban'), n)
  const other = /任务 ([A-F0-9]{12})/.exec((await command('定时解禁 1h 2401')).text)[1]
  assert.match((await command(`取消定时 ${other}`)).text, /已取消/)
  await state.edit((await row('schedule', other)).id, (r) => {
    r.due = 0
  })
  assert.equal((await row('schedule', other)).state, 'cancelled')
})
test('scheduled actions recheck current roles and store unknown outcomes without retrying', async () => {
  const code = /任务 ([A-F0-9]{12})/.exec((await command('定时禁言 1h 2402 1m')).text)[1]
  wire.roles.set('2402', 'owner')
  await state.edit((await row('schedule', code)).id, (r) => {
    r.due = 0
  })
  const n = count('set_group_ban')
  await waitFor(async () => (await row('schedule', code)).state === 'cancelled')
  assert.equal(count('set_group_ban'), n)
  wire.roles.delete('2402')
  const unknown = /任务 ([A-F0-9]{12})/.exec((await command('定时禁言 1h 2402 1m')).text)[1]
  wire.failures.set('set_group_ban', 'timeout')
  await state.edit((await row('schedule', unknown)).id, (r) => {
    r.due = 0
  })
  await waitFor(async () => (await row('schedule', unknown)).state === 'uncertain')
  wire.failures.delete('set_group_ban')
  assert.equal(count('set_group_ban'), n + 1)
})
test('violation rules coalesce duplicate events, respect roles/exemptions and support exact matching', async () => {
  await command('违禁词 添加 exact-bad --精确 --禁言 2m')
  assert.match((await command('违禁词 预览 exact-bad')).text, /exact-bad/)
  const n = count('set_group_ban')
  wire.emit(wire.event('not-exact-bad', 2501, 600))
  await quiet()
  assert.equal(count('set_group_ban'), n)
  const event = wire.event('exact-bad', 2501, 600)
  wire.emit(event)
  wire.emit(event)
  await waitFor(() => count('set_group_ban') === n + 1)
  assert.equal(last('delete_msg').message_id, event.message_id)
  assert.equal(last('set_group_ban').duration, 120)
  await command('豁免 添加 2502')
  wire.emit(wire.event('exact-bad', 2502, 600))
  wire.emit(wire.event('exact-bad', 1001, 600))
  await quiet()
  assert.equal(count('set_group_ban'), n + 1)
  await command('违禁词 删除 exact-bad')
})
test('activity count deduplicates a protocol event and reports local history honestly', async () => {
  const event = wire.event('hello activity', 2503, 600)
  wire.emit(event)
  wire.emit(event)
  await waitFor(async () => (await row('activity', '2503'))?.payload.count === 1)
  assert.match((await command('活跃排行')).text, /不是 QQ 网页历史统计/)
})
test('voting enforces one vote per member and only executes once after threshold', async () => {
  await command('投票设置 开 --票数 3')
  const reply = await command('投票禁言 2601 2m', 2602)
  const code = /投票 ([A-F0-9]{12})/.exec(reply.text)[1]
  assert.match((await command(`赞成 ${code}`, 2602)).text, /已经投过票/)
  assert.match((await command(`赞成 ${code}`, 2603)).text, /2\/3/)
  const n = count('set_group_ban')
  await command(`赞成 ${code}`, 2604)
  await waitFor(async () => (await row('vote', code)).state === 'acknowledged')
  assert.equal(count('set_group_ban'), n + 1)
  assert.equal(last('set_group_ban').user_id, 2601)
  assert.match((await command(`赞成 ${code}`, 2605)).text, /结束/)
})
test('expired, disabled, cancelled and departed-target votes cannot punish', async () => {
  const code = /投票 ([A-F0-9]{12})/.exec((await command('投票踢人 2611', 2612)).text)[1]
  await state.edit((await row('vote', code)).id, (r) => {
    r.due = 0
  })
  assert.match((await command(`赞成 ${code}`, 2613)).text, /过期/)
  const other = /投票 ([A-F0-9]{12})/.exec((await command('投票踢人 2621', 2622)).text)[1]
  wire.emit({
    post_type: 'notice',
    notice_type: 'group_decrease',
    sub_type: 'leave',
    group_id: 600,
    user_id: 2621,
    operator_id: 2621,
  })
  await waitFor(async () => (await row('vote', other)).state === 'cancelled')
  const third = /投票 ([A-F0-9]{12})/.exec((await command('投票踢人 2631', 2632)).text)[1]
  await command(`取消投票 ${third}`)
  assert.equal((await row('vote', third)).state, 'cancelled')
  await command('投票设置 关')
  assert.match((await command('投票踢人 2641', 2642)).text, /尚未开启/)
})
const join = (user) =>
  wire.emit({
    post_type: 'notice',
    notice_type: 'group_increase',
    sub_type: 'approve',
    group_id: 600,
    user_id: user,
    operator_id: 1001,
  })
test('entry verification is opt-in, accepts only the user-bound code and deduplicates joins', async () => {
  join(2700)
  await quiet()
  assert.equal(await row('verify', '2700'), undefined)
  await command('入群验证 开 --踢出')
  join(2701)
  join(2701)
  const notice = await waitFor(() => wire.sent.find((s) => /欢迎 2701/.test(s.text)))
  const code = /验证 (\d{6})/.exec(notice.text)[1]
  assert.match((await command(`验证 ${code}`, 2702)).text, /没有待验证/)
  assert.match((await command('验证 000000', 2701)).text, /错误/)
  assert.match((await command(`验证 ${code}`, 2701)).text, /验证通过/)
  assert.equal((await row('verify', '2701')).state, 'verified')
  assert.equal(wire.sent.filter((s) => /欢迎 2701/.test(s.text)).length, 1)
})
test('entry timeout kicks only a pending ordinary member; exemptions and operator override work', async () => {
  join(2711)
  await waitFor(async () => (await row('verify', '2711'))?.state === 'verifying')
  await state.edit((await row('verify', '2711')).id, (r) => {
    r.due = 0
  })
  await waitFor(async () => (await row('verify', '2711')).state === 'acknowledged')
  assert.equal(last('set_group_kick').user_id, 2711)
  await command('豁免 添加 2712')
  join(2712)
  await quiet()
  assert.equal(await row('verify', '2712'), undefined)
  join(2713)
  await waitFor(async () => (await row('verify', '2713'))?.state === 'verifying')
  await command('验证通过 2713')
  assert.equal((await row('verify', '2713')).state, 'verified')
  join(2714)
  await waitFor(async () => (await row('verify', '2714'))?.state === 'verifying')
  await command('入群验证 关')
  const n = count('set_group_kick')
  await state.edit((await row('verify', '2714')).id, (r) => {
    r.due = 0
  })
  await waitFor(async () => (await row('verify', '2714')).state === 'cancelled')
  assert.equal(count('set_group_kick'), n)
})
async function request(flag, user, comment = '通过', extra = {}) {
  wire.emit({
    post_type: 'request',
    request_type: 'group',
    sub_type: 'add',
    group_id: 600,
    user_id: user,
    flag,
    comment,
    ...extra,
  })
  return waitFor(async () => (await app.database.get('ember_group_request', { flag }))[0])
}
test('automatic request policies keep opaque flags and leave missing levels to manual review', async () => {
  await command('自动审核 开 --答案 通过 --等级 10')
  await request('level-missing', 2801)
  await quiet()
  assert.equal((await app.database.get('ember_group_request', { flag: 'level-missing' }))[0].state, 'pending')
  await request('level-pass|opaque', 2802, '通过', { level: 11 })
  await waitFor(
    async () =>
      (await app.database.get('ember_group_request', { flag: 'level-pass|opaque' }))[0]?.state === 'approved',
  )
  assert.equal(last('set_group_add_request').flag, 'level-pass|opaque')
  await command('申请黑名单 添加 2803')
  await request('blocked-user', 2803)
  await waitFor(
    async () =>
      (await app.database.get('ember_group_request', { flag: 'blocked-user' }))[0]?.state === 'rejected',
  )
  assert.equal(last('set_group_add_request').approve, false)
  await command('自动审核 关')
})
test('explicitly enabled invite allowlist only auto-accepts allowed groups', async () => {
  await request('invite-allowed', 2804, '', { sub_type: 'invite', group_id: 700 })
  await waitFor(
    async () =>
      (await app.database.get('ember_group_request', { flag: 'invite-allowed' }))[0]?.state === 'approved',
  )
  assert.equal(last('set_group_add_request').sub_type, 'invite')
  await request('invite-other', 2804, '', { sub_type: 'invite', group_id: 701 })
  await quiet()
  assert.equal((await app.database.get('ember_group_request', { flag: 'invite-other' }))[0].state, 'pending')
})
test('message routes are opt-in, store bounded text and never restore another group cache', async () => {
  const plainEvent = wire.event('uncached', 2901, 600)
  wire.emit(plainEvent)
  await quiet()
  assert.equal(await row('message', String(plainEvent.message_id)), undefined)
  await command('群管理 消息路由 开 --目标 500 --转发 --撤回 --保留 1')
  const event = wire.event('retained text', 2902, 600)
  wire.emit(event)
  await waitFor(
    async () => (await row('message', String(event.message_id)))?.payload.content === 'retained text',
  )
  await waitFor(() => wire.sent.some((s) => s.params.group_id === 500 && /\[群消息 600\] 2902/.test(s.text)))
  wire.emit({
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: 600,
    user_id: 2902,
    operator_id: 2902,
    message_id: event.message_id,
  })
  await waitFor(() =>
    wire.sent.some((s) => /\[撤回恢复 600\]/.test(s.text) && s.text.includes('retained text')),
  )
  await command('群管理 消息路由 关')
  assert.equal(await row('message', String(event.message_id)), undefined)
})
test('group list, leave, broadcasts, honor, sign-ins and historical request import use correct methods', async () => {
  assert.match((await command('群列表')).text, /600/)
  assert.match((await command('群荣誉')).text, /Dragon/)
  assert.match((await command('群打卡列表')).text, /sign_in_count/)
  assert.match((await command('机器人退群 700')).text, /当前群号/)
  await command('机器人退群 600')
  assert.equal(last('set_group_leave').is_dismiss, false)
  assert.match((await command('发通知 700 hello')).text, /管理群/)
  await command('发通知 600 test-broadcast')
  assert.ok(wire.sent.some((s) => s.text === 'test-broadcast'))
  wire.responses.set('get_group_system_msg', {
    join_requests: [
      { group_id: 600, requester_uin: 2991, request_id: 123 },
      { group_id: 600, requester_uin: 2992, flag: 'history|opaque', message: '历史申请', checked: false },
    ],
  })
  assert.match((await wire.command('群管理 历史申请', 1001, 500)).text, /仅供查看/)
  assert.match((await wire.command('群管理 补录申请', 1001, 500)).text, /跳过 1/)
  assert.equal((await app.database.get('ember_group_request', { flag: '123' })).length, 0)
  assert.equal((await app.database.get('ember_group_request', { flag: 'history|opaque' })).length, 1)
  await wire.command('群管理 补录申请', 1001, 500)
  assert.equal((await app.database.get('ember_group_request', { flag: 'history|opaque' })).length, 1)
})
