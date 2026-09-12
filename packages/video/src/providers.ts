import { PublicError, request, json, hostMatches, checkedUrl, RequestOptions } from './net'

export type Site = 'bilibili' | 'douyin' | 'xiaohongshu'
export interface Input {
  site: Site
  url: string
}
export interface Video {
  site: Site
  id: string
  title: string
  author: string
  url: string
  cover: string
  seconds: number
  part: number
  parts: number
  height: number
  streams: string[]
  mode: 'direct' | 'dash' | 'concat'
}
export interface ProviderConfig {
  biliCookie: string
  douyinCookie: string
  xhsCookie: string
  proxy: string
  timeout: number
  maxHeight: 360 | 480 | 720 | 1080
  maxVideoMB: number
}
export const names: Record<Site, string> = { bilibili: 'B站', douyin: '抖音', xiaohongshu: '小红书' }
export const entryHosts: Record<Site, string[]> = {
  bilibili: ['bilibili.com', 'b23.tv', 'bili2233.cn'],
  douyin: ['douyin.com', 'iesdouyin.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
}
export const mediaHosts: Record<Site, string[]> = {
  bilibili: ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'hdslb.com', 'bilibili.com'],
  douyin: [
    'douyinvod.com',
    'douyin.com',
    'iesdouyin.com',
    'amemv.com',
    'bytecdn.cn',
    'byteimg.com',
    'douyinpic.com',
  ],
  xiaohongshu: ['xhscdn.com', 'xiaohongshu.com'],
}
export function identify(content: string): Input | undefined {
  const urls = content.match(/https?:\/\/[^\s<>"'，。！？]+/gi) ?? []
  for (const raw of urls) {
    try {
      const url = new URL(raw.replace(/[)）\]】.,;；]+$/, ''))
      if (url.username || url.password || (url.port && !['80', '443'].includes(url.port))) continue
      for (const site of Object.keys(entryHosts) as Site[])
        if (hostMatches(url.hostname, entryHosts[site])) return { site, url: url.href }
    } catch {
      /* A malformed token is not a supported link. */
    }
  }
  const bv = /(?:^|\s)(BV[1-9a-zA-Z]{10})(?=$|\s)/.exec(content)?.[1]
  return bv ? { site: 'bilibili', url: `https://www.bilibili.com/video/${bv}` } : undefined
}
const str = (value: unknown, limit = 500) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, limit) : ''
export function biliStream(item: any) {
  const backups = item.backupUrl ?? item.backup_url ?? []
  for (const value of [
    item.baseUrl ?? item.base_url ?? item.url,
    ...(Array.isArray(backups) ? backups : []),
  ]) {
    if (typeof value !== 'string' || value.length > 16000) continue
    try {
      return checkedUrl(value, { hosts: mediaHosts.bilibili }).href
    } catch {
      /* Prefer a validated official CDN backup over unsupported PCDN hosts/ports. */
    }
  }
  throw new PublicError('B站未提供允许访问的官方 CDN 地址。')
}

