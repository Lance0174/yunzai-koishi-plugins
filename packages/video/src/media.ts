import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { PublicError, request, mediaKind } from './net'
import { VideoProviders, Video, mediaHosts } from './providers'

async function tool(
  executable: string,
  args: string[],
  signal: AbortSignal,
  cwd: string,
  limit?: { file: string; bytes: number },
): Promise<Buffer> {
  if (signal.aborted) throw new PublicError('视频任务已取消。')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let exceeded = false
    const monitor =
      limit &&
      setInterval(() => {
        void fs
          .stat(limit.file)
          .then((stat) => {
            if (stat.size > limit.bytes && !exceeded) {
              exceeded = true
              child.kill('SIGTERM')
              killTimer = setTimeout(() => child.kill('SIGKILL'), 1500)
            }
          })
          .catch(() => {})
      }, 100)
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on('data', (data: Buffer) => {
      size += data.length
      if (size <= 1024 * 1024) chunks.push(data)
      else child.kill()
    })
    child.stderr?.resume()
    const abort = () => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const cleanup = () => {
      clearTimeout(killTimer)
      if (monitor) clearInterval(monitor)
      signal.removeEventListener('abort', abort)
    }
    child.once('error', () => {
      cleanup()
      reject(new PublicError('无法启动 ffmpeg/ffprobe，请在服务器安装并配置可执行文件路径。'))
    })
    child.once('close', (code) => {
      cleanup()
      if (code === 0 && !signal.aborted && !exceeded && size <= 1024 * 1024) resolve(Buffer.concat(chunks))
      else
        reject(
          new PublicError(
            exceeded
              ? '视频输出超过大小限制。'
              : signal.aborted
                ? '视频任务已取消或超时。'
                : '媒体处理失败，请检查格式和 ffmpeg/ffprobe 版本。',
          ),
        )
    })
  })
}
export async function ffmpeg(
  executable: string,
  args: string[],
  signal: AbortSignal,
  cwd: string,
  limit?: { file: string; bytes: number },
): Promise<void> {
  await tool(
    executable,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args],
    signal,
    cwd,
    limit,
  )
}
export interface Probe {
  seconds: number
  width: number
  height: number
  video: string
  audio: string
  format: string
}
export async function probe(executable: string, file: string, signal: AbortSignal): Promise<Probe> {
  const bytes = await tool(
    executable,
    ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file],
    signal,
    path.dirname(file),
  )
  let data: any
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new PublicError('ffprobe 未返回有效媒体信息。')
  }
  const streams = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic),
    audio = streams.find((s: any) => s.codec_type === 'audio')
  const seconds = Number(video?.duration ?? data.format?.duration ?? audio?.duration)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new PublicError('媒体时长无效或内容不完整。')
  return {
    seconds,
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    video: video?.codec_name ?? '',
    audio: audio?.codec_name ?? '',
    format: data.format?.format_name ?? '',
  }
}
export interface MediaConfig {
  maxVideoMB: number
  cacheMB: number
  cacheMinutes: number
  ffmpeg: string
  ffprobe: string
  maxHeight: 360 | 480 | 720 | 1080
}
export async function checkTools(config: Pick<MediaConfig, 'ffmpeg' | 'ffprobe'>, timeout = 5000) {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), timeout)
  try {
    const results = await Promise.allSettled(
      (['ffmpeg', 'ffprobe'] as const).map(async (name) => {
        const output = (await tool(config[name], ['-version'], control.signal, process.cwd())).toString()
        if (!output.startsWith(`${name} version `)) throw new Error('Unexpected executable')
        return output.split(/\r?\n/)[0].slice(0, 180)
      }),
    )
    const missing = results.flatMap((result, i) =>
      result.status === 'rejected' ? [i ? 'ffprobe' : 'ffmpeg'] : [],
    )
    if (missing.length)
      throw new PublicError(
        `视频依赖未就绪：${missing.join('、')}。请在 Koishi 所在容器内安装 ffmpeg（同时包含 ffprobe）：Alpine 使用 apk add --no-cache ffmpeg；Debian/Ubuntu 使用 apt-get update && apt-get install -y ffmpeg。安装后发送“视频解析 诊断”重新检查。`,
      )
    return results.map((result) => (result as PromiseFulfilledResult<string>).value)
  } finally {
    clearTimeout(timer)
  }
}
export class Media {
  readonly root: string
  private cleaning?: Promise<void>
  constructor(
    baseDir: string,
    readonly provider: VideoProviders,
    readonly config: MediaConfig,
  ) {
    this.root = path.resolve(baseDir, 'data/yunzai-video-parser')
  }
  private own(file: string) {
    const value = path.resolve(file)
    if (path.dirname(value) !== this.root) throw new PublicError('缓存路径超出插件目录。')
    return value
  }
  async clean() {
    if (this.cleaning) return this.cleaning
    this.cleaning = this.cleanFiles().finally(() => {
      this.cleaning = undefined
    })
    return this.cleaning
  }
  private async cleanFiles() {
    await fs.mkdir(this.root, { recursive: true })
    const files = []
    for (const name of await fs.readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.mp4$/.test(name)) continue
      const file = this.own(path.join(this.root, name)),
        stat = await fs.lstat(file).catch(() => undefined)
      if (!stat) continue
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      files.push({ file, size: stat.size, time: stat.mtimeMs })
    }
    files.sort((a, b) => a.time - b.time)
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const file of files)
      if (
        total > this.config.cacheMB * 1024 * 1024 ||
        Date.now() - file.time > this.config.cacheMinutes * 60_000
      ) {
        await fs.rm(file.file, { force: true })
        total -= file.size
      }
  }
  async prepare(video: Video, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) throw new PublicError('视频任务已取消。')
    await fs.mkdir(this.root, { recursive: true })
    const bytes = this.config.maxVideoMB * 1024 * 1024
    const account = createHash('sha256')
      .update(
        JSON.stringify([
          this.provider.config.biliCookie,
          this.provider.config.douyinCookie,
          this.provider.config.xhsCookie,
        ]),
      )
      .digest('hex')
    const hash = createHash('sha256')
      .update(
        JSON.stringify([2, video.site, video.id, video.part, video.height, this.config.maxHeight, account]),
      )
      .digest('hex')
    const cached = this.own(path.join(this.root, `${hash}.mp4`))
    try {
      const stat = await fs.lstat(cached)
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size <= bytes &&
        Date.now() - stat.mtimeMs < this.config.cacheMinutes * 60000
      ) {
        const data = await fs.readFile(cached)
        if (signal.aborted) throw new PublicError('视频任务已取消。')
        if (mediaKind(data) === 'video') return data
      }
    } catch {
      /* A missing/expired cache is a normal miss. */
    }
    const disk = await fs.statfs(this.root)
    if (disk.bavail * disk.bsize < bytes * 4) throw new PublicError('服务器可用磁盘空间不足，已停止下载。')
    const folder = this.own(await fs.mkdtemp(path.join(this.root, 'job-')))
    try {
      let downloaded = 0
      const streams: string[] = []
      for (let i = 0; i < video.streams.length; i++) {
        const headers = {
          Referer:
            video.site === 'bilibili'
              ? 'https://www.bilibili.com/'
              : video.site === 'douyin'
                ? 'https://www.douyin.com/'
                : 'https://www.xiaohongshu.com/',
        }
        const response = await request(video.streams[i], {
          ...this.provider.options(mediaHosts[video.site], signal, headers),
          maxBytes: bytes - downloaded,
        })
        const kind = mediaKind(response.body)
        if (!kind || !['audio', 'video'].includes(kind))
          throw new PublicError('媒体地址返回了非视频内容，无法播放。')
        downloaded += response.body.length
        const file = path.join(folder, `part-${i}.mp4`)
        await fs.writeFile(file, response.body)
        streams.push(file)
      }
      if (signal.aborted) throw new PublicError('视频任务已取消。')
      const info = await probe(this.config.ffprobe, streams[0], signal)
      if (!info.video) throw new PublicError('媒体文件没有视频画面。')
      let expected = info.seconds
      if (video.mode === 'concat')
        for (const file of streams.slice(1))
          expected += (await probe(this.config.ffprobe, file, signal)).seconds
      const output = path.join(folder, 'output.mp4')
      const args: string[] = []
      if (video.mode === 'dash') {
        for (const file of streams) args.push('-protocol_whitelist', 'file,pipe', '-i', file)
        args.push('-map', '0:v:0', '-map', '1:a:0')
      } else if (video.mode === 'concat') {
        await fs.writeFile(
          path.join(folder, 'concat.txt'),
          streams.map((_, i) => `file 'part-${i}.mp4'`).join('\n'),
        )
        args.push(
          '-protocol_whitelist',
          'file,pipe',
          '-f',
          'concat',
          '-safe',
          '1',
          '-i',
          path.join(folder, 'concat.txt'),
        )
      } else
        args.push('-protocol_whitelist', 'file,pipe', '-i', streams[0], '-map', '0:v:0', '-map', '0:a:0?')
      const scale = Math.min(info.width, info.height) > this.config.maxHeight
      const encode = info.video !== 'h264' || scale || video.mode === 'concat'
      args.push('-c:v', encode ? 'libx264' : 'copy')
      if (encode) args.push('-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p', '-threads', '2')
      if (scale) {
        const ratio = this.config.maxHeight / Math.min(info.width, info.height)
        args.push(
          '-vf',
          `scale=${Math.floor((info.width * ratio) / 2) * 2}:${Math.floor((info.height * ratio) / 2) * 2}`,
        )
      }
      args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output)
      await ffmpeg(this.config.ffmpeg, args, signal, folder, { file: output, bytes })
      const actual = await probe(this.config.ffprobe, output, signal)
      if (
        actual.video !== 'h264' ||
        !actual.format.includes('mp4') ||
        (video.mode === 'dash' && !actual.audio)
      )
        throw new PublicError('视频输出格式或音轨不完整。')
      if (Math.min(actual.width, actual.height) > this.config.maxHeight)
        throw new PublicError('输出分辨率超过设置限制。')
      expected = Math.max(expected, video.seconds || 0)
      if (actual.seconds + Math.max(2, expected * 0.05) < expected)
        throw new PublicError('视频时长异常，文件可能不完整，未发送截断内容。')
      const stat = await fs.stat(output)
      if (stat.size > bytes || stat.size < 12) throw new PublicError('视频输出为空或超过大小限制。')
      if (signal.aborted) throw new PublicError('视频任务已取消。')
      const data = await fs.readFile(output)
      if (mediaKind(data) !== 'video') throw new PublicError('输出不是可识别的视频文件。')
      if (this.config.cacheMinutes > 0 && stat.size <= this.config.cacheMB * 1024 * 1024) {
        try {
          // Rename a complete file atomically; a stale cache must be replaceable.
          const staging = path.join(folder, 'cache.mp4')
          await fs.writeFile(staging, data)
          await fs.rename(staging, cached)
          await this.clean()
        } catch {
          /* Cache failure must not discard a verified output. */
        }
      }
      return data
    } finally {
      if (!path.basename(folder).startsWith('job-')) throw new PublicError('任务清理路径无效。')
      await fs.rm(this.own(folder), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
}
