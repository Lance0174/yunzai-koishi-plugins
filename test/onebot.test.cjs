const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { App } = require('koishi')
const sqlite = require('@koishijs/plugin-database-sqlite').default
const group = require('../packages/group-manager/lib')
const music = require('../packages/music/lib')
const video = require('../packages/video/lib')
const { protocol } = require('./onebot-fixture.cjs')
const { networkFixture, waitFor } = require('./fixture.cjs')
let app, wire, fixture, folder, bytes
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-onebot-'))
  execFileSync(
    process.env.FFMPEG || 'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      path.join(folder, 'test.mp4'),
    ],
    { windowsHide: true },
  )
  bytes = await fs.readFile(path.join(folder, 'test.mp4'))
  fixture = await networkFixture((call) => {
    if (call.url.pathname.includes('/api/search'))
      return {
        code: 200,
        result: {
          songs: Array.from({ length: 6 }, (_, i) => ({
            id: i + 1,
            name: `歌曲${i + 1}`,
            artists: [{ name: '歌手' }],
            duration: 1000,
          })),
        },
      }
    if (call.url.hostname === 'u.y.qq.com')
      return {
        req: {
          data: {
            body: {
              song: {
                list: [{ id: 789, mid: '00abc', title: 'QQ歌曲', singer: [{ name: '歌手' }], interval: 100 }],
              },
            },
          },
        },
      }
    if (call.url.pathname.includes('/lyric')) return { lrc: { lyric: '[00:01]这是歌词' } }
    if (call.url.hostname === 'www.iesdouyin.com')
      return (
        'window._ROUTER_DATA=' +
        JSON.stringify({
          aweme_id: '12345',
          desc: '本地视频',
          video: { duration: 1000, play_addr: { url_list: ['https://v.douyinvod.com/test.mp4'] } },
        })
      )
    return bytes
  })
  app = new App({ prefix: [''], delay: { character: 0, message: 0, broadcast: 0 } })
  app.baseDir = folder
  app.plugin(sqlite, { path: path.join(folder, 'db.sqlite') })
  app.plugin(group, {
    reviewers: ['1001', '1003'],
    reviewGroups: ['500', '501'],
    managedGroups: ['600'],
    privateReview: true,
    noticeInterval: 100,
    apiTimeout: 1000,
  })
  app.plugin(music, { pageSize: 2, cooldown: 0, timeout: 2000 })
  app.plugin(video, {
    autoParse: false,
    cooldown: 0,
    timeout: 2000,
    ffmpeg: process.env.FFMPEG || 'ffmpeg',
    ffprobe: process.env.FFPROBE || 'ffprobe',
  })
  wire = await protocol(app)
  await waitFor(() => app.$commander.resolve('群管理.请求列表'))
})
after(async () => {
  await wire?.close()
  await fixture?.close()
  await fs.rm(folder, { recursive: true, force: true })
})
async function invite(flag, kind = 'invite', guild = 700) {
  wire.emit({
    post_type: 'request',
    request_type: 'group',
    sub_type: kind,
    group_id: guild,
    user_id: 2001,
    flag,
    comment: '测试邀请',
  })
  return waitFor(async () => (await app.database.get('ember_group_request', { flag }))[0])
}
const mutationCount = () =>
  wire.actions.filter((a) => a.action.startsWith('set_group') || a.action === 'delete_msg').length

