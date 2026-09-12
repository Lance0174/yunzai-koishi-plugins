const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { App } = require('koishi')
const sqlite = require('@koishijs/plugin-database-sqlite').default
const { Store, models } = require('../packages/group-manager/lib/store')
const { State, stateModel } = require('../packages/group-manager/lib/state')
const { waitFor } = require('./fixture.cjs')
let app,
  folder,
  store,
  state,
  now = Date.now()
async function start() {
  app = new App()
  app.plugin(sqlite, { path: path.join(folder, 'db.sqlite') })
  app.inject(['database'], (ctx) => {
    models(ctx)
    stateModel(ctx)
  })
  await app.start()
  await waitFor(async () => {
    if (!app.database?.tables.ember_group_data) return false
    await app.database.get('ember_group_data', {})
    return true
  })
  store = new Store(app.database, () => now)
  state = new State(store)
}
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-automation-state-'))
  await start()
})
after(async () => {
  await app.stop()
  await fs.rm(folder, { recursive: true, force: true })
})
test('parallel scheduling claims issue one lease and stale completion cannot alter the new run', async () => {
  const r = await state.put('onebot:1', '100', 'schedule', 'A', '200', { action: 'mute' }, now, 'pending')
  const other = new State(new Store(app.database, () => now))
  const claims = await Promise.all(
    Array.from({ length: 20 }, (_, i) => (i % 2 ? state : other).claim(r.id, 1000)),
  )
  assert.equal(claims.filter(Boolean).length, 1)
  const first = claims.find(Boolean)
  await state.finish(r.id, first.claim, 'acknowledged')
  await state.put('onebot:1', '100', 'schedule', 'A', '200', { action: 'unmute' }, now, 'pending')
  const next = await state.claim(r.id, 1000)
  assert.notEqual(first.claim, next.claim)
  await state.finish(r.id, first.claim, 'failed')
  assert.equal((await state.get('onebot:1', '100', 'schedule', 'A')).state, 'processing')
  await state.finish(r.id, next.claim, 'acknowledged')
  assert.equal((await app.database.get('ember_group_audit', { target: 'A' })).length, 4)
})
test('transactions roll back rule edits and votes stay scoped by bot and group', async () => {
  const first = await state.put(
    'onebot:1',
    '100',
    'vote',
    'V',
    '200',
    { voters: ['200'] },
    now + 1000,
    'voting',
  )
  await state.put('onebot:2', '100', 'vote', 'V', '200', { voters: ['200'] }, now + 1000, 'voting')
  await assert.rejects(
    state.edit(first.id, (r) => {
      r.payload.voters.push('300')
      throw new Error('forced rollback')
    }),
    /forced rollback/,
  )
  assert.deepEqual((await state.get('onebot:1', '100', 'vote', 'V')).payload.voters, ['200'])
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      state.edit(first.id, (r) => {
        r.payload.voters.push(String(i))
      }),
    ),
  )
  assert.equal((await state.get('onebot:1', '100', 'vote', 'V')).payload.voters.length, 11)
  assert.equal((await state.get('onebot:2', '100', 'vote', 'V')).payload.voters.length, 1)
  assert.equal(await state.get('onebot:1', '101', 'vote', 'V'), undefined)
})
test('full database restart preserves pending schedules and recovers interrupted runs as unknown', async () => {
  const pending = await state.put(
    'onebot:1',
    '100',
    'schedule',
    'restart-pending',
    '200',
    {},
    now + 1000,
    'pending',
  )
  const interrupted = await state.put(
    'onebot:1',
    '100',
    'schedule',
    'restart-running',
    '200',
    {},
    now,
    'pending',
  )
  await state.claim(interrupted.id, 1000)
  await app.stop()
  now += 2000
  await start()
  await state.recover()
  assert.equal((await state.get('onebot:1', '100', 'schedule', 'restart-pending')).state, 'pending')
  assert.equal((await state.get('onebot:1', '100', 'schedule', 'restart-running')).state, 'uncertain')
  assert.equal(await state.claim(interrupted.id, 1000), undefined)
  assert.ok(await state.claim(pending.id, 1000))
})
