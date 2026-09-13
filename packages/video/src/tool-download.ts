import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { BinaryAsset } from './tool-assets'
import { PublicError } from './net'

type Validator = { header: 'etag' | 'last-modified'; value: string }
interface PartialInfo {
  sha256: string
  bytes: number
  validator?: Validator
}
export class DownloadError extends PublicError {
  constructor(
    message: string,
    readonly discard = false,
    readonly retryable = true,
  ) {
    super(message)
  }
}
export async function hashFile(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function clearArchive(file: string) {
  await fs.rm(file, { force: true })
  await fs.rm(file + '.json', { force: true })
}
function validator(response: IncomingMessage): Validator | undefined {
  const etag = response.headers.etag
  if (etag && /^"[^"\r\n]+"$/.test(etag)) return { header: 'etag', value: etag }
  const modified = response.headers['last-modified']
  if (modified && Number.isFinite(Date.parse(modified))) return { header: 'last-modified', value: modified }
}
async function partial(file: string, asset: BinaryAsset) {
  try {
    const stat = await fs.lstat(file)
    if (stat.isFile() && stat.size === asset.bytes && (await hashFile(file)) === asset.sha256)
      return { offset: stat.size }
    const info: PartialInfo = JSON.parse(await fs.readFile(file + '.json', 'utf8'))
    const valid = info.validator
    if (
      stat.isFile() &&
      stat.size > 0 &&
      stat.size < asset.bytes &&
      info.sha256 === asset.sha256 &&
      info.bytes === asset.bytes &&
      valid &&
      ((valid.header === 'etag' && /^"[^"\r\n]+"$/.test(valid.value)) ||
        (valid.header === 'last-modified' &&
          !/[\r\n]/.test(valid.value) &&
          Number.isFinite(Date.parse(valid.value))))
    )
      return { offset: stat.size, validator: valid }
  } catch (error) {
    if (!['ENOENT', undefined].includes((error as NodeJS.ErrnoException).code)) throw error
  }
  await clearArchive(file)
  return { offset: 0 }
}

async function request(
  value: string,
  headers: Record<string, string>,
  proxy: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ response: IncomingMessage; close: () => void }> {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    redirects > 5 ||
    !(
      url.hostname === 'github.com' ||
      url.hostname === 'api.github.com' ||
      url.hostname.endsWith('.githubusercontent.com') ||
      url.hostname === 'github-production-release-asset-2e65be.s3.amazonaws.com'
    )
  )
    throw new DownloadError('媒体工具下载地址不属于受信任的发布源。', false, false)
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
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
            Accept: 'application/octet-stream',
            'Accept-Encoding': 'identity',
            ...headers,
          },
        },
        (response) => {
          clearTimeout(headerTimer)
          // An interrupted response may emit an error while metadata is being persisted.
          response.on('error', () => {})
          resolve(response)
        },
      )
      // Also covers DNS, TLS and proxy negotiation, before a socket timeout can run.
      const headerTimer = setTimeout(() => req.destroy(new DownloadError('媒体工具下载连接超时。')), 30000)
      req.setTimeout(30000, () => req.destroy(new DownloadError('媒体工具下载长时间无响应。')))
      req.once('error', (error) => {
        clearTimeout(headerTimer)
        reject(error)
      })
      req.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      const location = new URL(response.headers.location, url).href
      response.destroy()
      agent?.destroy()
      return await request(location, headers, proxy, signal, redirects + 1)
    }
    return {
      response,
      close: () => {
        response.destroy()
        agent?.destroy()
      },
    }
  } catch (error) {
    agent?.destroy()
    throw error
  }
}

// Keep compressed bytes across transient errors and plugin restarts. Executables are
// only extracted by the caller after the pinned upstream SHA256 has been verified.
export async function downloadArchive(
  value: string,
  file: string,
  asset: BinaryAsset,
  proxy: string,
  signal: AbortSignal,
  progress: (bytes: number, total: number) => void,
): Promise<void> {
  let { offset, validator: previous } = await partial(file, asset)
  if (offset === asset.bytes) return
  const headers: Record<string, string> = {}
  if (offset && previous) {
    headers.Range = `bytes=${offset}-`
    headers['If-Range'] = previous.value
  }
  const { response, close } = await request(value, headers, proxy, signal)
  try {
    const code = response.statusCode
    if (code === 416) throw new DownloadError('下载源拒绝了续传范围，将重新下载。', true)
    if (code !== 200 && code !== 206) throw new DownloadError(`媒体工具下载失败（HTTP ${code}）。`)
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
      throw new DownloadError('媒体工具下载编码不正确。', true)
    let expected = asset.bytes
    if (code === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '')
      if (
        !offset ||
        !range ||
        Number(range[1]) !== offset ||
        Number(range[3]) !== asset.bytes ||
        Number(range[2]) < offset ||
        Number(range[2]) >= asset.bytes ||
        !previous ||
        response.headers[previous.header] !== previous.value
      )
        throw new DownloadError('下载源的续传范围或文件标识已变化，将重新下载。', true)
      expected = Number(range[2]) - offset + 1
    } else {
      // If-Range mismatch or a server ignoring Range: replace, never append a full response.
      offset = 0
    }
    const length = response.headers['content-length']
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== expected))
      throw new DownloadError('媒体工具下载大小与固定发布文件不一致。', true)
    const info: PartialInfo = { sha256: asset.sha256, bytes: asset.bytes, validator: validator(response) }
    if (!offset) await fs.writeFile(file, Buffer.alloc(0), { mode: 0o600 })
    await fs.writeFile(file + '.json', JSON.stringify(info), { mode: 0o600 })
    let received = 0
    progress(offset, asset.bytes)
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > expected) return callback(new DownloadError('媒体工具下载文件超过大小限制。', true))
        progress(offset + received, asset.bytes)
        callback(null, chunk)
      },
    })
    await pipeline(response, meter, createWriteStream(file, { flags: 'r+', start: offset }), { signal })
    if (received !== expected || (await fs.stat(file)).size !== asset.bytes)
      throw new DownloadError('媒体工具下载不完整，将保留进度继续下载。')
    if ((await hashFile(file)) !== asset.sha256)
      throw new DownloadError('媒体工具 SHA256 校验失败，将重新下载。', true)
  } catch (error) {
    if (error instanceof DownloadError && error.discard) await clearArchive(file)
    throw error
  } finally {
    close()
  }
}
