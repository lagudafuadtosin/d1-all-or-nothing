// Runs against a real local D1 (wrangler's local database, the same SQLite D1 uses).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getPlatformProxy } from 'wrangler'
import { allOrNothing } from '../src/index.js'

let proxy, db
before(async () => {
  proxy = await getPlatformProxy({ persist: false })
  db = proxy.env.DB
})
after(() => proxy.dispose())

beforeEach(async () => {
  await db.exec('DROP TABLE IF EXISTS wallets')
  await db.exec('DROP TABLE IF EXISTS gifts')
  await db.exec('CREATE TABLE wallets (id TEXT PRIMARY KEY, coins INTEGER NOT NULL CHECK (coins >= 0), version INTEGER NOT NULL DEFAULT 0)')
  await db.exec('CREATE TABLE gifts (id INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, coins INTEGER)')
  await db.prepare("INSERT INTO wallets (id, coins) VALUES ('ada', 100), ('bayo', 0)").run()
})

const wallet = (id) => db.prepare('SELECT coins, version FROM wallets WHERE id = ?').bind(id).first()
const all = (sql) => db.prepare(sql).all().then((r) => r.results)
const send = (from, to, coins) => [
  db.prepare('UPDATE wallets SET coins = coins - ? WHERE id = ?').bind(coins, from),
  db.prepare('UPDATE wallets SET coins = coins + ? WHERE id = ?').bind(coins, to),
  db.prepare('INSERT INTO gifts (from_id, to_id, coins) VALUES (?, ?, ?)').bind(from, to, coins),
]

test('rows unchanged: every statement runs and each version goes up by one', async () => {
  const r = await allOrNothing(db, [{ table: 'wallets', id: 'ada', version: 0 }, { table: 'wallets', id: 'bayo', version: 0 }], send('ada', 'bayo', 30))
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 3)
  assert.equal(r.results[2].meta.changes, 1)
  assert.deepEqual(await wallet('ada'), { coins: 70, version: 1 })
  assert.deepEqual(await wallet('bayo'), { coins: 30, version: 1 })
})

test('a row changed since it was read: nothing is written, not even the statements before', async () => {
  await db.prepare("UPDATE wallets SET version = 1 WHERE id = 'bayo'").run()
  const r = await allOrNothing(db, [{ table: 'wallets', id: 'ada', version: 0 }, { table: 'wallets', id: 'bayo', version: 0 }], send('ada', 'bayo', 30))
  assert.deepEqual(r, { ok: false, changed: [{ table: 'wallets', id: 'bayo' }] })
  assert.deepEqual(await wallet('ada'), { coins: 100, version: 0 })
  assert.deepEqual(await wallet('bayo'), { coins: 0, version: 1 })
  assert.deepEqual(await all('SELECT * FROM gifts'), [])
})

test('a row deleted since it was read counts as changed', async () => {
  await db.prepare("DELETE FROM wallets WHERE id = 'bayo'").run()
  const r = await allOrNothing(db, { table: 'wallets', id: 'bayo', version: 0 }, [db.prepare("INSERT INTO gifts (to_id, coins) VALUES ('bayo', 1)")])
  assert.equal(r.ok, false)
  assert.deepEqual(await all('SELECT * FROM gifts'), [])
})

test('version null: the row must not exist yet, so only the first of two creates wins', async () => {
  const create = () =>
    allOrNothing(db, { table: 'wallets', id: 'chi', version: null }, [db.prepare("INSERT INTO wallets (id, coins) VALUES ('chi', 5)")])
  assert.equal((await create()).ok, true)
  assert.equal((await create()).ok, false)
  assert.deepEqual(await wallet('chi'), { coins: 5, version: 1 })
})

test('your own statement failing still throws, and nothing is written', async () => {
  await assert.rejects(
    allOrNothing(db, { table: 'wallets', id: 'ada', version: 0 }, send('ada', 'bayo', 500)), // CHECK coins >= 0
    /CHECK constraint failed/,
  )
  assert.deepEqual(await wallet('ada'), { coins: 100, version: 0 })
  assert.deepEqual(await wallet('bayo'), { coins: 0, version: 0 })
})

test('your own malformed JSON is not mistaken for a changed row', async () => {
  await assert.rejects(
    allOrNothing(db, { table: 'wallets', id: 'ada', version: 0 }, [db.prepare("SELECT json('nope')")]),
    /malformed JSON/,
  )
  assert.deepEqual(await wallet('ada'), { coins: 100, version: 0 })
})

test('the same row twice is checked and bumped once', async () => {
  const g = { table: 'wallets', id: 'ada', version: 0 }
  assert.equal((await allOrNothing(db, [g, { ...g }], [])).ok, true)
  assert.deepEqual(await wallet('ada'), { coins: 100, version: 1 })
})

test('other id and version column names', async () => {
  await db.exec('CREATE TABLE IF NOT EXISTS lives (life_id INTEGER PRIMARY KEY, ver INTEGER NOT NULL DEFAULT 0, naira INTEGER)')
  await db.exec('DELETE FROM lives')
  await db.prepare('INSERT INTO lives (life_id, naira) VALUES (7, 10)').run()
  const g = { table: 'lives', id: 7, version: 0, idColumn: 'life_id', versionColumn: 'ver' }
  assert.equal((await allOrNothing(db, g, [db.prepare('UPDATE lives SET naira = 20 WHERE life_id = 7')])).ok, true)
  assert.equal((await allOrNothing(db, g, [db.prepare('UPDATE lives SET naira = 30 WHERE life_id = 7')])).ok, false)
  assert.deepEqual(await db.prepare('SELECT naira, ver FROM lives').first(), { naira: 20, ver: 1 })
})

test('names that are not plain SQL names are refused before anything runs', async () => {
  const bad = [
    { table: 'wallets; DROP TABLE wallets', id: 'ada', version: 0 },
    { table: 'wallets', id: 'ada', version: 0, idColumn: 'id" OR 1=1 --' },
    { table: 'wallets', id: 'ada', version: 0, versionColumn: '' },
  ]
  for (const g of bad) await assert.rejects(allOrNothing(db, g, []), TypeError)
  await assert.rejects(allOrNothing(db, [], []), TypeError)
  await assert.rejects(allOrNothing(db, { table: 'wallets', id: 'ada', version: '0' }, []), TypeError)
  await assert.rejects(allOrNothing(db, { table: 'wallets', version: 0 }, []), TypeError)
  await assert.rejects(allOrNothing(db, [{ table: 'wallets', id: 'ada', version: 0 }, { table: 'wallets', id: 'ada', version: 1 }], []), TypeError)
  assert.deepEqual(await wallet('ada'), { coins: 100, version: 0 })
})

test('the id is bound, never pasted into the SQL', async () => {
  const r = await allOrNothing(db, { table: 'wallets', id: "ada' OR '1'='1", version: 0 }, [])
  assert.equal(r.ok, false)
  assert.deepEqual(await wallet('ada'), { coins: 100, version: 0 })
})
