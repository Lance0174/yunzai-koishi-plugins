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
import { Accounts } from './accounts'

export const name = 'yunzai-music-request'
export const usage =
  '点歌 晴天：默认直接发送搜索结果第一首。点歌 搜索 晴天：显示列表。可选择卡片或语音。私聊“点歌 登录 网易云”扫码登录，无需填写 Cookie。\n\n迁移来源：[xiaofei-plugin / xfdown 及贡献者](https://gitee.com/xfdown/xiaofei-plugin)、[rconsole-plugin / kyrzy0416 及贡献者](https://gitee.com/kyrzy0416/rconsole-plugin)。网易云扫码协议参考 NeteaseCloudMusicApi / Binaryify 及贡献者（MIT）。详见安装包 THIRD_PARTY_NOTICES.md。'
export interface Config extends ProviderConfig {
  command: string
  defaultPlatform: Platform
  pageSize: number
  sessionMinutes: number
  maxAudioMB: number
  maxConcurrent: number
  cooldown: number
  output: 'card' | 'voice'
  loginAdmins: string[]
}
export const Config: Schema<Config> = Schema.object({
  command: Schema.string().default('点歌'),
  defaultPlatform: Schema.union(['netease', 'qq', 'kugou', 'kuwo']).default('netease'),
  output: Schema.union(['card', 'voice'])
    .default('card')
    .description('点歌默认发送搜索结果第一首；选择音乐卡片或语音。'),
  loginAdmins: Schema.array(String)
    .default([])
    .description('允许私聊扫码管理音乐账号的用户；Koishi 权限等级 4 及以上也可操作。'),
  pageSize: Schema.number().min(1).max(10).step(1).default(5),
  sessionMinutes: Schema.number().min(1).max(60).default(10),
  timeout: Schema.number().min(1000).max(60000).default(20000),
  proxy: Schema.string().role('secret').default('').description('可选 HTTP 代理地址。'),
  neteaseApi: Schema.string()
    .default('')
    .description('可选网易云 API 服务地址（支持 /search、/song/url/v1、/lyric）。'),
  kugouApi: Schema.string().default('').description('可选酷狗 API 服务地址（支持 /search、/song/url）。'),
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
  selecting: boolean
}
export function apply(ctx: Context, config: Config) {
  if (!/^[\p{L}\p{N}_-]{1,30}$/u.test(config.command))
    throw new PublicError('指令名只能包含文字、数字、下划线或连字符。')
  const accounts = new Accounts(ctx, config, new Providers(config))
  const providerFor = (s: Session) => new Providers(config, (source) => accounts.cookie(s, source))
  const states = new Map<string, State>(),
    jobs = new Map<string, AbortController>(),
    last = new Map<string, number>()
  let counter = 0,
    disposed = false
  // Koishi stops looking for children when a parent declares arguments.
  const root = ctx
    .command(config.command, '四平台点歌', { authority: 0, checkArgCount: false })
    .option('platform', '-p <platform:string>')
    .option('list', '-l, --列表')
    .option('card', '--卡片')
    .option('voice', '--语音')
    .option('quality', '-q <quality:string>')
  accounts.install(root)
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
    result.selecting = true
    return h.text(
      `第 ${next}/${max} 页\n${result.tracks
        .slice((next - 1) * config.pageSize, next * config.pageSize)
        .map(
          (t, i) =>
            `${(next - 1) * config.pageSize + i + 1}. ${t.title} — ${t.artist} [${titles[t.platform]}]`,
        )
        .join('\n')}\n${config.command} 播放 <序号> / 卡片 <序号> / 语音 <序号> / 下一页，或直接回复序号`,
    )
  }
  async function playTrack(
    s: Session,
    track: Track,
    output: 'card' | 'voice',
    level: string | undefined,
    signal: AbortSignal,
  ) {
    const provider = providerFor(s)
    if (
      output === 'card' &&
      s.platform === 'onebot' &&
      (track.platform === 'netease' || (track.platform === 'qq' && track.shareId))
    ) {
      await send(
        s,
        h('onebot:music', {
          type: track.platform === 'netease' ? '163' : 'qq',
          id: track.shareId || track.id,
        }),
        signal,
      )
      return
    }
    const play = await provider.resolve(track, quality(level), signal)
    if (signal.aborted || disposed) throw new PublicError('音乐任务已取消。')
    if (output === 'card') {
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
    await send(s, h.text(`${title}\n${track.link}`), signal)
    if (signal.aborted || disposed) throw new PublicError('音乐任务已取消。')
    await send(s, h.audio(response.body, play.mime), signal)
  }
  async function search(
    s: Session,
    keyword: string,
    name?: string,
    listOnly = false,
    output = config.output,
    level?: string,
  ) {
    return job(s, async (signal) => {
      const id = sessionKey(s),
        generation = ++counter
      states.delete(id)
      const tracks = await providerFor(s).search(
        platform(name ?? config.defaultPlatform),
        keyword,
        config.pageSize * 4,
        signal,
      )
      if (signal.aborted || disposed) throw new PublicError('点歌任务已取消。')
      if (!tracks.length) return '没有搜索到歌曲；请更换关键词或平台。'
      if (states.size >= 500) states.delete(states.keys().next().value!)
      states.set(id, {
        tracks,
        page: 1,
        expires: Date.now() + config.sessionMinutes * 60_000,
        generation,
        selecting: false,
      })
      return listOnly ? page(s) : playTrack(s, tracks[0], output, level, signal)
    })
  }
  root.action(({ session, options, args }) => {
    const keyword = (args ?? []).join(' ')
    if (options?.card && options?.voice) return '请选择音乐卡片或语音中的一种。'
    return keyword
      ? search(
          session!,
          keyword,
          options?.platform,
          options?.list,
          options?.voice ? 'voice' : options?.card ? 'card' : config.output,
          options?.quality,
        )
      : h.text(
          `${config.command} <关键词> -p 网易云/QQ/酷狗/酷我\n默认直接发送第一首；加 --列表 或使用 搜索 可选歌。也可使用：${config.command} 卡片 1 / 语音 1 / 歌词 1 / 下一页 / 取消`,
        )
  })
  command('搜索 <keyword:text>', '搜索歌曲')
    .option('platform', '-p <platform:string>')
    .action(({ session, options }, keyword) => search(session!, keyword, options?.platform, true))
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
  for (const mode of ['播放', '卡片', '语音'] as const)
    command(`${mode} <index:posint>`, '发送音乐卡片或语音')
      .option('quality', '-q <quality:string>')
      .option('card', '--卡片')
      .option('voice', '--语音')
      .action(({ session, options }, index) =>
        job(session!, async (signal) => {
          if (options?.card && options?.voice) throw new PublicError('请选择音乐卡片或语音中的一种。')
          const output = options?.card
            ? 'card'
            : options?.voice
              ? 'voice'
              : mode === '卡片'
                ? 'card'
                : mode === '语音'
                  ? 'voice'
                  : config.output
          const s = session!,
            track = selected(s, index)
          return playTrack(s, track, output, options?.quality, signal)
        }),
      )
  command('歌词 <index:posint>', '查看歌曲歌词').action(({ session }, index) =>
    job(session!, async (signal) => {
      const track = selected(session!, index)
      return h.text(`${track.title} — ${track.artist}\n${await providerFor(session!).lyrics(track, signal)}`)
    }),
  )
  command('取消', '取消当前音乐任务').action(({ session }) => {
    const control = jobs.get(sessionKey(session!))
    control?.abort()
    return control ? '已请求取消当前音乐任务。' : '当前没有音乐任务。'
  })
  ctx.middleware(async (session, next) => {
    const token = session.content?.trim() ?? ''
    if (!/^\d{1,2}$/.test(token) || session.userId === session.selfId) return next()
    const current = states.get(sessionKey(session))
    if (!current?.selecting || current.expires <= Date.now() || !current.tracks[Number(token) - 1])
      return next()
    return session.execute(`${config.command}.播放 ${Number(token)}`)
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
