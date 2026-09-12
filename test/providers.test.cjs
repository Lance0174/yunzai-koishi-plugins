const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { networkFixture } = require('./fixture.cjs')
const { Providers, platform, quality } = require('../packages/music/lib/providers')
const { VideoProviders, identify, stateJson, biliStream } = require('../packages/video/lib/providers')
const longUrl = 'https://m.music.126.net/track.mp3?signature=' + 'a'.repeat(1400)
let fixture,
  mode = ''
before(async () => {
  fixture = await networkFixture((call, res) => {
    const url = call.url
    if (url.pathname === '/search' || url.pathname.includes('/api/search'))
      return {
        code: 200,
        result: {
          songs: [{ id: 1, name: 'Song <b>A</b>', artists: [{ name: 'Artist' }], duration: 120000 }],
        },
      }
    if (url.pathname === '/song/url/v1') return { data: [{ url: longUrl, type: 'mp3', br: 128000 }] }
    if (url.hostname === 'u.y.qq.com') {
      const data = JSON.parse(call.body)
      if (data.req.module.includes('search')) {
        const list = [
          {
            mid: 'abcd123',
            title: 'QQ Song',
            singer: [{ name: 'Singer' }],
            file: { media_mid: 'media123' },
            interval: 200,
          },
        ]
        return { req: { data: { body: { song: { list } } } } }
      }
      return {
        req: {
          data: {
            sip: ['https://isure.stream.qqmusic.qq.com/'],
            midurlinfo: [{ purl: 'song.m4a?vkey=' + 'a'.repeat(1000) }],
          },
        },
      }
    }
    if (url.hostname === 'msearch.kugou.com')
      return {
        status: 1,
        data: { info: [{ hash: 'abcdef0123', songname: '酷狗歌', singername: '歌手', duration: 200 }] },
      }
    if (url.pathname === '/song/url') return { url: 'https://fs.kugou.com/test.mp3' }
    if (url.hostname === 'search.kuwo.cn')
      return "{'abslist':[{'MUSICRID':'MUSIC_123','NAME':'晴天&nbsp;伴奏','ARTIST':'歌手','DURATION':'269'}]}"
    if (url.hostname === 'antiserver.kuwo.cn') return 'https://sycdn.kuwo.cn/track.mp3'
    if (url.pathname.includes('/lyric')) return { lrc: { lyric: '[00:01]lyrics' } }
    if (url.hostname === 'api.bilibili.com') {
      if (url.pathname.endsWith('/view'))
        return {
          code: 0,
          data: {
            bvid: 'BV1GJ411x7h7',
            title: 'B站 sample',
            owner: { name: 'Creator' },
            pages: [
              { cid: 10, part: 'first', duration: 2 },
              { cid: 20, part: 'second', duration: 3 },
            ],
          },
        }
      return {
        code: 0,
        data: {
          dash: {
            video: [
              {
                height: 1080,
                width: 1920,
                codecs: 'avc1',
                bandwidth: 1000,
                baseUrl: 'https://v.bilivideo.com/1080',
              },
              {
                height: 720,
                width: 1280,
                codecs: 'avc1',
                bandwidth: 1000,
                baseUrl: 'https://v.bilivideo.com/720',
              },
            ],
            audio: [{ bandwidth: 100, baseUrl: 'https://v.bilivideo.com/audio' }],
          },
        },
      }
    }
    if (url.hostname === 'v.douyin.com') {
      res.writeHead(302, { location: 'https://www.douyin.com/video/12345' })
      res.end()
      return
    }
    if (url.hostname === 'www.douyin.com') return '<html/>'
    if (url.hostname === 'www.iesdouyin.com')
      return (
        'window._ROUTER_DATA = ' +
        JSON.stringify({
          videos: [
            { aweme_id: '99999', video: { play_addr: { url_list: ['https://v.douyinvod.com/wrong'] } } },
            {
              aweme_id: '12345',
              desc: '目标视频',
              author: { nickname: '作者' },
              ...(mode === 'gallery' ? { images: [1] } : {}),
              video: {
                duration: 3000,
                height: 1280,
                play_addr: { url_list: ['https://v.douyinvod.com/right'] },
              },
            },
          ],
        })
      )
    if (url.hostname === 'www.xiaohongshu.com') {
      assert.equal(url.searchParams.get('xsec_token'), 'keep-me')
      return (
        'window.__INITIAL_STATE__=' +
        JSON.stringify({
          note: {
            noteDetailMap: {
              abc123: {
                note: {
                  type: mode === 'gallery' ? 'normal' : 'video',
                  title: '小红书',
                  user: { nickname: '作者' },
                  video: {
                    media: {
                      video: { duration: 3 },
                      stream: {
                        h264: [{ width: 720, height: 1280, masterUrl: 'https://sns-video.xhscdn.com/test' }],
                      },
                    },
                  },
                },
              },
            },
          },
        })
      )
    }
    throw new Error('Unexpected fixture URL ' + url.hostname + url.pathname)
  })
})
after(async () => fixture.close())
const config = {
  timeout: 2000,
  proxy: '',
  qqCookie: '',
  neteaseApi: 'https://api.example.com',
  neteaseCookie: 'never-in-query',
  kugouApi: '',
  kugouCookie: '',
}
const music = new Providers(config)
const videos = new VideoProviders({
  ...config,
  biliCookie: '',
  douyinCookie: '',
  xhsCookie: '',
  maxHeight: 720,
  maxVideoMB: 40,
})

