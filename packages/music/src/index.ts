import { Context, Schema, Session, h } from 'koishi'
import {
  Providers,
  ProviderConfig,
  Track,
  Platform,
  platform,
  quality,
  titles,
  mediaHosts,
} from './providers'
import { PublicError, request, mediaKind } from './net'

export const name = 'ember-music-request'
export const usage =
  '示例：点歌 晴天 -p 网易云；点歌 播放 1；点歌 歌词 1。API 和 Cookie 为可选账号配置，不同平台的访问条件可能不同。'
export interface Config extends ProviderConfig {
  command: string
  defaultPlatform: Platform
  pageSize: number
  sessionMinutes: number
  maxAudioMB: number
  maxConcurrent: number
  cooldown: number
}
export const Config: Schema<Config> = Schema.object({
  command: Schema.string().default('点歌'),
  defaultPlatform: Schema.union(['netease', 'qq', 'kugou', 'kuwo']).default('netease'),
  pageSize: Schema.number().min(1).max(10).step(1).default(5),
  sessionMinutes: Schema.number().min(1).max(60).default(10),
  timeout: Schema.number().min(1000).max(60000).default(20000),
  proxy: Schema.string().role('secret').default('').description('可选 HTTP 代理地址。'),
  qqCookie: Schema.string().role('secret').default('').description('可选 QQ音乐 Cookie。'),
  neteaseApi: Schema.string()
    .default('')
    .description('可选网易云 API 服务地址（支持 /search、/song/url/v1、/lyric）。'),
  neteaseCookie: Schema.string().role('secret').default(''),
  kugouApi: Schema.string().default('').description('可选酷狗 API 服务地址（支持 /search、/song/url）。'),
  kugouCookie: Schema.string().role('secret').default(''),
  maxAudioMB: Schema.number().min(1).max(100).default(25).description('单个音频的最大 MB。'),
  maxConcurrent: Schema.number().min(1).max(4).step(1).default(2),
  cooldown: Schema.number().min(0).default(1500).description('同一用户请求间隔（毫秒）。'),
})
export const sessionKey = (s: Pick<Session, 'platform' | 'selfId' | 'guildId' | 'channelId' | 'userId'>) =>
  JSON.stringify([s.platform, s.selfId, s.guildId ?? '', s.channelId ?? '', s.userId ?? ''])
