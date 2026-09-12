import { Context, Schema, Session, h } from 'koishi'
import { createHash } from 'node:crypto'
import { identify, VideoProviders, ProviderConfig, names, mediaHosts } from './providers'
import { PublicError, DeliveryError, request, mediaKind } from './net'
import { Queue } from './queue'
import { Media, MediaConfig } from './media'
import { MediaTools, ToolsConfig } from './tools'

export const name = 'yunzai-video-parser'
export const usage =
  '缺少 ffmpeg/ffprobe 时默认自动下载安装到插件数据目录，无需执行系统安装命令。可用“视频解析 诊断”查看进度或重试。直接发送 B站、抖音、小红书链接或分享卡片即可解析，默认合并转发说明、封面和视频。\n\n迁移来源：[rconsole-plugin / kyrzy0416 及 R-plugin 贡献者](https://gitee.com/kyrzy0416/rconsole-plugin)。媒体工具来源：FFmpeg、eugeneware/ffmpeg-static 及其贡献者。详见安装包 THIRD_PARTY_NOTICES.md。'
export interface Config extends ProviderConfig, MediaConfig, ToolsConfig {
  command: string
  autoParse: boolean
  groups: string[]
  concurrency: number
  queueSize: number
  jobTimeout: number
  cooldown: number
  showProgress: boolean
  forward: boolean
}
export const Config: Schema<Config> = Schema.object({
  command: Schema.string().default('视频解析'),
  autoParse: Schema.boolean().default(true).description('直接识别链接、BV 号和分享卡片，无需前缀。'),
  groups: Schema.array(String)
    .default([])
    .description('限定自动解析的群号；留空适用当前插件作用范围内的群和私聊。'),
  showProgress: Schema.boolean().default(false).description('显示任务编号和排队提示。默认直接发送解析结果。'),
  forward: Schema.boolean().default(true).description('默认将说明、封面和视频放入一条合并转发消息。'),
  biliCookie: Schema.string().role('secret').default(''),
  douyinCookie: Schema.string().role('secret').default(''),
  xhsCookie: Schema.string().role('secret').default(''),
  proxy: Schema.string().role('secret').default('').description('可选 HTTP 代理。'),
  timeout: Schema.number().min(1000).max(60000).default(25000).description('单次请求超时（毫秒）。'),
  maxHeight: Schema.union([360, 480, 720, 1080])
    .default(720)
    .description('视频短边像素上限；竖屏视频按宽度限制。'),
  maxVideoMB: Schema.number().min(1).max(100).default(40),
  cacheMB: Schema.number().min(0).max(2048).default(200),
  cacheMinutes: Schema.number().min(0).max(1440).default(30),
  ffmpeg: Schema.string().default('ffmpeg').description('ffmpeg 可执行文件路径。'),
  ffprobe: Schema.string().default('ffprobe').description('ffprobe 可执行文件路径，用于校验媒体。'),
  autoInstall: Schema.boolean()
    .default(true)
    .description('缺少媒体工具时自动下载到插件数据目录，无需管理员权限。'),
  toolDownloadTimeout: Schema.number()
    .min(30000)
    .max(1800000)
    .default(600000)
    .description('自动准备媒体工具的总超时（毫秒），不占视频处理时限。'),
  concurrency: Schema.number().min(1).max(3).step(1).default(1),
  queueSize: Schema.number().min(0).max(10).step(1).default(3),
  jobTimeout: Schema.number().min(10000).max(600000).default(180000).description('整个任务超时（毫秒）。'),
  cooldown: Schema.number().min(0).default(5000),
})
export const ownerKey = (s: Session) =>
  JSON.stringify([s.platform, s.selfId, s.guildId ?? '', s.channelId ?? '', s.userId ?? ''])