test('official adapter routes all three plugins and rejects unknown review users', async () => {
  assert.match((await wire.command('群管理 诊断')).text, /SnowLuma protocol fixture/)
  assert.match((await wire.command('群管理 请求列表', 1002)).text, /没有.*权限/)
  assert.match((await wire.command('点歌')).text, /关键词/)
  assert.match((await wire.command('视频解析')).text, /BV/)
})
test('invite is approved once with the original opaque flag and invite subtype', async () => {
  const row = await invite('opaque|flag:must-preserve')
  const notice = await waitFor(() =>
    wire.sent.find((n) => n.params.group_id === 500 && n.text.includes(row.code)),
  )
  const quote = [
    { type: 'reply', data: { id: notice.id } },
    { type: 'text', data: { text: '群管理 同意' } },
  ]
  const before = wire.actions.length
  const sentBefore = wire.sent.length
  wire.emit(wire.event(quote, 1001))
  wire.emit(wire.event(`群管理 拒绝 ${row.code}`, 1003, 501))
  await waitFor(async () =>
    ['approved', 'rejected'].includes(
      (await app.database.get('ember_group_request', { id: row.id }))[0].state,
    ),
  )
  await waitFor(
    () =>
      wire.sent
        .slice(sentBefore)
        .filter((n) => n.text.startsWith(row.code + '：') || n.text.includes('请求正在处理')).length >= 2,
  )
  const actions = wire.actions.slice(before).filter((a) => a.action === 'set_group_add_request')
  assert.equal(actions.length, 1)
  assert.equal(actions[0].params.flag, row.flag)
  assert.equal(actions[0].params.sub_type, 'invite')
  assert.equal((await app.database.get('ember_group_audit', { target: row.code })).length, 2)
})
test('forged quoted text and reviews in unauthorized groups cannot approve', async () => {
  const row = await invite('forged-quote')
  wire.messages.set('9999', { ...wire.event(`[${row.code}] 原通知`, 1002, 500), message_id: 9999 })
  const before = mutationCount()
  const response = await wire.command([
    { type: 'reply', data: { id: '9999' } },
    { type: 'text', data: { text: '群管理 同意' } },
  ])
  assert.match(response.text, /找不到此请求/)
  assert.match((await wire.command(`群管理 同意 ${row.code}`, 1001, 600)).text, /没有.*权限/)
  assert.equal(mutationCount(), before)
})
test('member applications require a fresh role check and use add subtype', async () => {
  const row = await invite('member-application', 'add', 600)
  wire.roles.set('1001', 'member')
  assert.match((await wire.command(`群管理 同意 ${row.code}`)).text, /管理员或群主/)
  wire.roles.set('1001', 'admin')
  assert.match((await wire.command(`群管理 同意 ${row.code}`)).text, /平台已确认同意/)
  const action = wire.actions.find((a) => a.action === 'set_group_add_request' && a.params.flag === row.flag)
  assert.equal(action.params.sub_type, 'add')
  assert.ok(wire.actions.some((a) => a.action === 'get_group_member_info' && a.params.no_cache === true))
})
test('mute duration reaches OneBot in seconds and cannot target protected roles or unmanaged groups', async () => {
  assert.match((await wire.command('群管理 禁言 2001 2m', 1001, 600)).text, /平台已确认/)
  assert.equal(wire.actions.findLast((a) => a.action === 'set_group_ban').params.duration, 120)
  assert.match(
    (
      await wire.command(
        [
          { type: 'text', data: { text: '群管理 禁言 ' } },
          { type: 'at', data: { qq: '2001' } },
          { type: 'text', data: { text: ' 3m' } },
        ],
        1001,
        600,
      )
    ).text,
    /平台已确认/,
  )
  assert.equal(wire.actions.findLast((a) => a.action === 'set_group_ban').params.duration, 180)
  let before = mutationCount()
  assert.match((await wire.command('群管理 禁言 1003 2m', 1001, 600)).text, /群主或管理员/)
  assert.match((await wire.command('群管理 禁言 2001 2m', 1001, 700)).text, /尚未开放/)
  assert.equal(mutationCount(), before)
  assert.match((await wire.command('群管理 解禁 2001', 1001, 600)).text, /平台已确认/)
  assert.equal(wire.actions.findLast((a) => a.action === 'set_group_ban').params.duration, 0)
})
test('kick executes directly without a confirmation and cards are read back', async () => {
  const before = mutationCount()
  assert.match((await wire.command('群管理 踢人 2001', 1001, 600)).text, /平台已确认/)
  assert.equal(mutationCount(), before + 1)
  assert.equal(wire.actions.filter((a) => a.action === 'set_group_kick').length, 1)
  assert.equal(app.$commander.resolve('群管理.执行'), undefined)
  assert.match((await wire.command('群管理 名片 2001 新名片', 1001, 600)).text, /回读确认/)
})

