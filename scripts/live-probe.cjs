// Read-only public-source probes. No QQ/OneBot messages or write actions.
const { mkdir, writeFile } = require('node:fs/promises')
const { Providers } = require('../packages/music/lib/providers')
const { VideoProviders, identify } = require('../packages/video/lib/providers')
const { request, mediaKind } = require('../packages/music/lib/net')
const { mediaHosts } = require('../packages/music/lib/providers')

async function main() {
  const config = {
    timeout: 15000,
    proxy: process.env.PROBE_PROXY || '',
    qqCookie: '',
    neteaseApi: '',
    neteaseCookie: '',
    kugouApi: '',
    kugouCookie: '',
  }
  const music = new Providers(config),
    results = []
  await Promise.all(
    ['netease', 'qq', 'kugou', 'kuwo'].map(async (platform) => {
      const row = { platform, search: 'not-run', playback: 'not-run', lyrics: 'not-run' }
      results.push(row)
      try {
        const tracks = await music.search(platform, '晴天', 3)
        row.search = tracks.length ? 'passed' : 'empty'
        row.count = tracks.length
        if (!tracks.length) return
        row.sample = { title: tracks[0].title, id: tracks[0].id }
        try {
          const play = await music.resolve(tracks[0], 'standard')
          const reply = await request(play.url, {
            ...music.options(mediaHosts[platform]),
            maxBytes: 15 * 1024 * 1024,
          })
          row.playback = ['audio', 'video'].includes(mediaKind(reply.body)) ? 'downloaded-media' : 'not-media'
          row.bytes = reply.body.length
        } catch (e) {
          row.playback = 'failed'
          row.playError = e.message
        }
        try {
          const lyric = await music.lyrics(tracks[0])
          row.lyrics = lyric.includes('没有提供歌词') ? 'unavailable' : 'passed'
        } catch (e) {
          row.lyrics = 'failed'
          row.lyricError = e.message
        }
      } catch (e) {
        row.search = 'failed'
        row.error = e.message
      }
    }),
  )
  const video = new VideoProviders({
    ...config,
    biliCookie: '',
    douyinCookie: '',
    xhsCookie: '',
    maxHeight: 720,
    maxVideoMB: 40,
  })
  for (const sample of ['BV1GJ411x7h7', ...process.argv.slice(2)]) {
    const input = identify(sample)
    if (!input) continue
    const row = { platform: input.site, metadata: 'not-run' }
    results.push(row)
    try {
      const value = await video.resolve(input, 1)
      Object.assign(row, {
        metadata: 'passed',
        title: value.title,
        id: value.id,
        mode: value.mode,
        streams: value.streams.length,
        seconds: value.seconds,
      })
    } catch (e) {
      row.metadata = 'failed'
      row.error = e.message
    }
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile(
    'artifacts/live-probe.json',
    JSON.stringify(
      { checkedAt: new Date().toISOString(), proxy: !!config.proxy, authenticated: false, results },
      null,
      2,
    ) + '\n',
  )
  console.log(JSON.stringify(results, null, 2))
}
main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
