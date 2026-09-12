const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { App, h } = require('koishi')
const plugin = require('../packages/video/lib')
const { protocol } = require('./onebot-fixture.cjs')
const { networkFixture, waitFor } = require('./fixture.cjs')
let wire,
  app,
  folder,
  network,
  bytes,
  passed = []
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-auto-video-'))
  execFileSync(
    process.env.FFMPEG || 'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x240:r=10',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path.join(folder, 'v.mp4'),
    ],
    { windowsHide: true },
  )
  bytes = await fs.readFile(path.join(folder, 'v.mp4'))
  network = await networkFixture((call) => {
    const url = call.url
    if (url.hostname === 'api.bilibili.com')
      return url.pathname.endsWith('/view')
        ? {
            code: 0,
            data: {
              bvid: 'BV1GJ411x7h7',
              title: 'Bilibili test',
              owner: { name: 'author' },
              pages: [{ cid: 1, duration: 1, part: 'first' }],
            },
          }
        : { code: 0, data: { durl: [{ url: 'https://v.bilivideo.com/test.mp4', length: 1000 }] } }
    if (url.hostname === 'www.iesdouyin.com')
      return (
        'window._ROUTER_DATA=' +
        JSON.stringify({
          aweme_id: '12345',
          desc: 'Douyin test',
          video: { duration: 1000, play_addr: { url_list: ['https://v.douyinvod.com/test.mp4'] } },
        })
      )
    if (url.hostname === 'www.xiaohongshu.com')
      return (
        'window.__INITIAL_STATE__=' +
        JSON.stringify({
          note: {
            noteDetailMap: {
              abc123: {
                note: {
                  type: 'video',
                  title: 'XHS test',
                  video: {
                    media: {
                      video: { duration: 1 },
                      stream: {
                        h264: [
                          { width: 320, height: 240, masterUrl: 'https://sns-video.xhscdn.com/test.mp4' },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        })
      )
    return bytes
  })
  // A normal non-empty Koishi command prefix must not be required for auto parsing.
  app = new App({ prefix: ['#'], delay: { character: 0, message: 0, broadcast: 0 } })
  app.baseDir = folder
  app.plugin(plugin, {
    cooldown: 0,
    timeout: 2000,
    ffmpeg: process.env.FFMPEG || 'ffmpeg',
    ffprobe: process.env.FFPROBE || 'ffprobe',
  })
  app.middleware((s, next) => {
    passed.push(s.content)
    return next()
  })
  wire = await protocol(app)
})
after(async () => {
  await wire?.close()
  await network?.close()
  await fs.rm(folder, { recursive: true, force: true })
})
const video = (n) => n.params.message.some((s) => s.type === 'video')
test('default schema enables auto parsing in groups and private chats without any prefix', async () => {
  assert.equal(plugin.Config({}).autoParse, true)
  assert.equal(plugin.Config({}).showProgress, false)
  assert.deepEqual(plugin.Config({}).groups, [])
  await wire.command('分享：https://www.douyin.com/video/12345', 1001, 600, video)
  await wire.command('https://www.douyin.com/video/12345', 1002, null, video)
  assert.equal(
    wire.sent.some((n) => n.text.includes('已加入队列')),
    false,
  )
})
test('bare BV and XHS links use the default automatic path', async () => {
  await wire.command('BV1GJ411x7h7', 1001, 600, video)
  await wire.command('https://www.xiaohongshu.com/explore/abc123?xsec_token=test', 1001, 600, video)
})
test('OneBot JSON share cards with escaped slashes are decoded before link recognition', async () => {
  const raw = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    meta: { detail_1: { qqdocurl: 'https://www.douyin.com/video/12345' } },
  }).replaceAll('/', '\\/')
  await wire.command([{ type: 'json', data: { data: raw } }], 1001, 600, video)
  assert.ok(
    plugin
      .shareText({ content: '', elements: [h('onebot:json', { data: raw })] })
      .includes('https://www.douyin.com/video/12345'),
  )
})
test('manual prefixed preview sends metadata only and unsupported links continue to other plugins', async () => {
  const n = wire.sent.filter(video).length
  await wire.command('#视频解析 预览 https://www.douyin.com/video/12345', 1001, 600, (s) =>
    s.text.includes('Douyin test'),
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(wire.sent.filter(video).length, n)
  wire.emit(wire.event('https://www.youtube.com/watch?v=example', 1001, 600))
  await waitFor(() => passed.includes('https://www.youtube.com/watch?v=example'))
  assert.equal(wire.sent.filter(video).length, n)
})
test('malformed and oversized share cards are ignored without executing any content', () => {
  const bad = h('json', { data: '{"url":undefined;globalThis.bad=true}' })
  assert.equal(plugin.shareText({ content: String(bad), elements: [bad] }), '')
  assert.equal(plugin.shareText({ content: '', elements: [h('json', { data: 'a'.repeat(65537) })] }), '')
  assert.equal(globalThis.bad, undefined)
})
