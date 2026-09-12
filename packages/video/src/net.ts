// Shared first-party transport. The video package carries its own identical copy.
import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'

export class PublicError extends Error {}
export class DeliveryError extends PublicError {}
export interface RequestOptions {
  hosts: readonly string[]
  headers?: Record<string, string>
  method?: 'GET' | 'POST'
  body?: string
  maxBytes?: number
  timeout?: number
  signal?: AbortSignal
  proxy?: string
  trustedOrigin?: string
  redirects?: number
}
export interface Reply {
  url: string
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}
export const hostMatches = (host: string, domains: readonly string[]) =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
export function isPublic(address: string) {
  try {
    let parsed = ipaddr.parse(address)
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
      parsed = (parsed as ipaddr.IPv6).toIPv4Address()
    return parsed.range() === 'unicast'
  } catch {
    return false
  }
}
export function checkedUrl(value: string, options: Pick<RequestOptions, 'hosts' | 'trustedOrigin'>) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PublicError('链接格式无效。')
  }
  const trusted = url.origin === options.trustedOrigin
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (!trusted && url.port && !['80', '443'].includes(url.port))
  )
    throw new PublicError('不支持此链接协议或端口。')
  if (!hostMatches(url.hostname, options.hosts)) throw new PublicError('链接不属于此平台允许的域名。')
  if (
    !trusted &&
    (url.hostname === 'localhost' ||
      (ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, '')) &&
        !isPublic(url.hostname.replace(/^\[|\]$/g, ''))))
  )
    throw new PublicError('禁止访问本地、内网或保留地址。')
  return url
}

export async function request(value: string, options: RequestOptions): Promise<Reply> {
  let url = checkedUrl(value, options),
    headers = { ...options.headers },
    method = options.method ?? 'GET',
    body = options.body
  const budget = options.maxBytes ?? 4 * 1024 * 1024
  if (!Number.isFinite(budget) || budget < 1) throw new PublicError('响应大小限制无效或已耗尽。')
  const controller = new AbortController()
  const parentAbort = () => controller.abort()
  options.signal?.addEventListener('abort', parentAbort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 15000)
  try {
    for (let redirects = 0; redirects <= (options.redirects ?? 5); redirects++) {
      if (controller.signal.aborted) throw new PublicError('请求已取消或超时。')
      const records = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        const abort = () => {
          controller.signal.removeEventListener('abort', abort)
          reject(new PublicError('请求已取消或超时。'))
        }
        controller.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted) {
          abort()
          return
        }
        lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true }).then(
          (records) => {
            controller.signal.removeEventListener('abort', abort)
            resolve(records)
          },
          (err) => {
            controller.signal.removeEventListener('abort', abort)
            reject(err)
          },
        )
      })
      if (
        !records.length ||
        (url.origin !== options.trustedOrigin && records.some((record) => !isPublic(record.address)))
      )
        throw new PublicError('域名解析到了本地、内网或保留地址。')
      if (controller.signal.aborted) throw new PublicError('请求已取消或超时。')
      const record = records.find((r) => r.family === 4) ?? records[0]
      const response = await new Promise<Reply>((resolve, reject) => {
        let agent: HttpsProxyAgent<string> | undefined
        try {
          if (options.proxy) agent = new HttpsProxyAgent(options.proxy)
        } catch {
          reject(new PublicError('代理地址无效。'))
          return
        }
        const client = url.protocol === 'https:' ? https : http
        const req = client.request(
          {
            protocol: url.protocol,
            hostname: record.address,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            servername: url.hostname,
            path: url.pathname + url.search,
            method,
            agent,
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0',
              'Accept-Encoding': 'identity',
              ...headers,
              Host: url.host,
              ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
            },
          },
          (res) => {
            const status = res.statusCode ?? 0
            if ([301, 302, 303, 307, 308].includes(status)) {
              res.destroy()
              resolve({ status, headers: res.headers, url: url.href, body: Buffer.alloc(0) })
              return
            }
            if (Number(res.headers['content-length']) > budget) {
              res.destroy()
              reject(new PublicError('响应文件超过大小限制。'))
              return
            }
            const chunks: Buffer[] = []
            let size = 0
            res.on('data', (chunk: Buffer) => {
              size += chunk.length
              if (size > budget) {
                res.destroy()
                reject(new PublicError('响应文件超过大小限制。'))
              } else chunks.push(chunk)
            })
            res.on('end', () =>
              resolve({ status, headers: res.headers, url: url.href, body: Buffer.concat(chunks) }),
            )
            res.on('error', () => reject(new PublicError('媒体响应中断。')))
          },
        )
        req.on('error', () =>
          reject(
            new PublicError(
              controller.signal.aborted ? '请求已取消或超时。' : '网络请求失败，请检查网络/代理与服务状态。',
            ),
          ),
        )
        req.on('close', () => agent?.destroy())
        if (body) req.write(body)
        req.end()
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (response.status < 200 || response.status >= 300)
          throw new PublicError(`上游服务返回 HTTP ${response.status}。`)
        const encoding = response.headers['content-encoding']
        const decode =
          encoding === 'gzip'
            ? gunzipSync
            : encoding === 'deflate'
              ? inflateSync
              : encoding === 'br'
                ? brotliDecompressSync
                : undefined
        if (decode) {
          try {
            response.body = decode(response.body, { maxOutputLength: budget })
          } catch {
            throw new PublicError('响应解压失败或解压后超过大小限制。')
          }
        } else if (encoding && encoding !== 'identity') throw new PublicError('不支持此响应的压缩格式。')
        return response
      }
      if (!response.headers.location) throw new PublicError('短链未提供跳转目标。')
      const next = checkedUrl(new URL(response.headers.location, url).href, options)
      if (next.origin !== url.origin && method === 'POST' && body)
        throw new PublicError('携带表单或请求体的操作不能跨来源跳转。')
      if (next.origin !== url.origin)
        headers = Object.fromEntries(
          Object.entries(headers).filter(([key]) => !['cookie', 'authorization'].includes(key.toLowerCase())),
        )
      if (response.status === 303 || (method === 'POST' && [301, 302].includes(response.status))) {
        method = 'GET'
        body = undefined
      }
      url = next
    }
    throw new PublicError('链接跳转次数超过限制。')
  } catch (error) {
    if (error instanceof PublicError) throw error
    throw new PublicError('无法连接数据源，请检查网络/代理与服务状态。')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', parentAbort)
  }
}
export async function json(value: string, options: RequestOptions): Promise<any> {
  const result = await request(value, options)
  try {
    return JSON.parse(result.body.toString('utf8'))
  } catch {
    throw new PublicError('数据源未返回有效 JSON，可能需要登录或服务已变更。')
  }
}
export function mediaKind(bytes: Buffer): 'audio' | 'video' | 'image' | undefined {
  if (bytes.length < 12) return
  if (
    bytes.subarray(4, 8).toString() === 'ftyp' ||
    bytes.subarray(4, 8).toString() === 'styp' ||
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  )
    return 'video'
  if (
    bytes.subarray(0, 3).toString() === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) ||
    ['OggS', 'fLaC', 'RIFF'].includes(bytes.subarray(0, 4).toString())
  )
    return 'audio'
  if (
    (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    bytes.subarray(1, 4).toString() === 'PNG' ||
    bytes.subarray(0, 3).toString() === 'GIF'
  )
    return 'image'
}
