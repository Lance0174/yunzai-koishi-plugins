import { PublicError, json, request, checkedUrl, RequestOptions } from './net'
import JSON5 from 'json5'

export type Platform = 'netease' | 'qq' | 'kugou' | 'kuwo'
export type Quality = 'standard' | 'high' | 'lossless'
export interface Track {
  platform: Platform
  id: string
  title: string
  artist: string
  seconds: number
  cover: string
  link: string
  extra?: string
  shareId?: string
}
export interface Play {
  url: string
  quality: string
  mime: string
}
export interface ProviderConfig {
  timeout: number
  proxy: string
  qqCookie: string
  neteaseApi: string
  neteaseCookie: string
  kugouApi: string
  kugouCookie: string
}
export const titles: Record<Platform, string> = {
  netease: '网易云',
  qq: 'QQ音乐',
  kugou: '酷狗',
  kuwo: '酷我',
}
export const mediaHosts: Record<Platform, string[]> = {
  netease: ['music.163.com', 'music.126.net', 'vod.126.net'],
  qq: ['qq.com', 'qqmusic.qq.com', 'qqmusic.tc.qq.com'],
  kugou: ['kugou.com', 'kugou.net', 'kgimg.com'],
  kuwo: ['kuwo.cn', 'kuwo.com'],
}
export function platform(value?: string): Platform {
  const aliases: Record<string, Platform> = {
    qq: 'qq',
    qq音乐: 'qq',
    腾讯: 'qq',
    网易: 'netease',
    网易云: 'netease',
    netease: 'netease',
    酷狗: 'kugou',
    kugou: 'kugou',
    酷我: 'kuwo',
    kuwo: 'kuwo',
  }
  const selected = aliases[(value ?? 'netease').toLowerCase()]
  if (!selected) throw new PublicError('平台请选择：网易云、QQ、酷狗、酷我。')
  return selected
}
export function quality(value?: string): Quality {
  const aliases: Record<string, Quality> = {
    standard: 'standard',
    标准: 'standard',
    high: 'high',
    高: 'high',
    lossless: 'lossless',
    无损: 'lossless',
  }
  const selected = aliases[value ?? 'standard']
  if (!selected) throw new PublicError('音质请选择 standard/标准、high/高、lossless/无损。')
  return selected
}
const string = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 500) : ''
const address = (value: unknown) => {
  if (typeof value !== 'string') return ''
  if (value.length > 16000) throw new PublicError('音源地址过长。')
  return value
}
const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const clean = (value: unknown) =>
  string(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim()
function validId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new PublicError('歌曲标识无效。')
  return id
}