interface State {
  tracks: Track[]
  page: number
  expires: number
  generation: number
}
export function apply(ctx: Context, config: Config) {
  if (!/^[\p{L}\p{N}_-]{1,30}$/u.test(config.command))
    throw new PublicError('指令名只能包含文字、数字、下划线或连字符。')
  const provider = new Providers(config),
    states = new Map<string, State>(),
    jobs = new Map<string, AbortController>(),
    last = new Map<string, number>()
  let counter = 0,
    disposed = false
  // Koishi stops looking for children when a parent declares arguments.
  const root = ctx
    .command(config.command, '四平台点歌', { authority: 0, checkArgCount: false })
    .option('platform', '-p <platform:string>')
  const command = <D extends string>(decl: D, description: string) =>
    root.subcommand(`.${decl}` as const, description, { authority: 0 })
  const error = (e: unknown) => (e instanceof PublicError ? e.message : '音源服务暂不可用，请稍后再试。')
  async function send(s: Session, content: h.Fragment, signal: AbortSignal) {
    if (signal.aborted || disposed) throw new PublicError('音乐任务已取消。')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const ids = await Promise.race([
        s.send(content),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Send timeout')), config.timeout)
        }),
      ])
      if (!ids?.length) throw new Error('No delivery acknowledgement')
    } catch {
      throw new PublicError('发送失败或结果未知，请先检查聊天窗口，勿重复提交。')
    } finally {
      clearTimeout(timer)
    }
  }
  async function job<T>(
    s: Session,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | string | undefined> {
    if (disposed || !s.userId || !s.channelId) return '当前会话不可用。'
    const id = sessionKey(s)
    if (jobs.has(id)) return `已有音乐任务在进行，可发送“${config.command} 取消”。`
    if (jobs.size >= config.maxConcurrent) return '音乐任务已满，请稍后再试。'
    if (Date.now() - (last.get(id) ?? 0) < config.cooldown) return '操作过于频繁，请稍后再试。'
    const control = new AbortController()
    jobs.set(id, control)
    last.set(id, Date.now())
    try {
      const result = await action(control.signal)
      if (disposed) return
      return control.signal.aborted ? '音乐任务已取消。' : result
    } catch (e) {
      if (!disposed) return error(e)
    } finally {
      if (jobs.get(id) === control) jobs.delete(id)
    }
  }
  function state(s: Session) {
    const result = states.get(sessionKey(s))
    if (!result || result.expires <= Date.now()) {
      states.delete(sessionKey(s))
      throw new PublicError('选曲会话已过期或不属于当前用户，请重新点歌。')
    }
    return result
  }
  function selected(s: Session, index: number) {
    const result = state(s),
      track = result.tracks[index - 1]
    if (!track || !Number.isInteger(index) || index < 1)
      throw new PublicError('歌曲序号超出当前搜索结果范围。')
    return track
  }
  function page(s: Session, value?: number) {
    const result = state(s),
      max = Math.ceil(result.tracks.length / config.pageSize)
    const next = value ?? result.page
    if (!Number.isInteger(next) || next < 1 || next > max) throw new PublicError('已经到达列表边界。')
    result.page = next
    return h.text(
      `第 ${next}/${max} 页\n${result.tracks
        .slice((next - 1) * config.pageSize, next * config.pageSize)
        .map(
          (t, i) =>
            `${(next - 1) * config.pageSize + i + 1}. ${t.title} — ${t.artist} [${titles[t.platform]}]`,
        )
        .join('\n')}\n${config.command} 播放 <序号> / 歌词 <序号> / 下一页`,
    )
  }
  async function search(s: Session, keyword: string, name?: string) {
    return job(s, async (signal) => {
      const id = sessionKey(s),
        generation = ++counter
      states.delete(id)
      const tracks = await provider.search(
        platform(name ?? config.defaultPlatform),
        keyword,
        config.pageSize * 4,
        signal,
      )
      if (signal.aborted || disposed) throw new PublicError('点歌任务已取消。')
      if (!tracks.length) return '没有搜索到歌曲；请更换关键词或平台。'
      if (states.size >= 500) states.delete(states.keys().next().value!)
      states.set(id, { tracks, page: 1, expires: Date.now() + config.sessionMinutes * 60_000, generation })
      return page(s)
    })
  }
  root.action(({ session, options, args }) => {
    const keyword = (args ?? []).join(' ')
    return keyword
      ? search(session!, keyword, options?.platform)
      : h.text(
          `${config.command} <关键词> -p 网易云/QQ/酷狗/酷我\n${config.command} 播放 1 / 歌词 1 / 下载 1 / 下一页 / 取消`,
        )
  })
  command('搜索 <keyword:text>', '搜索歌曲')
    .option('platform', '-p <platform:string>')
    .action(({ session, options }, keyword) => search(session!, keyword, options?.platform))
  command('列表 [page:posint]', '查看选曲列表').action(({ session }, index) => {
    try {
      return page(session!, index)
    } catch (e) {
      return error(e)
    }
  })
  for (const [label, delta] of [
    ['下一页', 1],
    ['上一页', -1],
  ] as const)
    command(label, '翻页').action(({ session }) => {
      try {
        return page(session!, state(session!).page + delta)
      } catch (e) {
        return error(e)
      }
    })
  for (const download of [false, true])
    command(download ? '下载 <index:posint>' : '播放 <index:posint>', '发送所选歌曲')
      .option('quality', '-q <quality:string>')
      .option('card', '--卡片')
      .action(({ session, options }, index) =>
        job(session!, async (signal) => {
          const s = session!,
            track = selected(s, index),
            play = await provider.resolve(track, quality(options?.quality), signal)
          if (signal.aborted || disposed) throw new PublicError('音乐任务已取消。')
          if (options?.card) {
            if (s.platform !== 'onebot') return h.text(`${track.title} — ${track.artist}\n${track.link}`)
            await send(
              s,
              h('onebot:music', {
                type: 'custom',
                url: track.link,
                audio: play.url,
                title: track.title,
                content: track.artist,
                image: track.cover,
              }),
              signal,
            )
            return
          }
          const response = await request(play.url, {
            ...provider.options(mediaHosts[track.platform], signal),
            maxBytes: config.maxAudioMB * 1024 * 1024,
          })
          if (!['audio', 'video'].includes(mediaKind(response.body) ?? ''))
            throw new PublicError('音源返回了非音频内容，可能需要重新登录或没有播放权限。')
          if (signal.aborted || disposed) throw new PublicError('音乐任务已取消。')
          const title = `${track.title} — ${track.artist}（${play.quality}）`
          const extension = play.mime === 'audio/flac' ? 'flac' : play.mime === 'audio/mp4' ? 'm4a' : 'mp3'
          await send(s, h.text(`${title}\n${track.link}`), signal)
          if (signal.aborted || disposed) throw new PublicError('音乐任务已取消。')
          const filename = `${track.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.${extension}`
          // OneBot's file encoder asks the protocol server to download this checked URL.
          // A data: URL is not a supported download_file input on all implementations.
          const output =
            download && s.platform === 'onebot'
              ? h('file', { src: response.url, title: filename })
              : download
                ? h.file(response.body, play.mime, { title: filename })
                : h.audio(response.body, play.mime)
          await send(s, output, signal)
        }),
      )
  command('歌词 <index:posint>', '查看歌曲歌词').action(({ session }, index) =>
    job(session!, async (signal) => {
      const track = selected(session!, index)
      return h.text(`${track.title} — ${track.artist}\n${await provider.lyrics(track, signal)}`)
    }),
  )
  command('取消', '取消当前音乐任务').action(({ session }) => {
    const control = jobs.get(sessionKey(session!))
    control?.abort()
    return control ? '已请求取消当前音乐任务。' : '当前没有音乐任务。'
  })
  ctx.setInterval(() => {
    const now = Date.now()
    for (const [id, s] of states) if (s.expires <= now) states.delete(id)
    for (const [id, time] of last) if (now - time > 60000 && !jobs.has(id)) last.delete(id)
  }, 60000)
  ctx.on('dispose', () => {
    disposed = true
    for (const control of jobs.values()) control.abort()
    states.clear()
    last.clear()
  })
}