export function shareText(session: Pick<Session, 'content' | 'elements'>) {
  const elements = (session.elements ?? []).slice(0, 200)
  const values = elements.length
    ? elements.filter((e) => e.type === 'text').map((e) => String(e.attrs.content ?? '').slice(0, 65536))
    : [(session.content ?? '').slice(0, 65536)]
  for (const element of elements) {
    if (!['json', 'onebot:json'].includes(element.type)) continue
    const raw = element.attrs.data
    if (typeof raw !== 'string' || raw.length > 65536) continue
    try {
      const pending: unknown[] = [JSON.parse(raw)]
      for (let i = 0; i < pending.length && i < 2000; i++) {
        const value = pending[i]
        if (typeof value === 'string') values.push(value)
        else if (value && typeof value === 'object' && pending.length < 2000)
          pending.push(...Object.values(value).slice(0, 200))
      }
    } catch {
      /* Malformed cards are left for other plugins. */
    }
  }
  return values.join('\n').slice(0, 131072)
}
export async function deliver(s: Session, content: h.Fragment, timeout: number, signal: AbortSignal) {
  if (signal.aborted) throw new PublicError('视频任务已取消。')
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try {
    const ids = await Promise.race([
      s.send(content),
      new Promise<never>((_, reject) => {
        abort = () => reject(new DeliveryError('发送失败或结果未知，请先检查聊天窗口，勿重复提交。'))
        timer = setTimeout(abort, timeout)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
    if (!ids?.length) throw new Error('No delivery acknowledgement')
  } catch {
    throw new DeliveryError('发送失败或结果未知，请先检查聊天窗口，勿重复提交。')
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
  }
}
export function apply(ctx: Context, config: Config) {
  if (!/^[\p{L}\p{N}_-]{1,30}$/u.test(config.command))
    throw new PublicError('指令名只能包含文字、数字、下划线或连字符。')
  const provider = new VideoProviders(config),
    media = new Media(ctx.baseDir || process.cwd(), provider, { ...config })
  let disposed = false
  const logger = ctx.logger(name)
  const tools = new MediaTools(ctx.baseDir || process.cwd(), config, (message) => {
    if (!disposed) logger.info(message)
  })
  const queue = new Queue<void>(config.concurrency, config.queueSize, config.jobTimeout),
    last = new Map<string, number>()
  const canonicalJobs = new Set<string>()
  const ensureTools = async (signal?: AbortSignal, refresh = false) => {
    const result = await tools.ensure(signal, refresh)
    media.config.ffmpeg = result.ffmpeg
    media.config.ffprobe = result.ffprobe
    return result
  }
  ctx.on('ready', () => {
    void ensureTools().catch((e) => {
      if (!disposed) logger.warn(e instanceof Error ? e.message : '视频依赖检查失败。')
    })
  })
  const error = (e: unknown) => (e instanceof PublicError ? e.message : '视频处理失败，请稍后再试。')
  async function run(s: Session, content: string, preview: boolean, part: number, automatic = false) {
    if (disposed || !s.userId || !s.channelId) return '当前会话不可用。'
    const input = identify(content)
    if (!input) return '仅支持 B站、抖音、小红书的视频链接或 BV 号。'
    const owner = ownerKey(s)
    if (Date.now() - (last.get(owner) ?? 0) < config.cooldown)
      return automatic ? undefined : '操作过于频繁，请稍后再试。'
    let ticket, release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const key = createHash('sha256')
        .update(JSON.stringify([input.site, input.url, part, preview]))
        .digest('hex')
      ticket = queue.add(
        owner,
        key,
        async (signal) => {
          await ready
          if (signal.aborted || disposed) throw new PublicError('视频任务已取消。')
          const video = await provider.resolve(input, part, signal)
          const canonical = JSON.stringify([video.site, video.id, video.part, preview])
          if (canonicalJobs.has(canonical)) throw new PublicError('此视频已有任务正在处理，请稍后重试。')
          canonicalJobs.add(canonical)
          try {
            let cover: Buffer | undefined
            if (video.cover)
              try {
                const response = await request(video.cover, {
                  ...provider.options(mediaHosts[video.site], signal),
                  maxBytes: 2 * 1024 * 1024,
                })
                if (mediaKind(response.body) === 'image') cover = response.body
              } catch {
                /* A cover failure must not discard an otherwise usable video. */
              }
            if (signal.aborted || disposed) throw new PublicError('视频任务已取消。')
            const description = [
              h.text(
                `${names[video.site]} · ${video.title}\n${video.author}${video.seconds ? ` · ${Math.round(video.seconds)} 秒` : ''}\n${video.url}`,
              ),
              ...(cover ? [h.image(cover, 'image/jpeg')] : []),
            ]
            const bytes = preview ? undefined : await media.prepare(video, signal)
            if (signal.aborted || disposed) throw new PublicError('视频任务已取消。')
            if (config.forward && s.platform === 'onebot') {
              const nodes = [h('message', { userId: s.selfId, nickname: '视频解析' }, description)]
              if (bytes)
                nodes.push(
                  h('message', { userId: s.selfId, nickname: '视频解析' }, h.video(bytes, 'video/mp4')),
                )
              await deliver(s, h('message', { forward: true }, nodes), config.timeout, signal)
            } else {
              await deliver(s, description, config.timeout, signal)
              if (bytes) await deliver(s, h.video(bytes, 'video/mp4'), config.timeout, signal)
            }
          } finally {
            canonicalJobs.delete(canonical)
          }
        },
        preview ? undefined : (signal) => ensureTools(signal),
      )
      last.set(owner, Date.now())
      try {
        if (config.showProgress)
          await deliver(
            s,
            `视频任务 ${ticket.id} 已加入队列；可用“${config.command} 取消 ${ticket.id}”取消。`,
            config.timeout,
            ticket.control.signal,
          )
      } catch (e) {
        queue.cancel(ticket.id, owner)
        release()
        await ticket.done.catch(() => {})
        throw e
      }
      release()
      await ticket.done
      return
    } catch (e) {
      if (!disposed)
        return h.text(
          `${ticket && config.showProgress ? `任务 ${ticket.id}：` : ''}${error(e)}\n原链接：${input.url}`,
        )
    }
  }
  const root = ctx
    .command(config.command, '解析并发送三站视频', { authority: 0, checkArgCount: false })
    .option('part', '-p <part:posint>')
  root.subcommand('.诊断', '检查 ffmpeg 和 ffprobe 是否可运行', { authority: 0 }).action(async () => {
    if (tools.installing)
      return h.text(`${tools.status}\n正在自动准备媒体工具，就绪后排队中的视频会继续解析。`)
    try {
      // Run repair in the background so diagnostics remain responsive on slow networks.
      const result = ensureTools(undefined, true)
      void result.catch((e) => {
        if (!disposed) logger.warn(error(e))
      })
      const ready = await Promise.race([
        result,
        new Promise<undefined>((resolve) => setTimeout(resolve, 200)),
      ])
      return h.text(
        ready
          ? `视频依赖已就绪。\n${ready.versions.join('\n')}\n默认发送：${config.forward ? '合并转发' : '普通消息'}`
          : `${tools.status}\n自动准备中，可稍后再次发送“${config.command} 诊断”查看进度。`,
      )
    } catch (e) {
      return h.text(error(e))
    }
  })
  root.action(({ session, options, args }) => {
    const url = (args ?? []).join(' ')
    return url
      ? run(session!, url, false, options?.part ?? 1)
      : h.text(`${config.command} <链接或BV号> [-p 分P]\n${config.command} 预览 <链接> / 任务 / 取消 <编号>`)
  })
  root
    .subcommand('.预览 <url:text>', '只预览视频信息', { authority: 0 })
    .option('part', '-p <part:posint>')
    .action(({ session, options }, url) => run(session!, url, true, options?.part ?? 1))
  root.subcommand('.任务', '查看本会话的视频任务', { authority: 0 }).action(({ session }) => {
    const rows = [...queue.tickets.values()].filter((t) => t.owner === ownerKey(session!)).slice(-10)
    const states: Record<string, string> = {
      queued: '排队中',
      running: '处理中',
      completed: '平台已确认发送',
      failed: '失败',
      cancelled: '已取消/超时',
      uncertain: '发送结果待核实',
    }
    return h.text(
      rows.length
        ? rows.map((t) => `${t.id}：${states[t.state]}${t.error ? `（${t.error}）` : ''}`).join('\n')
        : '当前会话没有视频任务。',
    )
  })
  root
    .subcommand('.取消 <id:string>', '取消自己的视频任务', { authority: 0 })
    .action(({ session }, id) =>
      queue.cancel(id, ownerKey(session!)) ? '已请求取消任务。' : '任务已结束、无效或不属于当前会话。',
    )
  ctx.middleware(async (session, next) => {
    const content = shareText(session)
    if (
      !config.autoParse ||
      (config.groups.length > 0 && (!session.guildId || !config.groups.includes(session.guildId))) ||
      session.userId === session.selfId ||
      session.content?.trim().startsWith(config.command) ||
      !identify(content)
    )
      return next()
    const result = await run(session, content, false, 1, true)
    if (result) await session.send(result)
  })
  ctx.setInterval(() => {
    void media.clean().catch(() => {
      if (!disposed) logger.warn('视频缓存清理失败。')
    })
    const now = Date.now()
    for (const [id, time] of last) if (now - time > 60000) last.delete(id)
  }, 60000)
  ctx.on('dispose', async () => {
    disposed = true
    await tools.close()
    await queue.close()
    last.clear()
  })
}
