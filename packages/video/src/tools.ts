import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { setTimeout as pause } from 'node:timers/promises'
import { checkTool, MediaConfig } from './media'
import { PublicError } from './net'

import { binaryRelease, binarySource as source, binaryAsset, ToolName } from './tool-assets'
import { downloadArchive, clearArchive, DownloadError, hashFile } from './tool-download'

export { binaryRelease } from './tool-assets'
export interface ToolsConfig extends Pick<MediaConfig, ToolName> {
  autoInstall: boolean
  toolDownloadTimeout: number
  proxy: string
}
export interface ToolSet {
  ffmpeg: string
  ffprobe: string
  versions: string[]
}
const maxBinaryBytes = 200 * 1024 * 1024

function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw new PublicError('媒体工具安装已取消或超时。')
}
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new PublicError('视频任务已取消。'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PublicError('视频任务已取消。'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
// Serialize writers sharing a cache directory across plugin instances in this process.
const installs = new Map<string, Promise<void>>()
async function withInstallLock<T>(key: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  const previous = installs.get(key) || Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  installs.set(key, tail)
  try {
    await waitFor(previous, signal)
    cancelled(signal)
    return await action()
  } finally {
    // A cancelled waiter must not release the next writer before its predecessor.
    void previous.then(release)
    void tail.then(() => {
      if (installs.get(key) === tail) installs.delete(key)
    })
  }
}

async function extract(archive: string, file: string, signal: AbortSignal) {
  let expanded = 0
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      expanded += chunk.length
      callback(expanded > maxBinaryBytes ? new PublicError('媒体工具解压文件超过大小限制。') : null, chunk)
    },
  })
  await pipeline(
    createReadStream(archive),
    createGunzip(),
    limit,
    createWriteStream(file, { flags: 'wx', mode: 0o600 }),
    { signal },
  )
}

