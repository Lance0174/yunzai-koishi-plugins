// NetEase endpoint/envelope reference: NeteaseCloudMusicApi 4.32.0 by Binaryify
// and contributors (MIT). See THIRD_PARTY_NOTICES.md and licenses/netease-api-MIT.txt.
import { createCipheriv, createHash } from 'node:crypto'
import { request, PublicError } from './net'

export async function neteaseRequest(
  path: string,
  params: Record<string, unknown>,
  options: { timeout: number; proxy: string; cookie?: string; signal?: AbortSignal },
) {
  const text = JSON.stringify(params)
  const digest = createHash('md5').update(`nobody${path}use${text}md5forencrypt`).digest('hex')
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null)
  const encrypted = Buffer.concat([
    cipher.update(`${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`),
    cipher.final(),
  ])
    .toString('hex')
    .toUpperCase()
  const response = await request(`https://interface.music.163.com/eapi/${path.slice(5)}`, {
    hosts: ['interface.music.163.com'],
    timeout: options.timeout,
    proxy: options.proxy,
    signal: options.signal,
    method: 'POST',
    redirects: 0,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com/',
      Cookie: options.cookie || 'os=pc; appver=2.10.13',
    },
    body: new URLSearchParams({ params: encrypted }).toString(),
  })
  let data: any
  try {
    data = JSON.parse(response.body.toString('utf8'))
  } catch {
    throw new PublicError('网易云没有返回有效响应，请稍后重试。')
  }
  const cookie = (response.headers['set-cookie'] ?? []).map((item) => item.split(';')[0]).join('; ')
  return { data, cookie }
}