test('explicit protocol failure and lost responses produce distinct terminal audit states', async () => {
  for (const [flag, failure, expected] of [
    ['fail', 100, 'failed'],
    ['timeout', 'timeout', 'uncertain'],
  ]) {
    const row = await invite(flag)
    wire.failures.set('set_group_add_request', failure)
    await wire.command(`群管理 同意 ${row.code}`, 1001, 500, (n) => n.text.startsWith(row.code + '：'))
    assert.equal((await app.database.get('ember_group_request', { id: row.id }))[0].state, expected)
    wire.failures.delete('set_group_add_request')
  }
})
test('whole-group mute executes directly and quoted recalls cannot cross groups', async () => {
  assert.match((await wire.command('群管理 全员禁言 开', 1001, 600)).text, /平台已确认/)
  assert.equal(wire.actions.findLast((a) => a.action === 'set_group_whole_ban').params.enable, true)
  await wire.command('群管理 全员禁言 关', 1001, 600)
  assert.equal(wire.actions.findLast((a) => a.action === 'set_group_whole_ban').params.enable, false)
  wire.messages.set('80001', { ...wire.event('local message', 2001, 600), message_id: 80001 })
  wire.messages.set('80002', { ...wire.event('another group', 2001, 700), message_id: 80002 })
  const quote = (id) => [
    { type: 'reply', data: { id } },
    { type: 'text', data: { text: '群管理 撤回' } },
  ]
  assert.match((await wire.command(quote('80002'), 1001, 600)).text, /无法确认引用消息属于当前群/)
  assert.match((await wire.command(quote('80001'), 1001, 600)).text, /平台已确认/)
  assert.equal(wire.actions.findLast((a) => a.action === 'delete_msg').params.message_id, 80001)
})
test('event bursts are persisted and delivered to administrator private chat despite destination rate limiting', async () => {
  for (let user = 3000; user < 3003; user++)
    wire.emit({
      post_type: 'notice',
      notice_type: 'group_increase',
      sub_type: 'approve',
      group_id: 600,
      user_id: user,
      operator_id: 1001,
    })
  await waitFor(
    async () =>
      (await app.database.get('ember_group_event', { state: 'sent', topic: '成员变动' })).length >= 3,
    5000,
  )
  for (const user of [3000, 3001, 3002])
    assert.ok(wire.sent.some((n) => n.action === 'send_private_msg' && n.text.includes(`用户：${user}`)))
})
test('song sessions isolate user/group; selection, paging and lyrics use real Koishi commands', async () => {
  assert.match((await wire.command('点歌 搜索 测试')).text, /第 1\/3 页/)
  assert.match((await wire.command('点歌 下一页')).text, /3\. 歌曲3/)
  assert.match((await wire.command('点歌 列表', 1002)).text, /会话已过期或不属于/)
  assert.match((await wire.command('点歌 播放 1', 1001, 501)).text, /会话已过期或不属于/)
  assert.match((await wire.command('点歌 歌词 1')).text, /这是歌词/)
  assert.match((await wire.command('点歌 列表', 1001, null)).text, /会话已过期或不属于/)
})
test('audio and music card are encoded through the official OneBot adapter', async () => {
  const audio = await wire.command('点歌 语音 1', 1001, 500, (n) =>
    n.params.message.some((s) => s.type === 'record'),
  )
  assert.ok(audio.params.message.find((s) => s.type === 'record').data.file.startsWith('base64://'))
  const card = await wire.command('点歌 播放 1 --卡片', 1001, 500, (n) =>
    n.params.message.some((s) => s.type === 'music'),
  )
  assert.equal(card.params.message.find((s) => s.type === 'music').data.type, '163')
  assert.equal(String(card.params.message.find((s) => s.type === 'music').data.id), '1')
})
test('download command is absent and a numeric reply sends the default music card', async () => {
  assert.equal(app.$commander.resolve('点歌.下载'), undefined)
  const before = wire.actions.length
  const card = await wire.command('2', 1001, 500, (n) => n.params.message.some((s) => s.type === 'music'))
  assert.equal(String(card.params.message.find((s) => s.type === 'music').data.id), '2')
  assert.equal(
    wire.actions
      .slice(before)
      .some((a) => ['download_file', 'upload_group_file', 'upload_private_file'].includes(a.action)),
    false,
  )
})

