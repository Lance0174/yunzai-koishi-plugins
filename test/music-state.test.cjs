const assert = require('node:assert/strict')
const { test, before, after, mock: testing } = require('node:test')
const { App } = require('koishi')
const mock = require('@koishijs/plugin-mock').default
const plugin = require('../packages/music/lib')
const { Providers } = require('../packages/music/lib/providers')
const { networkFixture, waitFor } = require('./fixture.cjs')
let fixture, app, fork, alice, bob
before(async () => {
  fixture = await networkFixture((call, res) => {
    if (call.url.searchParams.get('s') === 'slow') {
      res.writeHead(200)
      res.write('{')
      return
    }
    return { result: { songs: [{ id: 1, name: '有效歌曲', artists: [] }] } }
  })
  app = new App({ prefix: [''], delay: { character: 0, message: 0 } })
  fork = app.plugin(mock)
  app.plugin(plugin, { maxConcurrent: 1, cooldown: 0, timeout: 1000 })
  await app.start()
  alice = app.mock.client('alice', 'group')
  bob = app.mock.client('bob', 'group')
})
after(async () => {
  testing.restoreAll()
  await fork?.dispose()
  await app?.stop()
  await fixture?.close()
})
test('in-flight search blocks duplicate/global overload, can be cancelled and releases its slot', async () => {
  const pending = alice.receive('点歌 slow')
  await waitFor(() => fixture.calls.some((call) => call.url.searchParams.get('s') === 'slow'))
  await alice.shouldReply('点歌 新搜索', /已有音乐任务/)
  await bob.shouldReply('点歌 another', /音乐任务已满/)
  await alice.shouldReply('点歌 取消', /已请求取消/)
  const result = await pending
  assert.ok(result.join('').match(/取消|中断/))
  await bob.shouldReply('点歌 正常', /有效歌曲/)
  await alice.shouldReply('点歌 列表', /会话已过期或不属于/)
})
test('expired sessions cannot select another cached song', async () => {
  await alice.shouldReply('点歌 正常', /有效歌曲/)
  const now = Date.now()
  const time = testing.method(Date, 'now', () => now + 11 * 60000)
  try {
    await alice.shouldReply('点歌 播放 1', /会话已过期或不属于/)
  } finally {
    time.mock.restore()
  }
})