export class MediaTools {
  readonly platform = `${process.platform}-${process.arch}`
  readonly root: string
  status = '等待检查媒体工具。'
  private pending?: Promise<ToolSet>
  private ready?: ToolSet
  private control = new AbortController()
  private closed = false
  constructor(
    baseDir: string,
    readonly config: ToolsConfig,
    readonly report: (message: string) => void = () => {},
  ) {
    this.root = path.resolve(baseDir, 'data/yunzai-video-parser/tools', binaryRelease, this.platform)
  }
  get installing() {
    return !!this.pending
  }
  private update(message: string) {
    this.status = message
    this.report(message)
  }
  ensure(signal?: AbortSignal, refresh = false): Promise<ToolSet> {
    if (this.closed) return Promise.reject(new PublicError('插件正在停止。'))
    if (this.pending) return waitFor(this.pending, signal)
    if (refresh) this.ready = undefined
    if (this.ready) return waitFor(Promise.resolve(this.ready), signal)
    this.control = new AbortController()
    const timer = setTimeout(() => this.control.abort(), this.config.toolDownloadTimeout)
    this.pending = this.resolve(this.control.signal)
      .then((result) => {
        this.ready = result
        this.update('ffmpeg 和 ffprobe 已就绪。')
        return result
      })
      .catch((error) => {
        const detail = error instanceof PublicError ? error.message : '请检查网络代理和 data 目录写入权限。'
        this.status = `媒体工具自动准备失败：${detail} 已保留可续传的下载进度；下次解析会重试，也可发送“视频解析 诊断”重试。`
        throw new PublicError(this.status)
      })
      .finally(() => {
        clearTimeout(timer)
        this.pending = undefined
      })
    return waitFor(this.pending, signal)
  }
  private async resolve(signal: AbortSignal): Promise<ToolSet> {
    const tools = {} as Record<ToolName, string>
    const versions = [] as string[]
    for (const name of ['ffmpeg', 'ffprobe'] as const) {
      cancelled(signal)
      try {
        versions.push(await checkTool(name, this.config[name], signal))
        tools[name] = this.config[name]
        continue
      } catch {
        cancelled(signal)
      }
      const cached = await this.cached(name, signal)
      if (cached) {
        tools[name] = cached.file
        versions.push(cached.version)
        continue
      }
      if (!this.config.autoInstall)
        throw new PublicError(
          `视频依赖未就绪：${name}。已关闭自动安装，请启用 autoInstall 或配置有效的工具路径。`,
        )
      if (!binaryAsset(name, this.platform))
        throw new PublicError(`暂不支持 ${this.platform} 自动安装，请配置本机 ffmpeg/ffprobe 路径。`)
      const installed = await this.install(name, signal)
      tools[name] = installed.file
      versions.push(installed.version)
    }
    return { ...tools, versions }
  }
  private toolFile(directory: string, name: ToolName) {
    return path.join(directory, name + (process.platform === 'win32' ? '.exe' : ''))
  }
  private async cached(name: ToolName, signal: AbortSignal) {
    const directory = path.join(this.root, name),
      file = this.toolFile(directory, name)
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBinaryBytes) return
      const info = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'))
      if (info.bytes !== stat.size || info.sha256 !== (await hashFile(file))) return
      return { file, version: await checkTool(name, file, signal) }
    } catch {
      cancelled(signal)
    }
  }
  private install(name: ToolName, signal: AbortSignal) {
    return withInstallLock(path.join(this.root, name), signal, async () => {
      const existing = await this.cached(name, signal)
      return existing || this.installLocked(name, signal)
    })
  }
  private async installLocked(name: ToolName, signal: AbortSignal) {
    await fs.mkdir(this.root, { recursive: true })
    const disk = await fs.statfs(this.root)
    if (disk.bavail * disk.bsize < maxBinaryBytes * 2)
      throw new PublicError('安装媒体工具所需磁盘空间不足（需要至少 400MB 可用空间）。')
    const downloads = path.join(this.root, 'downloads')
    await fs.mkdir(downloads, { recursive: true })
    const archive = path.join(downloads, `${name}.gz.part`)
    const asset = binaryAsset(name, this.platform)!
    const temporary = await fs.mkdtemp(path.join(this.root, `.${name}-`))
    const file = this.toolFile(temporary, name),
      url = `${source}/${name}-${this.platform}.gz`
    try {
      const proxy =
        this.config.proxy ||
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        ''
      for (let attempt = 1; ; attempt++) {
        cancelled(signal)
        this.update(`正在自动下载 ${name}（${this.platform}，第 ${attempt}/6 次）。`)
        let last = 0
        try {
          await downloadArchive(
            attempt % 2
              ? url
              : `https://api.github.com/repos/eugeneware/ffmpeg-static/releases/assets/${asset.id}`,
            archive,
            asset,
            proxy,
            signal,
            (bytes, total) => {
              if (Date.now() - last < 5000) return
              last = Date.now()
              this.update(
                `正在自动下载 ${name}：${total ? Math.floor((bytes / total) * 100) + '%' : Math.round(bytes / 1048576) + 'MB'}。`,
              )
            },
          )
          break
        } catch (error) {
          cancelled(signal)
          if (attempt === 6 || (error instanceof DownloadError && !error.retryable)) throw error
          const reason =
            error instanceof PublicError ? error.message : (error as NodeJS.ErrnoException).code || '网络中断'
          this.update(`${name} 下载未完成（${reason}），保留可续传进度并切换官方入口重试。`)
          try {
            await pause(Math.min(8000, 1000 * 2 ** (attempt - 1)), undefined, { signal })
          } catch {
            cancelled(signal)
          }
        }
      }
      this.update(`${name} 下载已通过 SHA256 校验，正在解压。`)
      try {
        await extract(archive, file, signal)
      } catch (error) {
        if (['Z_DATA_ERROR', 'Z_BUF_ERROR'].includes((error as NodeJS.ErrnoException).code || ''))
          await clearArchive(archive)
        throw error
      }
      const handle = await fs.open(file, 'r')
      const header = Buffer.alloc(4)
      try {
        await handle.read(header, 0, 4, 0)
      } finally {
        await handle.close()
      }
      const valid =
        process.platform === 'win32'
          ? header.subarray(0, 2).toString() === 'MZ'
          : process.platform === 'linux'
            ? header.toString('hex') === '7f454c46'
            : ['cffaedfe', 'feedfacf', 'cafebabe'].includes(header.toString('hex'))
      if (!valid) {
        await clearArchive(archive)
        throw new PublicError(`${name} 下载内容不是当前平台的可执行文件。`)
      }
      await fs.chmod(file, 0o755)
      const version = await checkTool(name, file, signal)
      cancelled(signal)
      const info = {
        name,
        release: binaryRelease,
        source: url,
        archiveSha256: asset.sha256,
        version,
        bytes: (await fs.stat(file)).size,
        sha256: await hashFile(file),
      }
      await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(info, null, 2) + '\n')
      await fs.copyFile(
        path.join(__dirname, '../licenses/FFmpeg-LICENSE.txt'),
        path.join(temporary, 'LICENSE.txt'),
      )
      await fs.writeFile(
        path.join(temporary, 'SOURCE.txt'),
        `FFmpeg: https://ffmpeg.org/\nBinaries: ${source}\nBuild/source information: https://github.com/eugeneware/ffmpeg-static\nThis executable retains its own upstream license.\n`,
      )
      const destination = path.join(this.root, name)
      await fs.rm(destination, { recursive: true, force: true })
      await fs.rename(temporary, destination)
      await clearArchive(archive)
      this.update(`${name} 已自动安装并通过版本检查。`)
      return { file: this.toolFile(destination, name), version }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
  async close() {
    this.closed = true
    this.control.abort()
    await this.pending?.catch(() => {})
  }
}
