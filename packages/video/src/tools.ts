import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { setTimeout as pause } from 'node:timers/promises'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { checkTool, MediaConfig } from './media'
import { PublicError } from './net'

type ToolName = 'ffmpeg' | 'ffprobe'
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
// Fixed upstream binary release; no user-supplied URL or package manager is executed.
export const binaryRelease = 'b6.1.1'
const source = `https://github.com/eugeneware/ffmpeg-static/releases/download/${binaryRelease}`
const supported = new Set(['linux-x64', 'linux-arm64', 'win32-x64', 'darwin-x64', 'darwin-arm64'])
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
async function hashFile(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(
  value: string,
  file: string,
  proxy: string,
  signal: AbortSignal,
  progress: (bytes: number, total: number) => void,
  redirects = 0,
): Promise<void> {
  cancelled(signal)
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    redirects > 5 ||
    !(
      url.hostname === 'github.com' ||
      url.hostname.endsWith('.githubusercontent.com') ||
      url.hostname === 'github-production-release-asset-2e65be.s3.amazonaws.com'
    )
  )
    throw new PublicError('媒体工具下载地址不属于受信任的发布源。')
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined
  try {
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = https.request(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: 'GET',
          agent,
          signal,
          headers: {
            Host: url.host,
            'User-Agent': 'koishi-yunzai-video-parser',
            'Accept-Encoding': 'identity',
          },
        },
        resolve,
      )
      req.setTimeout(30000, () => req.destroy(new Error('媒体工具下载长时间无响应。')))
      req.once('error', reject)
      req.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      const location = new URL(response.headers.location, url).href
      response.destroy()
      return await download(location, file, proxy, signal, progress, redirects + 1)
    }
    if (response.statusCode !== 200) {
      response.destroy()
      throw new PublicError(`媒体工具下载失败（HTTP ${response.statusCode}）。`)
    }
    const total = Number(response.headers['content-length']) || 0
    if (total > maxBinaryBytes) {
      response.destroy()
      throw new PublicError('媒体工具下载文件超过大小限制。')
    }
    let received = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > maxBinaryBytes) return callback(new PublicError('媒体工具下载文件超过大小限制。'))
        progress(received, total)
        callback(null, chunk)
      },
    })
    let expanded = 0
    const expansionLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        expanded += chunk.length
        callback(expanded > maxBinaryBytes ? new PublicError('媒体工具解压文件超过大小限制。') : null, chunk)
      },
    })
    await pipeline(
      response,
      meter,
      createGunzip(),
      expansionLimit,
      createWriteStream(file, { flags: 'wx', mode: 0o600 }),
      { signal },
    )
    if (!received || (total && received !== total)) throw new PublicError('媒体工具下载不完整。')
  } finally {
    agent?.destroy()
  }
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
        this.status = `媒体工具自动准备失败：${detail} 下次解析会重试，也可发送“视频解析 诊断”重试。`
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
      if (!supported.has(this.platform))
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
  private async install(name: ToolName, signal: AbortSignal) {
    await fs.mkdir(this.root, { recursive: true })
    const disk = await fs.statfs(this.root)
    if (disk.bavail * disk.bsize < maxBinaryBytes * 2)
      throw new PublicError('安装媒体工具所需磁盘空间不足（需要至少 400MB 可用空间）。')
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
        this.update(`正在自动下载 ${name}（${this.platform}，第 ${attempt}/3 次）。`)
        let last = 0
        try {
          await download(url, file, proxy, signal, (bytes, total) => {
            if (Date.now() - last < 5000) return
            last = Date.now()
            this.update(
              `正在自动下载 ${name}：${total ? Math.floor((bytes / total) * 100) + '%' : Math.round(bytes / 1048576) + 'MB'}。`,
            )
          })
          break
        } catch (error) {
          await fs.rm(file, { force: true })
          cancelled(signal)
          if (attempt === 3) throw error
          const reason =
            error instanceof PublicError ? error.message : (error as NodeJS.ErrnoException).code || '网络中断'
          this.update(`${name} 下载未完成（${reason}），自动重试。`)
          try {
            await pause(attempt * 1000, undefined, { signal })
          } catch {
            cancelled(signal)
          }
        }
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
      if (!valid) throw new PublicError(`${name} 下载内容不是当前平台的可执行文件。`)
      await fs.chmod(file, 0o755)
      const version = await checkTool(name, file, signal)
      cancelled(signal)
      const info = {
        name,
        release: binaryRelease,
        source: url,
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
      // A second instance may have completed the same installation meanwhile.
      const existing = await this.cached(name, signal)
      if (existing) return existing
      await fs.rm(destination, { recursive: true, force: true })
      await fs.rename(temporary, destination)
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
