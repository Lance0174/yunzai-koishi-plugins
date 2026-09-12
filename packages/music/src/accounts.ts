import { Context, Command, Session, h } from 'koishi'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import QRCode from 'qrcode'
import { Providers, Platform, platform } from './providers'
import { neteaseRequest } from './netease'
import { PublicError } from './net'

interface Account {
  cookie: string
  origin: string
  saved: number
}
interface Login {
  owner: string
  scope: string
  key: string
  expires: number
  control: AbortController
  session: Session
  scanned: boolean
  busy: boolean
}
export class AccountStore {
  private entries: Record<string, Account> = {}
  private loaded?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  readonly file: string
  constructor(base: string) {
    this.file = path.resolve(base, 'data/yunzai-music-request/accounts.json')
  }
  private load() {
    return (this.loaded ??= fs
      .readFile(this.file, 'utf8')
      .then((content) => {
        const data = JSON.parse(content)
        if (
          data.version !== 1 ||
          !data.accounts ||
          typeof data.accounts !== 'object' ||
          Array.isArray(data.accounts)
        )
          throw new Error('Invalid accounts file')
        for (const [id, value] of Object.entries(data.accounts)) {
          const entry = value as Account
          if (
            /^[a-f0-9]{64}$/.test(id) &&
            typeof entry.cookie === 'string' &&
            typeof entry.origin === 'string' &&
            entry.cookie.length < 20000
          )
            this.entries[id] = entry
        }
      })
      .catch((error) => {
        if (error.code !== 'ENOENT') throw new PublicError('账号文件读取失败，请检查文件权限或恢复备份。')
      }))
  }
  async get(scope: string, origin: string) {
    await this.load()
    const value = this.entries[scope]
    return value?.origin === origin ? value.cookie : ''
  }
  change(scope: string, entry?: Account, valid = () => true) {
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        await this.load()
        if (!valid()) return
        const next = { ...this.entries }
        if (entry) next[scope] = entry
        else delete next[scope]
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
        const temp = `${this.file}.${randomUUID()}.tmp`
        try {
          await fs.writeFile(temp, JSON.stringify({ version: 1, accounts: next }), {
            mode: 0o600,
            flag: 'wx',
          })
          if (!valid()) return
          await fs.rename(temp, this.file)
          this.entries = next
        } finally {
          await fs.rm(temp, { force: true })
        }
      })
    this.writes = write
    return write
  }
  async close() {
    await this.writes.catch(() => {})
  }
}
export interface AccountConfig {
  loginAdmins: string[]
  neteaseApi: string
  timeout: number
  proxy: string
}
export class Accounts {
  readonly store: AccountStore
  private logins = new Map<string, Login>()
  private disposed = false
  private tasks = new Set<Promise<unknown>>()
  constructor(
    readonly ctx: Context,
    readonly config: AccountConfig,
    readonly provider: Providers,
  ) {
    this.store = new AccountStore(ctx.baseDir || process.cwd())
    ctx.setInterval(() => {
      for (const login of this.logins.values()) {
        if (login.busy) continue
        const work = this.poll(login).finally(() => this.tasks.delete(work))
        this.tasks.add(work)
      }
    }, 2500)
    ctx.on('dispose', async () => {
      this.disposed = true
      for (const login of this.logins.values()) login.control.abort()
      this.logins.clear()
      await Promise.allSettled([...this.tasks])
      await this.store.close()
    })
  }
  scope(s: Pick<Session, 'platform' | 'selfId'>, source: Platform) {
    return createHash('sha256')
      .update(JSON.stringify([s.platform, s.selfId, source]))
      .digest('hex')
  }
  private origin() {
    return this.config.neteaseApi.replace(/\/$/, '') || 'https://interface.music.163.com'
  }
  cookie(s: Pick<Session, 'platform' | 'selfId'>, source: Platform) {
    return source === 'netease' ? this.store.get(this.scope(s, source), this.origin()) : Promise.resolve('')
  }
  private async api(action: 'key' | 'check', key: string, signal: AbortSignal) {
    if (this.config.neteaseApi) {
      const data = await this.provider.gateway(
        this.config.neteaseApi,
        `/login/qr/${action}`,
        { ...(key ? { key } : {}), timestamp: String(Date.now()), noCookie: 'true' },
        '',
        signal,
      )
      return { data: action === 'key' ? data.data : data, cookie: String(data.cookie ?? '') }
    }
    return neteaseRequest(
      `/api/login/qrcode/${action === 'key' ? 'unikey' : 'client/login'}`,
      { type: 3, ...(key ? { key } : {}) },
      { ...this.config, signal },
    )
  }
  private current(login: Login) {
    return !this.disposed && !login.control.signal.aborted && this.logins.get(login.scope) === login
  }
  private async notify(login: Login, content: h.Fragment) {
    if (!this.current(login)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const ids = await Promise.race([
        login.session.send(content),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('send timeout')), this.config.timeout)
        }),
      ])
      if (!ids?.length) throw new Error('No acknowledgement')
    } finally {
      clearTimeout(timer)
    }
  }
  async poll(login: Login) {
    if (!this.current(login) || login.busy) return
    login.busy = true
    try {
      if (Date.now() >= login.expires) {
        await this.notify(login, '登录二维码已过期，请重新发送“点歌 登录 网易云”。')
        if (this.current(login)) this.logins.delete(login.scope)
        return
      }
      const result = await this.api('check', login.key, login.control.signal)
      if (!this.current(login)) return
      const code = Number(result.data?.code)
      if (code === 803) {
        const cookie = result.cookie
        if (!/(?:^|;\s*)MUSIC_U=[^;\s]+/.test(cookie))
          throw new PublicError('登录结果缺少有效账号信息，请重新扫码。')
        await this.store.change(login.scope, { cookie, origin: this.origin(), saved: Date.now() }, () =>
          this.current(login),
        )
        await this.notify(
          login,
          '网易云登录成功，账号已用于当前机器人点歌。可用“点歌 账号”查看或“点歌 退出登录 网易云”解除。',
        )
        if (this.current(login)) this.logins.delete(login.scope)
      } else if (code === 800) {
        await this.notify(login, '二维码已失效，请重新发送“点歌 登录 网易云”。')
        if (this.current(login)) this.logins.delete(login.scope)
      } else if (code === 802 && !login.scanned) {
        login.scanned = true
        await this.notify(login, '已扫码，请在网易云 App 中确认登录。')
      } else if (![801, 802].includes(code)) throw new PublicError('网易云登录服务暂不可用，请重新扫码。')
    } catch (error) {
      if (this.current(login)) {
        await this.notify(
          login,
          error instanceof PublicError ? error.message : '登录未完成，请稍后重新扫码。',
        ).catch(() => {})
        this.logins.delete(login.scope)
      }
    } finally {
      login.busy = false
    }
  }
  install(root: Command) {
    const access = (s: Session) => {
      if (s.guildId) throw new PublicError('请私聊机器人操作音乐账号。')
      if (
        !s.userId ||
        (!this.config.loginAdmins.includes(s.userId) &&
          ((s.user as { authority?: number } | undefined)?.authority ?? 0) < 4)
      )
        throw new PublicError('音乐账号仅允许配置的账号管理员或 Koishi 权限等级 4 及以上用户操作。')
    }
    const guard = async (fn: () => Promise<h.Fragment | void>) => {
      try {
        return await fn()
      } catch (e) {
        return e instanceof PublicError ? e.message : '音乐账号操作失败，请稍后再试。'
      }
    }
    root
      .subcommand('.登录 [source:string]', '私聊扫码登录网易云；无需填写 Cookie', { authority: 0 })
      .userFields(['authority'])
      .action(({ session }, source = '网易云') =>
        guard(async () => {
          const s = session!
          access(s)
          if (platform(source) !== 'netease')
            throw new PublicError('目前账号扫码支持网易云；QQ音乐、酷狗、酷我使用匿名点歌。')
          const scope = this.scope(s, 'netease')
          const previous = this.logins.get(scope)
          if (previous && previous.owner !== s.userId)
            throw new PublicError('另一位管理员正在为当前机器人扫码，请稍后重试。')
          previous?.control.abort()
          if (this.logins.size >= 4 && !previous) throw new PublicError('当前扫码任务已满，请稍后重试。')
          const login: Login = {
            scope,
            owner: s.userId!,
            session: s,
            key: '',
            expires: Date.now() + 180000,
            control: new AbortController(),
            scanned: false,
            busy: true,
          }
          this.logins.set(scope, login)
          try {
            const result = await this.api('key', '', login.control.signal)
            if (!this.current(login)) return
            const key = String(result.data?.unikey ?? '')
            if (!/^[\w-]{8,256}$/.test(key)) throw new PublicError('未取得登录二维码，请稍后重试。')
            login.key = key
            const bytes = await QRCode.toBuffer(
              `https://music.163.com/login?codekey=${encodeURIComponent(key)}`,
              { width: 280, margin: 2 },
            )
            await this.notify(login, [
              h.text('请使用网易云 App 扫码并确认登录，二维码 3 分钟内有效。'),
              h.image(bytes, 'image/png'),
            ])
            login.busy = false
          } catch (e) {
            if (this.current(login)) this.logins.delete(scope)
            throw e
          }
        }),
      )
    root
      .subcommand('.账号', '查看当前机器人音乐账号状态', { authority: 0 })
      .userFields(['authority'])
      .action(({ session }) =>
        guard(async () => {
          access(session!)
          return `网易云：${(await this.cookie(session!, 'netease')) ? '已保存扫码登录态' : '未登录'}。\n点歌 登录 网易云 / 点歌 退出登录 网易云`
        }),
      )
    root
      .subcommand('.退出登录 [source:string]', '取消扫码并移除当前机器人的音乐登录态', { authority: 0 })
      .userFields(['authority'])
      .action(({ session }, source = '网易云') =>
        guard(async () => {
          access(session!)
          const selected = platform(source),
            scope = this.scope(session!, selected)
          this.logins.get(scope)?.control.abort()
          this.logins.delete(scope)
          await this.store.change(scope)
          return '已取消扫码并移除当前机器人的音乐登录态。'
        }),
      )
  }
}