/** Parse a JSON assignment without executing script; replace bare undefined only outside strings. */
export function stateJson(html: string, marker: string): any {
  const at = html.indexOf(marker)
  if (at < 0) throw new PublicError('页面未提供视频数据，可能需要有效 Cookie 或网页结构已变更。')
  const equal = html.indexOf('=', at + marker.length)
  if (equal < 0) throw new PublicError('页面数据格式无效。')
  let start = equal + 1
  while (/\s/.test(html[start] ?? '')) start++
  const first = html[start]
  if (!['{', '[', '"'].includes(first)) throw new PublicError('页面数据不是支持的 JSON 格式。')
  let depth = 0,
    quoted = false,
    escaped = false,
    output = ''
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (quoted) {
      output += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') {
        quoted = false
        if (first === '"') break
      }
      continue
    }
    if (c === '"') {
      quoted = true
      output += c
      continue
    }
    if (
      html.startsWith('undefined', i) &&
      !/[\w$]/.test(html[i - 1] ?? '') &&
      !/[\w$]/.test(html[i + 9] ?? '')
    ) {
      output += 'null'
      i += 8
      continue
    }
    output += c
    if (c === '{' || c === '[') depth++
    if (c === '}' || c === ']') {
      depth--
      if (!depth) break
    }
  }
  try {
    const data = JSON.parse(output)
    return typeof data === 'string' ? JSON.parse(data) : data
  } catch {
    throw new PublicError('视频页面数据格式已变化，无法安全解析。')
  }
}
function find(root: any, predicate: (v: any) => boolean) {
  const queue: any[] = [root]
  for (let i = 0; i < queue.length && i < 20000; i++) {
    const value = queue[i]
    if (!value || typeof value !== 'object') continue
    if (predicate(value)) return value
    if (queue.length < 20000)
      queue.push(
        ...Object.values(value)
          .filter((v) => v && typeof v === 'object')
          .slice(0, 1000),
      )
  }
}
export class VideoProviders {
  constructor(readonly config: ProviderConfig) {}
  options(hosts: string[], signal?: AbortSignal, headers?: Record<string, string>): RequestOptions {
    return { hosts, signal, timeout: this.config.timeout, proxy: this.config.proxy, headers }
  }
  async resolve(input: Input, part: number, signal?: AbortSignal): Promise<Video> {
    if (!Number.isSafeInteger(part) || part < 1) throw new PublicError('分 P 序号须为正整数。')
    if (input.site === 'bilibili') return this.bilibili(input, part, signal)
    if (part !== 1) throw new PublicError('此平台没有分 P，请使用第 1 项。')
    return input.site === 'douyin' ? this.douyin(input, signal) : this.xhs(input, signal)
  }
  async bilibili(input: Input, part: number, signal?: AbortSignal): Promise<Video> {
    let url = new URL(input.url)
    if (!hostMatches(url.hostname, ['bilibili.com']))
      url = new URL((await request(url.href, this.options(entryHosts.bilibili, signal))).url)
    const bvid = /\/video\/(BV[1-9a-zA-Z]{10})/.exec(url.pathname)?.[1]
    const aid = /\/video\/av(\d+)/.exec(url.pathname)?.[1]
    if (!bvid && !aid) throw new PublicError('此 B站链接不是普通视频；动态、文章、直播等内容暂不处理。')
    if (part === 1 && url.searchParams.has('p')) part = Number(url.searchParams.get('p'))
    const headers = { Referer: 'https://www.bilibili.com/', Cookie: this.config.biliCookie }
    const metadata = await json(
      `https://api.bilibili.com/x/web-interface/view?${bvid ? `bvid=${bvid}` : `aid=${aid}`}`,
      this.options(['api.bilibili.com'], signal, headers),
    )
    if (metadata.code !== 0 || !metadata.data)
      throw new PublicError(`B站视频不可访问（code=${Number(metadata.code) || '未知'}）。`)
    const data = metadata.data,
      pages = Array.isArray(data.pages) ? data.pages : []
    if (!Number.isSafeInteger(part) || part < 1 || part > pages.length)
      throw new PublicError(`分 P 超出范围，共 ${pages.length} P。`)
    const page = pages[part - 1]
    const play = await json(
      `https://api.bilibili.com/x/player/playurl?${new URLSearchParams({ bvid: data.bvid, cid: String(page.cid), qn: '80', fnval: '4048', fnver: '0', fourk: '0' })}`,
      this.options(['api.bilibili.com'], signal, headers),
    )
    if (play.code !== 0 || !play.data) throw new PublicError('B站没有提供播放地址，请检查视频权限和 Cookie。')
    const result: Video = {
      site: 'bilibili',
      id: str(data.bvid),
      title: str(data.title) + (pages.length > 1 ? ` · P${part} ${str(page.part)}` : ''),
      author: str(data.owner?.name),
      cover: str(data.pic, 2000),
      url: `https://www.bilibili.com/video/${data.bvid}?p=${part}`,
      seconds: Number(page.duration) || 0,
      part,
      parts: pages.length,
      height: 0,
      streams: [],
      mode: 'direct',
    }
    const dash = play.data.dash
    if (dash && Array.isArray(dash.video) && Array.isArray(dash.audio)) {
      const audio = [...dash.audio].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0))[0]
      const candidates = dash.video
        .filter(
          (v: any) =>
            Math.min(Number(v.width) || Infinity, Number(v.height)) <= this.config.maxHeight &&
            /^avc/i.test(v.codecs ?? ''),
        )
        .sort((a: any, b: any) => b.height - a.height)
      const video = candidates.find(
        (v: any) =>
          !result.seconds ||
          (((Number(v.bandwidth) || 0) + (Number(audio?.bandwidth) || 0)) * result.seconds) / 8 <
            this.config.maxVideoMB * 1024 * 1024 * 0.9,
      )
      if (!video || !audio)
        throw new PublicError('没有满足清晰度/大小限制的可播放视频；请调整限制或使用原链接。')
      result.streams = [biliStream(video), biliStream(audio)]
      result.height = Number(video.height)
      result.mode = 'dash'
    } else if (Array.isArray(play.data.durl) && play.data.durl.length) {
      result.streams = play.data.durl.map(biliStream)
      result.mode = result.streams.length > 1 ? 'concat' : 'direct'
      if (
        play.data.durl.reduce((n: number, v: any) => n + (Number(v.size) || 0), 0) >
        this.config.maxVideoMB * 1024 * 1024
      )
        throw new PublicError('此视频超过大小限制。')
    }
    if (!result.streams.length || result.streams.some((v) => !v))
      throw new PublicError('B站播放数据缺少媒体地址。')
    return result
  }
  async douyin(input: Input, signal?: AbortSignal): Promise<Video> {
    let url = new URL(input.url)
    if (url.hostname === 'v.douyin.com')
      url = new URL((await request(url.href, this.options(entryHosts.douyin, signal))).url)
    const id = /\/(?:video|note)\/(\d+)/.exec(url.pathname)?.[1] || url.searchParams.get('modal_id')
    if (!id || !/^\d+$/.test(id)) throw new PublicError('此抖音链接不是可识别的视频；直播等内容暂不处理。')
    const canonical = `https://www.iesdouyin.com/share/video/${id}/`
    const page = await request(
      canonical,
      this.options(entryHosts.douyin, signal, {
        Referer: 'https://www.douyin.com/',
        Cookie: this.config.douyinCookie,
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      }),
    )
    const html = page.body.toString('utf8')
    let state: any
    if (html.includes('window._ROUTER_DATA')) state = stateJson(html, 'window._ROUTER_DATA')
    else {
      const raw = /<script[^>]*id=["']RENDER_DATA["'][^>]*>([^<]+)<\/script>/i.exec(html)?.[1]
      try {
        state = raw && JSON.parse(decodeURIComponent(raw))
      } catch {
        /* Report a typed failure below. */
      }
    }
    const aweme = find(state, (v) => String(v.aweme_id ?? v.awemeId ?? '') === id && (v.video || v.images))
    if (!aweme) throw new PublicError('抖音页面未提供此视频，请检查 Cookie、访问验证或链接是否失效。')
    if (aweme.images?.length) throw new PublicError('此抖音内容为图集，首版仅处理视频。')
    const video = aweme.video,
      address = video?.play_addr ?? video?.playAddr
    const stream =
      address?.url_list?.[0] ??
      address?.urlList?.[0] ??
      (address?.uri
        ? `https://www.iesdouyin.com/aweme/v1/play/?video_id=${encodeURIComponent(address.uri)}&ratio=720p&line=0`
        : '')
    if (!stream) throw new PublicError('抖音未提供可用视频地址。')
    return {
      site: 'douyin',
      id,
      title: str(aweme.desc || '抖音视频'),
      author: str(aweme.author?.nickname),
      url: `https://www.douyin.com/video/${id}`,
      cover: str(video.cover?.url_list?.[0] ?? video.cover?.urlList?.[0], 2000),
      seconds: Number(video.duration ?? aweme.duration) / 1000 || 0,
      part: 1,
      parts: 1,
      height: Number(video.height) || 0,
      mode: 'direct',
      streams: [str(stream, 8000)],
    }
  }
  async xhs(input: Input, signal?: AbortSignal): Promise<Video> {
    let url = new URL(input.url)
    if (!hostMatches(url.hostname, ['xiaohongshu.com']))
      url = new URL((await request(url.href, this.options(entryHosts.xiaohongshu, signal))).url)
    const id = /\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/.exec(url.pathname)?.[1]
    if (!id) throw new PublicError('此小红书链接不是可识别的笔记页面。')
    const page = await request(
      url.href,
      this.options(entryHosts.xiaohongshu, signal, {
        Referer: 'https://www.xiaohongshu.com/',
        Cookie: this.config.xhsCookie,
      }),
    )
    const state = stateJson(page.body.toString('utf8'), 'window.__INITIAL_STATE__')
    const note = state.note?.noteDetailMap?.[id]?.note
    if (!note) throw new PublicError('小红书未提供此笔记，请检查分享链接参数和 Cookie。')
    if (note.type !== 'video') throw new PublicError('此小红书笔记为图文，首版仅处理视频。')
    const variants = Array.isArray(note.video?.media?.stream?.h264) ? note.video.media.stream.h264 : []
    const sorted = [...variants].sort(
      (a: any, b: any) => (Math.min(b.width, b.height) || 0) - (Math.min(a.width, a.height) || 0),
    )
    const selected =
      sorted.find((v: any) => Math.min(v.width, v.height) <= this.config.maxHeight) ?? sorted.at(-1)
    if (!selected?.masterUrl) throw new PublicError('小红书没有提供可用的 H.264 视频地址。')
    return {
      site: 'xiaohongshu',
      id,
      title: str(note.title || note.desc || '小红书视频'),
      author: str(note.user?.nickname),
      url: url.href,
      cover: str(note.imageList?.[0]?.urlDefault, 2000),
      seconds: Number(note.video?.media?.video?.duration) || 0,
      part: 1,
      parts: 1,
      height: Number(selected.height) || 0,
      mode: 'direct',
      streams: [str(selected.masterUrl, 8000)],
    }
  }
}
