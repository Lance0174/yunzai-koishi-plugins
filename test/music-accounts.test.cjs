const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { App } = require('koishi')
const { createDecipheriv, createHash } = require('node:crypto')
const music = require('../packages/music/lib')
const { AccountStore } = require('../packages/music/lib/accounts')
const { protocol } = require('./onebot-fixture.cjs')
const { networkFixture, waitFor } = require('./fixture.cjs')
let app,
  wire,
  network,
  folder,
  responseCode = 801,
  held,
  hold = false
const scope = (self) =>
  createHash('sha256')
    .update(JSON.stringify(['onebot', self, 'netease']))
    .digest('hex')
const origin = 'https://interface.music.163.com'
const image = (row) => row.params.message.some((s) => s.type === 'image')
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'yunzai-accounts-'))
  network = await networkFixture((call, res) => {
    if (call.url.pathname.includes('/api/search'))
      return { code: 200, result: { songs: [{ id: 42, name: '登录音源测试', artists: [] }] } }
    if (call.url.hostname === 'm.music.126.net')
      return Buffer.from('4944330400000000000046495854555245', 'hex')
    const params = new URLSearchParams(call.body).get('params')
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null)
    const text = Buffer.concat([decipher.update(Buffer.from(params, 'hex')), decipher.final()]).toString()
    const [endpoint, input, digest] = text.split('-36cd479b6b5-')
    assert.equal(digest, createHash('md5').update(`nobody${endpoint}use${input}md5forencrypt`).digest('hex'))
    if (endpoint === '/api/song/enhance/player/url/v1') {
      assert.match(call.headers.cookie, /MUSIC_U=synthetic-login/)
      assert.deepEqual(JSON.parse(JSON.parse(input).ids), ['42'])
      return { code: 200, data: [{ url: 'https://m.music.126.net/account.mp3', type: 'mp3', br: 128000 }] }
    }
    assert.equal(JSON.parse(input).type, 3)
    if (endpoint.endsWith('/unikey')) return { code: 200, unikey: 'fixture-key-0123456789' }
    assert.equal(JSON.parse(input).key, 'fixture-key-0123456789')
    if (hold) {
      held = res
      return
    }
    if (responseCode === 803)
      res.setHeader('set-cookie', [
        'MUSIC_U=synthetic-login; Path=/; HttpOnly',
        '__csrf=synthetic-csrf; Path=/',
      ])
    return { code: responseCode }
  })
  app = new App({ prefix: [''], delay: { character: 0, message: 0 } })
  app.baseDir = folder
  app.plugin(music, { loginAdmins: ['1001'], cooldown: 0, timeout: 10000 })
  wire = await protocol(app)
})
after(async () => {
  await wire?.close()
  await network?.close()
  await fs.rm(folder, { recursive: true, force: true })
})
test('account commands require an administrator private chat and the config has no cookie input', async () => {
  assert.match((await wire.command('点歌 登录 网易云', 1001, 500)).text, /私聊/)
  assert.match((await wire.command('点歌 登录 网易云', 1002, null)).text, /管理员/)
  assert.equal(network.calls.length, 0)
  assert.equal(
    Object.keys(music.Config({})).some((key) => /cookie/i.test(key)),
    false,
  )
})
test('QR login sends an image, waits for app confirmation and persists a bot-scoped account', async () => {
  const qr = await wire.command('点歌 登录 网易云', 1001, null, image)
  const file = qr.params.message.find((s) => s.type === 'image').data.file
  assert.equal(
    Buffer.from(file.slice('base64://'.length), 'base64').subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
  )
  responseCode = 802
  await waitFor(() => wire.sent.some((row) => row.text.includes('已扫码')), 8000)
  responseCode = 803
  await waitFor(() => wire.sent.some((row) => row.text.includes('网易云登录成功')), 8000)
  const store = new AccountStore(folder)
  assert.match(await store.get(scope('900001'), origin), /MUSIC_U=synthetic-login/)
  assert.equal(await store.get(scope('900002'), origin), '')
  assert.equal(await store.get(scope('900001'), 'https://different.example'), '')
  assert.equal(
    wire.sent.some((row) => row.text.includes('synthetic-login')),
    false,
  )
  assert.match((await wire.command('点歌 账号', 1001, null)).text, /已保存/)
  const voice = await wire.command('点歌 登录音源测试 --语音', 1001, null, (row) =>
    row.params.message.some((segment) => segment.type === 'record'),
  )
  assert.ok(voice.params.message.some((segment) => segment.type === 'record'))
  assert.ok(
    network.calls.some(
      (call) =>
        call.url.pathname.endsWith('/song/enhance/player/url/v1') &&
        call.headers.cookie.includes('MUSIC_U=synthetic-login'),
    ),
  )
  await wire.command('点歌 退出登录 网易云', 1001, null)
  assert.equal(await new AccountStore(folder).get(scope('900001'), origin), '')
})
test('logout cancels a pending poll and a late successful response cannot restore the account', async () => {
  hold = true
  await wire.command('点歌 登录 网易云', 1001, null, image)
  await waitFor(() => held, 8000)
  await wire.command('点歌 退出登录 网易云', 1001, null)
  if (!held.destroyed) {
    held.setHeader('set-cookie', ['MUSIC_U=late-synthetic; Path=/'])
    held.end(JSON.stringify({ code: 803 }))
  }
  hold = false
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(await new AccountStore(folder).get(scope('900001'), origin), '')
})
test('expired QR codes report expiration and never create login credentials', async () => {
  responseCode = 800
  await wire.command('点歌 登录 网易云', 1001, null, image)
  await waitFor(() => wire.sent.some((row) => row.text.includes('二维码已失效')), 8000)
  assert.equal(await new AccountStore(folder).get(scope('900001'), origin), '')
})
