import { Context } from 'koishi'
import { randomUUID } from 'node:crypto'
import { Store, key } from './store'

export interface DataRow {
  id: string
  bot: string
  guildId: string
  kind: string
  ref: string
  actor: string
  payload: Record<string, any>
  state: string
  due: number
  updated: number
  lease: number
  claim: string
}
declare module 'koishi' {
  interface Tables {
    ember_group_data: DataRow
  }
}
export function stateModel(ctx: Context) {
  ctx.model.extend(
    'ember_group_data',
    {
      id: 'string(64)',
      bot: 'string(160)',
      guildId: 'string(80)',
      kind: 'string(30)',
      ref: 'string(160)',
      actor: 'string(80)',
      payload: 'json',
      state: 'string(20)',
      due: 'double',
      updated: 'double',
      lease: 'double',
      claim: 'string(40)',
    },
    { primary: 'id' },
  )
}

// Rules, votes and scheduled work use Store's same process-wide transaction queue.
export class State {
  constructor(readonly store: Store) {}
  id(bot: string, guildId: string, kind: string, ref = '') {
    return key(bot, guildId, kind, ref)
  }
  async get(bot: string, guildId: string, kind: string, ref = ''): Promise<DataRow | undefined> {
    return (await this.store.db.get('ember_group_data', { id: this.id(bot, guildId, kind, ref) }))[0]
  }
  list(bot: string, guildId: string, kind: string) {
    return this.store.db.get(
      'ember_group_data',
      { bot, guildId, kind },
      { sort: { updated: 'desc' }, limit: 2000 },
    )
  }
  put(
    bot: string,
    guildId: string,
    kind: string,
    ref: string,
    actor: string,
    payload: Record<string, any>,
    due = 0,
    status = 'enabled',
  ) {
    return this.store.atomic(async (db) => {
      const id = this.id(bot, guildId, kind, ref)
      const row: DataRow = {
        id,
        bot,
        guildId,
        kind,
        ref,
        actor,
        payload,
        due,
        state: status,
        updated: this.store.now(),
        lease: 0,
        claim: '',
      }
      await db.upsert('ember_group_data', [row])
      return row
    })
  }
  edit<T>(id: string, run: (row: DataRow) => T | Promise<T>) {
    return this.store.atomic(async (db) => {
      const row = (await db.get('ember_group_data', { id }))[0]
      if (!row) return
      const result = await run(row)
      row.updated = this.store.now()
      const { id: ignored, ...update } = row
      await db.set('ember_group_data', { id }, update)
      return result
    })
  }
  async claim(id: string, lease: number) {
    return this.store.atomic(async (db) => {
      const row = (
        await db.get('ember_group_data', { id, state: 'pending', due: { $lte: this.store.now() } })
      )[0]
      if (!row) return
      row.state = 'processing'
      row.claim = randomUUID()
      row.lease = this.store.now() + lease
      await db.set('ember_group_data', { id }, { state: row.state, lease: row.lease, claim: row.claim })
      await db.create('ember_group_audit', {
        id: randomUUID(),
        bot: row.bot,
        guildId: row.guildId,
        actor: row.actor,
        action: row.kind,
        target: row.ref,
        state: 'processing',
        detail: '',
        created: this.store.now(),
      })
      return row
    })
  }
  finish(id: string, claim: string, status: string, detail = '') {
    return this.store.atomic(async (db) => {
      const row = (await db.get('ember_group_data', { id, claim, state: 'processing' }))[0]
      if (!row) return
      await db.set(
        'ember_group_data',
        { id },
        {
          state: status,
          lease: 0,
          updated: this.store.now(),
          payload: { ...row.payload, result: detail.slice(0, 300) },
        },
      )
      await db.create('ember_group_audit', {
        id: randomUUID(),
        bot: row.bot,
        guildId: row.guildId,
        actor: row.actor,
        action: row.kind,
        target: row.ref,
        state: status,
        detail: detail.slice(0, 300),
        created: this.store.now(),
      })
    })
  }
  async recover() {
    const rows = await this.store.db.get('ember_group_data', {
      state: 'processing',
      lease: { $lte: this.store.now() },
    })
    for (const row of rows)
      await this.finish(row.id, row.claim, 'uncertain', '执行中断，结果待核实；不会自动重试。')
  }
}