test('four provider response contracts produce searchable tracks and preserve long signed URLs', async () => {
  for (const source of ['netease', 'qq', 'kugou', 'kuwo']) {
    const tracks = await music.search(source, '晴天', 3)
    assert.equal(tracks.length, 1)
    assert.equal(tracks[0].platform, source)
    if (source === 'kugou') continue
    const play = await music.resolve(tracks[0], 'standard')
    assert.ok(play.url.startsWith('https://'))
    if (source === 'netease') assert.equal(play.url, longUrl)
    if (source === 'qq') assert.ok(play.url.length > 1000)
    if (source === 'kuwo') assert.equal(tracks[0].title, '晴天 伴奏')
  }
  const custom = new Providers({ ...config, kugouApi: 'https://api.example.com' })
  assert.equal(
    (await custom.resolve({ platform: 'kugou', id: 'hash' }, 'standard')).url,
    'https://fs.kugou.com/test.mp3',
  )
  const request = fixture.calls.find((call) => call.url.pathname === '/search')
  assert.ok(!request.url.href.includes('never-in-query'))
  assert.ok(request.body.includes('cookie='))
})
test('unknown platform/quality and unconfigured premium quality are reported explicitly', async () => {
  assert.equal(platform('QQ音乐'), 'qq')
  assert.throws(() => platform('任意站点'))
  assert.equal(quality('无损'), 'lossless')
  assert.throws(() => quality('ultra'))
  await assert.rejects(music.resolve({ id: '123', platform: 'kuwo' }, 'lossless'), /仅启用标准/)
})
test('only Bilibili, Douyin and Xiaohongshu links match; unsupported links fall through', () => {
  for (const value of [
    'https://youtube.com/a',
    'https://bilibili.com.attacker.org/a',
    'https://user:pass@douyin.com/a',
    'https://www.douyin.com:8888/video/123',
  ])
    assert.equal(identify(value), undefined)
  assert.equal(identify('BV1GJ411x7h7').site, 'bilibili')
  assert.equal(
    identify('分享 https://www.xiaohongshu.com/explore/abc123?xsec_token=keep-me）。').site,
    'xiaohongshu',
  )
})
test('SSR parser never evaluates JavaScript and preserves literal undefined text', () => {
  assert.deepEqual(
    stateJson('window.__DATA__={"x":undefined,"y":"undefined", "q":"}\\\""};alert(1)', 'window.__DATA__'),
    { x: null, y: 'undefined', q: '}"' },
  )
  assert.throws(() => stateJson('window.__DATA__=(()=>{globalThis.compromised=1})()', 'window.__DATA__'))
  assert.throws(() => stateJson('window.__DATA__={x:(globalThis.compromised=1)}', 'window.__DATA__'))
  assert.equal(globalThis.compromised, undefined)
})
test('Bilibili selects the requested part and compatible DASH streams', async () => {
  assert.equal(
    biliStream({
      baseUrl: 'https://edge.mcdn.bilivideo.cn:8082/a',
      backupUrl: ['https://unlisted-cdn.example.com/a', 'https://upos.bilivideo.com/a'],
    }),
    'https://upos.bilivideo.com/a',
  )
  const value = await videos.resolve(identify('https://www.bilibili.com/video/BV1GJ411x7h7?p=2'), 1)
  assert.equal(value.part, 2)
  assert.equal(value.mode, 'dash')
  assert.equal(value.height, 720)
  assert.deepEqual(value.streams, ['https://v.bilivideo.com/720', 'https://v.bilivideo.com/audio'])
  assert.equal(
    fixture.calls.findLast((call) => call.url.pathname.endsWith('/playurl')).url.searchParams.get('cid'),
    '20',
  )
  await assert.rejects(videos.resolve(identify('BV1GJ411x7h7'), 3), /超出范围/)
})
test('Douyin chooses the exact video and Xiaohongshu retains share parameters for vertical video', async () => {
  const douyin = await videos.resolve(identify('https://v.douyin.com/short'), 1)
  assert.equal(douyin.title, '目标视频')
  assert.equal(douyin.streams[0], 'https://v.douyinvod.com/right')
  const xhs = await videos.resolve(
    identify('https://www.xiaohongshu.com/explore/abc123?xsec_token=keep-me'),
    1,
  )
  assert.equal(xhs.height, 1280)
  assert.equal(xhs.streams.length, 1)
  mode = 'gallery'
  await assert.rejects(videos.resolve(identify('https://www.douyin.com/video/12345'), 1), /图集/)
  await assert.rejects(
    videos.resolve(identify('https://www.xiaohongshu.com/explore/abc123?xsec_token=keep-me'), 1),
    /图文/,
  )
  mode = ''
})