export class Providers {
  constructor(readonly config: ProviderConfig) {}
  options(hosts: string[], signal?: AbortSignal, headers?: Record<string, string>): RequestOptions {
    return { hosts, timeout: this.config.timeout, proxy: this.config.proxy, signal, headers }
  }
  async gateway(
    base: string,
    path: string,
    params: Record<string, string>,
    cookie: string,
    signal?: AbortSignal,
  ) {
    let url: URL
    try {
      url = new URL(base)
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw 0
    } catch {
      throw new PublicError('音乐 API 地址配置无效。')
    }
    const endpoint = new URL(base.replace(/\/$/, '') + path)
    const payload = new URLSearchParams(params)
    if (cookie) payload.set('cookie', cookie)
    return json(endpoint.href, {
      ...this.options([url.hostname], signal),
      trustedOrigin: url.origin,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
    })
  }
  async search(source: Platform, keyword: string, limit: number, signal?: AbortSignal): Promise<Track[]> {
    if (!keyword.trim() || keyword.length > 100) throw new PublicError('关键词长度须为 1～100 字。')
    let tracks: Track[]
    if (source === 'netease') {
      const data = this.config.neteaseApi
        ? await this.gateway(
            this.config.neteaseApi,
            '/search',
            { keywords: keyword, limit: String(limit), type: '1' },
            this.config.neteaseCookie,
            signal,
          )
        : await json(
            `https://music.163.com/api/search/get/web?${new URLSearchParams({ s: keyword, type: '1', limit: String(limit), offset: '0' })}`,
            this.options(['music.163.com'], signal, { Referer: 'https://music.163.com/' }),
          )
      if (data.code && data.code !== 200)
        throw new PublicError(`网易云搜索未成功（code=${Number(data.code) || '未知'}）。`)
      tracks = list(data.result?.songs).map((s) => ({
        platform: source,
        id: string(s.id),
        title: clean(s.name),
        artist: list(s.artists ?? s.ar)
          .map((a) => clean(a.name))
          .join('/'),
        seconds: Number(s.duration ?? s.dt) / 1000 || 0,
        cover: string(s.album?.picUrl ?? s.al?.picUrl),
        link: `https://music.163.com/song?id=${string(s.id)}`,
      }))
    } else if (source === 'qq') {
      const query = {
        comm: { ct: 24, cv: 0 },
        req: {
          module: 'music.search.SearchCgiService',
          method: 'DoSearchForQQMusicDesktop',
          param: { query: keyword, num_per_page: limit, page_num: 1, search_type: 0 },
        },
      }
      let songs: any[] = []
      try {
        const data = await json('https://u.y.qq.com/cgi-bin/musicu.fcg', {
          ...this.options(['u.y.qq.com'], signal, {
            Referer: 'https://y.qq.com/',
            Cookie: this.config.qqCookie,
            'Content-Type': 'application/json',
          }),
          method: 'POST',
          body: JSON.stringify(query),
        })
        songs = list(data.req?.data?.body?.song?.list)
      } catch (error) {
        if (signal?.aborted) throw error
      }
      if (!songs.length) {
        const data = await json(
          `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${new URLSearchParams({ w: keyword, n: String(limit), p: '1', format: 'json' })}`,
          this.options(['c.y.qq.com'], signal, {
            Referer: 'https://y.qq.com/',
            Cookie: this.config.qqCookie,
          }),
        )
        songs = list(data.data?.song?.list)
        if (data.code && data.code !== 0)
          throw new PublicError('QQ音乐搜索需要有效 Cookie，或当前接口暂不可用。')
      }
      tracks = songs.map((s) => {
        const mid = string(s.mid ?? s.songmid)
        const album = string(s.album?.mid ?? s.albummid)
        return {
          platform: source,
          id: mid,
          shareId: /^\d+$/.test(string(s.id ?? s.songid)) ? string(s.id ?? s.songid) : undefined,
          title: clean(s.title ?? s.songname ?? s.name),
          artist: list(s.singer)
            .map((a) => clean(a.name))
            .join('/'),
          seconds: Number(s.interval) || 0,
          extra: string(s.file?.media_mid ?? mid),
          cover: album ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${album}.jpg` : '',
          link: `https://y.qq.com/n/ryqq/songDetail/${mid}`,
        }
      })
    } else if (source === 'kugou') {
      const data = this.config.kugouApi
        ? await this.gateway(
            this.config.kugouApi,
            '/search',
            { keywords: keyword, pagesize: String(limit) },
            this.config.kugouCookie,
            signal,
          )
        : await json(
            `https://msearch.kugou.com/api/v3/search/song?${new URLSearchParams({ keyword, page: '1', pagesize: String(limit), format: 'json' })}`,
            this.options(['msearch.kugou.com'], signal),
          )
      if (data.status === 0 || data.error_code > 0)
        throw new PublicError('酷狗搜索接口不可用；可在配置中接入酷狗 API。')
      tracks = list(data.data?.info ?? data.data?.lists).map((s) => {
        const id = string(s.hash ?? s.FileHash)
        return {
          platform: source,
          id,
          title: clean(s.songname ?? s.SongName ?? s.filename),
          artist: clean(s.singername ?? s.SingerName),
          seconds: Number(s.duration ?? s.Duration) || 0,
          cover: '',
          link: `https://www.kugou.com/song/#hash=${id}`,
        }
      })
    } else {
      const reply = await request(
        `https://search.kuwo.cn/r.s?${new URLSearchParams({ all: keyword, ft: 'music', itemset: 'web_2013', client: 'kt', pn: '0', rn: String(limit), rformat: 'json', encoding: 'utf8' })}`,
        this.options(['search.kuwo.cn'], signal, { Referer: 'https://www.kuwo.cn/' }),
      )
      let data: any
      try {
        data = JSON5.parse(reply.body.toString('utf8'))
      } catch {
        throw new PublicError('酷我搜索数据格式已变化。')
      }
      tracks = list(data.abslist).map((s) => {
        const id = string(s.MUSICRID ?? s.rid).replace(/^MUSIC_/, '')
        return {
          platform: source,
          id,
          title: clean(s.NAME ?? s.name),
          artist: clean(s.ARTIST ?? s.artist),
          seconds: Number(s.DURATION) || 0,
          cover: string(
            s.web_albumpic_short ? `https://img4.kuwo.cn/star/albumcover/${s.web_albumpic_short}` : '',
          ),
          link: `https://www.kuwo.cn/play_detail/${id}`,
        }
      })
    }
    return tracks.filter((t) => /^[a-zA-Z0-9_-]{1,100}$/.test(t.id) && t.title).slice(0, limit)
  }
  async resolve(track: Track, level: Quality, signal?: AbortSignal): Promise<Play> {
    const id = validId(track.id)
    let url = '',
      mime = 'audio/mpeg',
      actual = '标准'
    if (track.platform === 'netease') {
      if (this.config.neteaseApi) {
        const data = await this.gateway(
          this.config.neteaseApi,
          '/song/url/v1',
          { id, level: { standard: 'standard', high: 'exhigh', lossless: 'lossless' }[level] },
          this.config.neteaseCookie,
          signal,
        )
        const song = list(data.data)[0]
        url = address(song?.url)
        mime = song?.type === 'flac' ? 'audio/flac' : 'audio/mpeg'
        actual = Number(song?.br) ? `${Math.round(song.br / 1000)}kbps` : '音源返回音质'
      } else {
        if (level !== 'standard')
          throw new PublicError('网易云高音质需要配置可用的网易云 API 和有权限的账号。')
        url = `https://music.163.com/song/media/outer/url?id=${id}.mp3`
      }
    } else if (track.platform === 'qq') {
      const media = validId(track.extra || id),
        ext = level === 'lossless' ? 'flac' : level === 'high' ? 'mp3' : 'm4a'
      const filename = `${{ standard: 'C400', high: 'M800', lossless: 'F000' }[level]}${media}.${ext}`
      const payload = {
        comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
        req: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            guid: String(Date.now()),
            songmid: [id],
            songtype: [0],
            filename: [filename],
            uin: '0',
            loginflag: 1,
            platform: '20',
          },
        },
      }
      const data = await json('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        ...this.options(['u.y.qq.com'], signal, {
          Referer: 'https://y.qq.com/',
          Cookie: this.config.qqCookie,
          'Content-Type': 'application/json',
        }),
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const result = data.req?.data,
        purl = address(result?.midurlinfo?.[0]?.purl)
      if (purl) url = new URL(purl, result.sip?.[0] || 'https://isure.stream.qqmusic.qq.com/').href
      actual = level === 'standard' ? 'M4A' : level === 'high' ? '320kbps' : 'FLAC'
      mime = ext === 'm4a' ? 'audio/mp4' : ext === 'flac' ? 'audio/flac' : 'audio/mpeg'
    } else if (track.platform === 'kugou') {
      if (this.config.kugouApi) {
        const data = await this.gateway(
          this.config.kugouApi,
          '/song/url',
          { hash: id, quality: { standard: '128', high: '320', lossless: 'flac' }[level] },
          this.config.kugouCookie,
          signal,
        )
        const urls = data.url ?? data.data?.url
        url = address(Array.isArray(urls) ? urls[0] : urls)
        actual = '音源返回音质'
      } else {
        if (level !== 'standard') throw new PublicError('酷狗高音质需要配置酷狗 API 和有权限的账号。')
        const data = await json(
          `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${id}`,
          this.options(['m.kugou.com'], signal),
        )
        url = address(data.url)
      }
    } else {
      if (level !== 'standard') throw new PublicError('当前酷我接口仅启用标准音质。')
      const response = await request(
        `https://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${id}&format=mp3&response=url`,
        this.options(['antiserver.kuwo.cn', 'kuwo.cn'], signal, { Referer: 'https://www.kuwo.cn/' }),
      )
      url = response.body.toString('utf8').trim()
    }
    if (!url) throw new PublicError('未取得可用音源，可能需要有效登录态或该歌曲的播放权限。')
    checkedUrl(url, { hosts: mediaHosts[track.platform] })
    return { url, mime, quality: actual }
  }
  async lyrics(track: Track, signal?: AbortSignal): Promise<string> {
    const id = validId(track.id)
    let lyrics = ''
    if (track.platform === 'netease') {
      const data = this.config.neteaseApi
        ? await this.gateway(this.config.neteaseApi, '/lyric', { id }, this.config.neteaseCookie, signal)
        : await json(
            `https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`,
            this.options(['music.163.com'], signal),
          )
      lyrics = data.lrc?.lyric ?? ''
    } else if (track.platform === 'qq') {
      const data = await json(
        `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${id}&format=json&nobase64=1`,
        this.options(['c.y.qq.com'], signal, { Referer: 'https://y.qq.com/', Cookie: this.config.qqCookie }),
      )
      lyrics = typeof data.lyric === 'string' ? data.lyric : ''
    } else if (track.platform === 'kuwo') {
      const data = await json(
        `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${id}`,
        this.options(['m.kuwo.cn'], signal, { Referer: 'https://www.kuwo.cn/' }),
      )
      lyrics = list(data.data?.lrclist)
        .map((row) => `[${row.time}] ${row.lineLyric}`)
        .join('\n')
    } else {
      const data = await json(
        `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash=${id}`,
        this.options(['lyrics.kugou.com'], signal),
      )
      const candidate = list(data.candidates)[0]
      if (candidate?.id && candidate?.accesskey) {
        const result = await json(
          `https://lyrics.kugou.com/download?${new URLSearchParams({ ver: '1', client: 'pc', id: string(candidate.id), accesskey: string(candidate.accesskey), fmt: 'lrc', charset: 'utf8' })}`,
          this.options(['lyrics.kugou.com'], signal),
        )
        if (typeof result.content === 'string')
          lyrics = Buffer.from(result.content, 'base64').toString('utf8')
      }
    }
    return typeof lyrics === 'string' && lyrics.trim() ? lyrics.slice(0, 12000) : '该音源没有提供歌词。'
  }
}
