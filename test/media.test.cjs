const assert = require('node:assert/strict')
const { before, after, test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { Media, ffmpeg, probe } = require('../packages/video/lib/media')
const { VideoProviders } = require('../packages/video/lib/providers')
const { Queue } = require('../packages/video/lib/queue')
const { PublicError, DeliveryError } = require('../packages/video/lib/net')
const { deliver } = require('../packages/video/lib')
const { networkFixture, waitFor } = require('./fixture.cjs')
let folder, fixture, videoBytes, audioBytes, verticalBytes, media
const config = {
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  ffprobe: process.env.FFPROBE || 'ffprobe',
  maxHeight: 360,
  maxVideoMB: 10,
  cacheMB: 20,
  cacheMinutes: 30,
}
const base = {
  site: 'bilibili',
  id: 'sample',
  part: 1,
  parts: 1,
  height: 240,
  title: 'Local sample',
  author: 'Test',
  cover: '',
  url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  seconds: 2,
  streams: ['https://v.bilivideo.com/video', 'https://v.bilivideo.com/audio'],
  mode: 'dash',
}
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-media-'))
  const run = (args) =>
    execFileSync(config.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
      cwd: folder,
      windowsHide: true,
    })
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=15',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    'video.mp4',
  ])
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:a', 'aac', 'audio.m4a'])
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=480x800:rate=10',
    '-t',
    '2',
    '-c:v',
    'libvpx-vp9',
    '-threads',
    '2',
    '-an',
    'vertical.webm',
  ])
  videoBytes = await fs.readFile(path.join(folder, 'video.mp4'))
  audioBytes = await fs.readFile(path.join(folder, 'audio.m4a'))
  verticalBytes = await fs.readFile(path.join(folder, 'vertical.webm'))
  fixture = await networkFixture((call) =>
    call.url.pathname === '/audio'
      ? audioBytes
      : call.url.pathname === '/vertical'
        ? verticalBytes
        : call.url.pathname === '/html'
          ? '<html>login required</html>'
          : videoBytes,
  )
  media = new Media(
    folder,
    new VideoProviders({
      ...config,
      biliCookie: '',
      douyinCookie: '',
      xhsCookie: '',
      timeout: 2000,
      proxy: '',
    }),
    config,
  )
})
after(async () => {
  await fixture?.close()
  await fs.rm(folder, { recursive: true, force: true })
})
async function inspect(bytes) {
  const file = path.join(folder, 'inspection.mp4')
  await fs.writeFile(file, bytes)
  return probe(config.ffprobe, file, new AbortController().signal)
}
test('real ffmpeg merges separate video/audio; ffprobe verifies H264/AAC, duration and cleanup', async () => {
  const bytes = await media.prepare(base, new AbortController().signal)
  const info = await inspect(bytes)
  assert.equal(info.video, 'h264')
  assert.equal(info.audio, 'aac')
  assert.ok(info.seconds >= 1.9)
  assert.ok(!(await fs.readdir(media.root)).some((name) => name.startsWith('job-')))
  const calls = fixture.calls.length
  assert.deepEqual(await media.prepare(base, new AbortController().signal), bytes)
  assert.equal(fixture.calls.length, calls)
})
test('vertical VP9 input is converted to MP4/H264 and scaled by the short edge', async () => {
  const bytes = await media.prepare(
    {
      ...base,
      id: 'vertical',
      site: 'douyin',
      mode: 'direct',
      streams: ['https://v.douyinvod.com/vertical'],
    },
    new AbortController().signal,
  )
  const info = await inspect(bytes)
  assert.equal(info.video, 'h264')
  assert.equal(info.width, 360)
  assert.equal(info.height, 600)
  assert.ok(info.format.includes('mp4'))
})
test('concatenated inputs retain their full combined duration', async () => {
  const bytes = await media.prepare(
    {
      ...base,
      id: 'concat',
      seconds: 4,
      mode: 'concat',
      streams: ['https://v.bilivideo.com/video', 'https://v.bilivideo.com/video'],
    },
    new AbortController().signal,
  )
  assert.ok((await inspect(bytes)).seconds >= 3.8)
})
test('HTML, truncated duration and over-budget outputs fail and remove job directories', async () => {
  await assert.rejects(
    media.prepare(
      { ...base, id: 'html', mode: 'direct', streams: ['https://v.bilivideo.com/html'] },
      new AbortController().signal,
    ),
    /非视频/,
  )
  await assert.rejects(
    media.prepare({ ...base, id: 'truncated', seconds: 40 }, new AbortController().signal),
    /时长异常/,
  )
  const limited = new Media(folder, media.provider, { ...config, maxVideoMB: 0.001 })
  await assert.rejects(limited.prepare({ ...base, id: 'too-big' }, new AbortController().signal), /大小限制/)
  assert.ok(!(await fs.readdir(media.root)).some((name) => name.startsWith('job-')))
})
test('expired cache is replaced and cleanup cannot remove unrelated files', async () => {
  const cache = (await fs.readdir(media.root)).filter((name) => /^[a-f0-9]{64}\.mp4$/.test(name))
  for (const name of cache) await fs.utimes(path.join(media.root, name), new Date(0), new Date(0))
  await fs.writeFile(path.join(media.root, 'keep.txt'), 'owned by user')
  const calls = fixture.calls.length
  await media.prepare(base, new AbortController().signal)
  assert.ok(fixture.calls.length > calls)
  const after = fixture.calls.length
  await media.prepare(base, new AbortController().signal)
  assert.equal(fixture.calls.length, after)
  await Promise.all([media.clean(), media.clean()])
  assert.equal(await fs.readFile(path.join(media.root, 'keep.txt'), 'utf8'), 'owned by user')
})
test('cancellation kills a real long-running ffmpeg process', async () => {
  const control = new AbortController()
  const pending = ffmpeg(
    config.ffmpeg,
    ['-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '60', '-f', 'null', '-'],
    control.signal,
    folder,
  )
  setTimeout(() => control.abort(), 150)
  await assert.rejects(pending, /取消/)
})
test('queue enforces capacity, deduplication, owner isolation and shutdown cancellation', async () => {
  const queue = new Queue(1, 1, 2000),
    entered = []
  const work = (label) => (signal) =>
    new Promise((_, reject) => {
      entered.push(label)
      signal.addEventListener('abort', () => reject(new PublicError('cancelled')), { once: true })
    })
  const first = queue.add('a', 'key-a', work('a'))
  const second = queue.add('b', 'key-b', work('b'))
  assert.throws(() => queue.add('c', 'key-c', work('c')), /已满/)
  assert.throws(() => queue.add('c', 'key-a', work('c')), /已有任务/)
  assert.equal(queue.cancel(first.id, 'b'), false)
  assert.equal(queue.cancel(second.id, 'b'), true)
  await waitFor(() => entered.length)
  await queue.close()
  await assert.rejects(first.done)
  await assert.rejects(second.done)
  assert.deepEqual(entered, ['a'])
  assert.equal(queue.tickets.size, 0)
})
test('missing send acknowledgement is unknown, with no automatic retry', async () => {
  let calls = 0
  const queue = new Queue(1, 0, 1000)
  const ticket = queue.add('a', 'send', (signal) =>
    deliver(
      {
        send: () => {
          calls++
          return new Promise(() => {})
        },
      },
      'video',
      20,
      signal,
    ),
  )
  await assert.rejects(ticket.done, /结果未知/)
  assert.equal(calls, 1)
  assert.equal(ticket.state, 'uncertain')
  await queue.close()
})