test('QQ native cards use the numeric song id without fetching the audio source', async () => {
  await wire.command('点歌 测试 -p QQ')
  const from = fixture.calls.length
  const sent = await wire.command('点歌 卡片 1', 1001, 500, (n) =>
    n.params.message.some((s) => s.type === 'music'),
  )
  const card = sent.params.message.find((s) => s.type === 'music').data
  assert.equal(card.type, 'qq')
  assert.equal(String(card.id), '789')
  assert.equal(fixture.calls.length, from)
  assert.match((await wire.command('点歌 播放 1 --卡片 --语音')).text, /请选择/)
})

test('plain song requests immediately send the first result, while --列表 keeps manual selection', async () => {
  const from = wire.sent.length
  const first = await wire.command('点歌 测试', 1001, 500, (n) =>
    n.params.message.some((s) => s.type === 'music'),
  )
  assert.equal(String(first.params.message.find((s) => s.type === 'music').data.id), '1')
  assert.equal(
    wire.sent.slice(from).some((n) => /第 \d+\//.test(n.text)),
    false,
  )
  assert.match((await wire.command('点歌 测试 --列表')).text, /第 1\/3 页/)
  const voice = await wire.command('点歌 测试 --语音', 1001, 500, (n) =>
    n.params.message.some((s) => s.type === 'record'),
  )
  assert.ok(voice.params.message.find((s) => s.type === 'record').data.file.startsWith('base64://'))
  assert.equal(
    Object.keys(music.Config({})).some((key) => /cookie/i.test(key)),
    false,
  )
})

test('video command downloads, processes and emits an actual OneBot video segment', async () => {
  const sent = await wire.command('视频解析 https://www.douyin.com/video/12345', 1001, 500, (n) =>
    n.params.message.some((s) => s.type === 'video'),
  )
  const encoded = sent.params.message.find((s) => s.type === 'video').data.file
  assert.ok(encoded.startsWith('base64://'))
  assert.equal(Buffer.from(encoded.slice(9), 'base64').subarray(4, 8).toString(), 'ftyp')
  assert.match((await wire.command('视频解析 任务')).text, /平台已确认发送/)
  assert.match((await wire.command('视频解析 任务', 1002)).text, /没有视频任务/)
})

test('automatic video parsing only consumes supported links in configured groups', async () => {
  const forwarded = []
  const fork = app.plugin((ctx) => {
    video.apply(
      ctx,
      video.Config({
        command: '自动视频',
        autoParse: true,
        groups: ['600'],
        cooldown: 0,
        timeout: 2000,
        ffmpeg: process.env.FFMPEG || 'ffmpeg',
        ffprobe: process.env.FFPROBE || 'ffprobe',
      }),
    )
    ctx.middleware((s, next) => {
      forwarded.push(s.content)
      return next()
    })
  })
  try {
    wire.emit(wire.event('https://www.douyin.com/video/12345', 1001, 601))
    await waitFor(() => forwarded.includes('https://www.douyin.com/video/12345'))
    wire.emit(wire.event('https://example.org/unrelated', 1001, 600))
    await waitFor(() => forwarded.includes('https://example.org/unrelated'))
    const sent = await wire.command('https://www.douyin.com/video/12345', 1001, 600, (n) =>
      n.params.message.some((s) => s.type === 'video'),
    )
    assert.equal(sent.params.group_id, 600)
  } finally {
    await fork.dispose()
  }
})
