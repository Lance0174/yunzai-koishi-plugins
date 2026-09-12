import { createHash, randomUUID } from 'node:crypto'
import { Context } from 'koishi'
import { UserError } from './errors'

export interface RequestRow {
  id: string
  code: string
  bot: string
  selfId: string
  kind: string
  flag: string
  guildId: string
  userId: string
  comment: string
  created: number
  expires: number
  state: string
  claim: string
  lease: number
  actor: string
  decision: string
  error: string
}
export interface NoticeRow {
  id: string
  requestId: string
  bot: string
  channel: string
  messageId: string
  state: string
  claim: string
  lease: number
}
export interface AuditRow {
  id: string
  bot: string
  guildId: string
  actor: string
  action: string
  target: string
  state: string
  detail: string
  created: number
}
export interface ConfirmRow {
  id: string
  bot: string
  guildId: string
  actor: string
  action: string
  target: string
  expires: number
  state: string
}
export interface EventRow {
  id: string
  bot: string
  channel: string
  summary: string
  count: number
  created: number
  state: string
  claim: string
  lease: number
}
declare module 'koishi' {
  interface Tables {
    ember_group_request: RequestRow
    ember_group_notice: NoticeRow
    ember_group_audit: AuditRow
    ember_group_confirm: ConfirmRow
    ember_group_event: EventRow
  }
}
export const key = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

export function models(ctx: Context) {
  ctx.model.extend(
    'ember_group_event',
    {
      id: 'string(64)',
      bot: 'string(160)',
      channel: 'string(80)',
      summary: 'text',
      count: 'unsigned',
      created: 'double',
      state: 'string(20)',
      claim: 'string(40)',
      lease: 'double',
    },
    { primary: 'id' },
  )
  ctx.model.extend(
    'ember_group_request',
    {
      id: 'string(64)',
      code: 'string(16)',
      bot: 'string(160)',
      selfId: 'string(80)',
      kind: 'string(16)',
      flag: 'text',
      guildId: 'string(80)',
      userId: 'string(80)',
      comment: 'text',
      created: 'double',
      expires: 'double',
      state: 'string(20)',
      claim: 'string(40)',
      lease: 'double',
      actor: 'string(80)',
      decision: 'string(10)',
      error: 'string(100)',
    },
    { primary: 'id', unique: [['code']] },
  )
  ctx.model.extend(
    'ember_group_notice',
    {
      id: 'string(64)',
      requestId: 'string(64)',
      bot: 'string(160)',
      channel: 'string(80)',
      messageId: 'string(160)',
      state: 'string(20)',
      claim: 'string(40)',
      lease: 'double',
    },
    { primary: 'id' },
  )
  ctx.model.extend(
    'ember_group_audit',
    {
      id: 'string(40)',
      bot: 'string(160)',
      guildId: 'string(80)',
      actor: 'string(80)',
      action: 'string(40)',
      target: 'string(160)',
      state: 'string(20)',
      detail: 'string(300)',
      created: 'double',
    },
    { primary: 'id' },
  )
  ctx.model.extend(
    'ember_group_confirm',
    {
      id: 'string(40)',
      bot: 'string(160)',
      guildId: 'string(80)',
      actor: 'string(80)',
      action: 'string(40)',
      target: 'string(80)',
      expires: 'double',
      state: 'string(20)',
    },
    { primary: 'id' },
  )
}

// Minato SQLite implements set() as read/update. Serialize this plugin's transactions
// within one Koishi process; sharing its sql.js file across processes is unsupported.
let writes: Promise<unknown> = Promise.resolve()

function changed(result: { matched?: number; modified?: number }) {
  const count = result.matched ?? result.modified
  if (count === undefined) throw new UserError('数据库未返回原子更新行数，请更换兼容的数据库驱动。')
  return count === 1
}

export class Store {
  constructor(
    readonly db: Context['database'],
    readonly now = Date.now,
  ) {}
  private atomic<T>(run: (db: Context['database']) => Promise<T>): Promise<T> {
    const result = writes.then(() => this.db.transact(run)) as Promise<T>
    writes = result.catch(() => {})
    return result
  }

