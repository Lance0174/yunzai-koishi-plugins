const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { mkdtemp, rm } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { App } = require('koishi')
const sqlite = require('@koishijs/plugin-database-sqlite').default
const { Store, models } = require('../packages/group-manager/lib/store')
const { timed, ActionError, duration, userId } = require('../packages/group-manager/lib/onebot')
const { waitFor } = require('./fixture.cjs')

let app,
  folder,
  store,
  now = Date.now()
async function start() {
  app = new App()
  app.plugin(sqlite, { path: path.join(folder, 'state.db') })
  app.inject(['database'], (ctx) => models(ctx))
  await app.start()
  await waitFor(async () => {
    if (!app.database?.tables.ember_group_request) return false
    await app.database.get('ember_group_request', {})
    return true
  })
  store = new Store(app.database, () => now)
}
before(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'ember-store-'))
  await start()
})
after(async () => {
  await app?.stop()
  await rm(folder, { recursive: true, force: true })
})
const input = (flag, bot = 'onebot:900') => ({
  bot,
  selfId: bot.split(':')[1],
  kind: 'invite',
  flag,
  guildId: '100',
  userId: '200',
  comment: '申请 <at id="123"/>',
})

test('SQLite transactions deduplicate 20 concurrent requests and permit exactly one claim', async () => {
  const other = new Store(app.database, () => now)
  const rows = await Promise.all(
    Array.from({ length: 20 }, (_, i) => (i % 2 ? store : other).receive(input('opaque-a'), 60000)),
  )
  assert.equal(new Set(rows.map((row) => row.id)).size, 1)
  const claims = await Promise.all(
    rows.map((row, i) => (i % 2 ? store : other).claim(row, String(i), i % 2 === 0, 5000)),
  )
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal(await store.finish(rows[0].id, claims.find(Boolean), 'approved'), true)
  assert.equal(await store.finish(rows[0].id, claims.find(Boolean), 'rejected'), false)
  const audit = await app.database.get('ember_group_audit', { target: rows[0].code })
  assert.deepEqual(
    audit.map((row) => row.state),
    ['processing', 'approved'],
  )
})

test('request flags, bots and real notice IDs remain isolated across accounts', async () => {
  const first = await store.receive(input('same'), 60000)
  const second = await store.receive(input('same', 'onebot:901'), 60000)
  assert.notEqual(first.id, second.id)
  assert.equal(await store.locate(second.bot, first.code), undefined)
  for (const [channel, message] of [
    ['500', '1'],
    ['501', '2'],
  ]) {
    const notice = await store.notice(first, channel),
      claim = await store.claimNotice(notice.id, 1000)
    await store.finishNotice(notice.id, claim, 'sent', message)
    assert.equal((await store.locate(first.bot, undefined, channel, message)).id, first.id)
  }
  // Approval quotes key on the protocol message id, so a delivered notice can be
  // quoted from any channel; forged or foreign message ids never resolve.
  assert.equal((await store.locate(first.bot, undefined, '500', '2')).id, first.id)
  assert.equal(await store.locate(first.bot, undefined, '500', 'forged text'), undefined)
})

test('audit failure rolls back request ownership before any platform action can be submitted', async () => {
  const row = await store.receive(input('audit-rollback'), 60000)
  const failing = new Store(
    {
      transact: (callback) =>
        app.database.transact((db) =>
          callback(
            new Proxy(db, {
              get(target, prop) {
                if (prop === 'create')
                  return (table, data) => {
                    if (table === 'ember_group_audit') throw new Error('Injected disk error')
                    return target.create(table, data)
                  }
                const value = Reflect.get(target, prop)
                return typeof value === 'function' ? value.bind(target) : value
              },
            }),
          ),
        ),
    },
    () => now,
  )
  await assert.rejects(failing.claim(row, '200', true, 1000), /Injected disk/)
  assert.equal((await store.locate(row.bot, row.code)).state, 'pending')
  assert.equal((await app.database.get('ember_group_audit', { target: row.code })).length, 0)
})

test('confirmation is bound to bot, group, actor, expiry and a single execution', async () => {
  const data = { bot: 'onebot:900', guildId: '100', actor: '200', action: 'kick', target: '300' }
  const row = await store.confirmation(data)
  assert.equal(await store.consume(row.id, data.bot, '101', data.actor), undefined)
  assert.equal(await store.consume(row.id, data.bot, data.guildId, '201'), undefined)
  const results = await Promise.all(
    Array.from({ length: 5 }, () => store.consume(row.id, data.bot, data.guildId, data.actor)),
  )
  assert.equal(results.filter(Boolean).length, 1)
  const expired = await store.confirmation(data)
  now += 60001
  assert.equal(await store.consume(expired.id, data.bot, data.guildId, data.actor), undefined)
})

test('restart retains pending requests and turns interrupted operations into uncertain', async () => {
  const pending = await store.receive(input('restart-pending'), 60000)
  const processing = await store.receive(input('restart-processing'), 60000)
  await store.claim(processing, '200', true, 1000)
  const notice = await store.notice(pending, '500')
  await store.claimNotice(notice.id, 1000)
  await app.stop()
  now += 2000
  await start()
  await store.recover()
  assert.equal((await store.locate(pending.bot, pending.code)).state, 'pending')
  assert.equal((await store.locate(processing.bot, processing.code)).state, 'uncertain')
  assert.equal(await store.claim(processing, '201', true, 1000), undefined)
  assert.equal((await app.database.get('ember_group_notice', { id: notice.id }))[0].state, 'uncertain')
  assert.equal(
    (await app.database.get('ember_group_audit', { target: processing.code, state: 'uncertain' })).length,
    1,
  )
})

test('persistent event outbox coalesces overflow without losing its count', async () => {
  await Promise.all(
    Array.from({ length: 110 }, (_, i) => store.enqueueEvent('onebot:900', '600', String(i), `event ${i}`)),
  )
  const rows = await app.database.get('ember_group_event', { channel: '600' })
  assert.equal(rows.length, 101)
  assert.equal(
    rows.reduce((n, row) => n + row.count, 0),
    110,
  )
  const batch = await store.claimEvents('onebot:900', '600', 5000)
  assert.equal(batch.rows.length, 10)
  await store.finishEvents(batch.claim, 'sent')
  assert.equal((await app.database.get('ember_group_event', { channel: '600', state: 'sent' })).length, 10)
})

test('OneBot error codes and unknown timeouts are distinguished; mute uses milliseconds', async () => {
  await assert.rejects(
    timed(() => Promise.reject(Object.assign(new Error('private args'), { code: 100 })), 50),
    (e) => e instanceof ActionError && !e.uncertain && !e.message.includes('private'),
  )
  await assert.rejects(
    timed(() => new Promise(() => {}), 10),
    (e) => e.uncertain,
  )
  assert.equal(duration('2m'), 120000)
  assert.equal(duration('30天'), 2592000000)
  assert.throws(() => duration('31d'))
  assert.throws(() => duration('NaN'))
  assert.equal(userId('onebot:123'), '123')
  assert.throws(() => userId('other:123'))
})