  async receive(
    input: Pick<RequestRow, 'bot' | 'selfId' | 'kind' | 'flag' | 'guildId' | 'userId' | 'comment'>,
    ttl: number,
  ) {
    return this.atomic(async (db) => {
      if (!input.flag || input.flag.length > 2048 || !input.guildId || !input.userId)
        throw new UserError('群请求缺少有效标识。')
      const id = key(input.bot, input.kind, input.flag)
      const found = (await db.get('ember_group_request', { id }))[0]
      if (found) return found
      try {
        return await db.create('ember_group_request', {
          ...input,
          comment: input.comment.slice(0, 1000),
          id,
          code: `R-${id.slice(0, 12).toUpperCase()}`,
          created: this.now(),
          expires: this.now() + ttl,
          state: 'pending',
          claim: '',
          lease: 0,
          actor: '',
          decision: '',
          error: '',
        })
      } catch (error) {
        const duplicate = (await db.get('ember_group_request', { id }))[0]
        if (duplicate) return duplicate
        throw error
      }
    })
  }

  async locate(bot: string, code?: string, channel?: string, messageId?: string) {
    if (code) return (await this.db.get('ember_group_request', { bot, code: code.toUpperCase() }))[0]
    if (!channel || !messageId) return
    const notice = (await this.db.get('ember_group_notice', { bot, channel, messageId, state: 'sent' }))[0]
    return notice && (await this.db.get('ember_group_request', { bot, id: notice.requestId }))[0]
  }

  async claim(request: RequestRow, actor: string, approve: boolean, leaseMs: number) {
    return this.atomic(async (db) => {
      const claim = randomUUID()
      const success = changed(
        await db.set(
          'ember_group_request',
          {
            id: request.id,
            bot: request.bot,
            state: 'pending',
            expires: { $gt: this.now() },
          },
          {
            state: 'processing',
            claim,
            lease: this.now() + leaseMs,
            actor,
            decision: approve ? 'approve' : 'reject',
          },
        ),
      )
      if (!success) return
      await db.create('ember_group_audit', {
        id: randomUUID(),
        created: this.now(),
        bot: request.bot,
        guildId: request.guildId,
        actor,
        action: approve ? 'approve' : 'reject',
        target: request.code,
        state: 'processing',
        detail: '',
      })
      return claim
    })
  }

  async finish(id: string, claim: string, state: string, error = '') {
    return this.atomic(async (db) => {
      const query = { id, claim, state: 'processing' }
      const row = (await db.get('ember_group_request', query))[0]
      if (!row || !changed(await db.set('ember_group_request', query, { state, error, lease: 0 })))
        return false
      await db.create('ember_group_audit', {
        id: randomUUID(),
        created: this.now(),
        bot: row.bot,
        guildId: row.guildId,
        actor: row.actor,
        action: row.decision,
        target: row.code,
        state,
        detail: error.slice(0, 300),
      })
      return true
    })
  }

  async notice(request: RequestRow, channel: string) {
    return this.atomic(async (db) => {
      const id = key(request.id, channel)
      const existing = (await db.get('ember_group_notice', { id }))[0]
      if (existing) return existing
      try {
        return await db.create('ember_group_notice', {
          id,
          requestId: request.id,
          bot: request.bot,
          channel,
          messageId: '',
          state: 'pending',
          claim: '',
          lease: 0,
        })
      } catch (error) {
        const duplicate = (await db.get('ember_group_notice', { id }))[0]
        if (duplicate) return duplicate
        throw error
      }
    })
  }

  async claimNotice(id: string, leaseMs: number) {
    const claim = randomUUID()
    return this.atomic(async (db) =>
      changed(
        await db.set(
          'ember_group_notice',
          { id, state: 'pending' },
          { state: 'sending', claim, lease: this.now() + leaseMs },
        ),
      )
        ? claim
        : undefined,
    )
  }

  async finishNotice(id: string, claim: string, state: string, messageId = '') {
    await this.atomic((db) =>
      db.set('ember_group_notice', { id, claim, state: 'sending' }, { state, messageId, lease: 0 }),
    )
  }

  async confirmation(input: Pick<ConfirmRow, 'bot' | 'guildId' | 'actor' | 'action' | 'target'>) {
    return this.atomic((db) =>
      db.create('ember_group_confirm', {
        ...input,
        id: randomUUID().replaceAll('-', ''),
        expires: this.now() + 60_000,
        state: 'pending',
      }),
    )
  }

  async consume(id: string, bot: string, guildId: string, actor: string) {
    return this.atomic(async (db) => {
      const query = { id, bot, guildId, actor, state: 'pending', expires: { $gt: this.now() } }
      const row = (await db.get('ember_group_confirm', query))[0]
      if (!row || !changed(await db.set('ember_group_confirm', query, { state: 'consumed' }))) return
      return row
    })
  }

  async audit(input: Omit<AuditRow, 'id' | 'created'>) {
    return this.atomic((db) =>
      db.create('ember_group_audit', { ...input, id: randomUUID(), created: this.now() }),
    )
  }

  async enqueueEvent(bot: string, channel: string, eventId: string, summary: string) {
    return this.atomic(async (db) => {
      const id = key(bot, channel, eventId)
      if ((await db.get('ember_group_event', { id })).length) return
      const pending = await db.get('ember_group_event', { bot, channel, state: 'pending' }, { limit: 101 })
      if (pending.length >= 100) {
        const overflow = pending.find((row) => row.summary === '密集事件已合并；此条仅记录数量。')
        if (overflow) {
          await db.set('ember_group_event', { id: overflow.id }, { count: overflow.count + 1 })
          return
        }
        summary = '密集事件已合并；此条仅记录数量。'
      }
      await db.create('ember_group_event', {
        id,
        bot,
        channel,
        summary: summary.slice(0, 1000),
        count: 1,
        created: this.now(),
        state: 'pending',
        claim: '',
        lease: 0,
      })
    })
  }
  async claimEvents(bot: string, channel: string, leaseMs: number) {
    return this.atomic(async (db) => {
      const rows = await db.get(
        'ember_group_event',
        { bot, channel, state: 'pending' },
        { sort: { created: 'asc' }, limit: 10 },
      )
      const claim = randomUUID()
      if (rows.length)
        await db.set(
          'ember_group_event',
          { id: { $in: rows.map((row) => row.id) }, state: 'pending' },
          { state: 'sending', claim, lease: this.now() + leaseMs },
        )
      return { rows, claim }
    })
  }
  async finishEvents(claim: string, state: string) {
    return this.atomic((db) => db.set('ember_group_event', { claim, state: 'sending' }, { state, lease: 0 }))
  }

  async recover() {
    return this.atomic(async (db) => {
      const now = this.now()
      await db.set('ember_group_request', { state: 'pending', expires: { $lte: now } }, { state: 'expired' })
      const interrupted = await db.get('ember_group_request', { state: 'processing', lease: { $lte: now } })
      for (const row of interrupted) {
        await db.set(
          'ember_group_request',
          { id: row.id, state: 'processing' },
          { state: 'uncertain', error: '执行中断，结果待核实。', lease: 0 },
        )
        await db.create('ember_group_audit', {
          id: randomUUID(),
          created: now,
          bot: row.bot,
          guildId: row.guildId,
          actor: row.actor,
          action: row.decision,
          target: row.code,
          state: 'uncertain',
          detail: '执行中断，结果待核实。',
        })
      }
      await db.set('ember_group_notice', { state: 'sending', lease: { $lte: now } }, { state: 'uncertain' })
      await db.set('ember_group_event', { state: 'sending', lease: { $lte: now } }, { state: 'uncertain' })
      await db.remove('ember_group_confirm', { expires: { $lte: now } })
      await db.remove('ember_group_event', {
        created: { $lt: now - 7 * 86400_000 },
        state: { $in: ['sent', 'failed', 'uncertain'] },
      })
    })
  }
}
