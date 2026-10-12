// The same guard from Drizzle: pass the Drizzle database and Drizzle queries.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getPlatformProxy } from 'wrangler'
import { drizzle } from 'drizzle-orm/d1'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { eq, sql } from 'drizzle-orm'
import { allOrNothing } from '../src/index.js'

const wallets = sqliteTable('wallets', {
  id: text('id').primaryKey(),
  coins: integer('coins').notNull(),
  version: integer('version').notNull().default(0),
})
const gifts = sqliteTable('gifts', {
  id: integer('id').primaryKey(),
  fromId: text('from_id'),
  toId: text('to_id'),
  coins: integer('coins'),
})

let proxy, db
before(async () => {
  proxy = await getPlatformProxy({ persist: false })
  db = drizzle(proxy.env.DB)
})
after(() => proxy.dispose())

beforeEach(async () => {
  const d1 = proxy.env.DB
  await d1.exec('DROP TABLE IF EXISTS wallets')
  await d1.exec('DROP TABLE IF EXISTS gifts')
  await d1.exec('CREATE TABLE wallets (id TEXT PRIMARY KEY, coins INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0)')
  await d1.exec('CREATE TABLE gifts (id INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, coins INTEGER)')
  await db.insert(wallets).values([{ id: 'ada', coins: 100 }, { id: 'bayo', coins: 0 }])
})

const read = async (id) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0]

async function gift(coins) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const ada = await read('ada')
    if (ada.coins < coins) return 'refused'
    const r = await allOrNothing(db, { table: 'wallets', id: 'ada', version: ada.version }, [
      db.update(wallets).set({ coins: ada.coins - coins }).where(eq(wallets.id, 'ada')),
      db.update(wallets).set({ coins: sql`${wallets.coins} + ${coins}` }).where(eq(wallets.id, 'bayo')),
      db.insert(gifts).values({ fromId: 'ada', toId: 'bayo', coins }),
    ])
    if (r.ok) return 'sent'
  }
  return 'gave up'
}

test('drizzle: a changed row means nothing is written', async () => {
  const r = await allOrNothing(db, { table: 'wallets', id: 'ada', version: 7 }, [
    db.update(wallets).set({ coins: 0 }).where(eq(wallets.id, 'ada')),
    db.insert(gifts).values({ fromId: 'ada', toId: 'bayo', coins: 100 }),
  ])
  assert.deepEqual(r, { ok: false, changed: [{ table: 'wallets', id: 'ada' }] })
  assert.equal((await read('ada')).coins, 100)
  assert.deepEqual(await db.select().from(gifts), [])
})

test('drizzle: five gifts at once, three land, 100 coins in total', async () => {
  const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => gift(30)))
  assert.equal(outcomes.filter((o) => o === 'sent').length, 3, outcomes.join(', '))
  assert.deepEqual(await read('ada'), { id: 'ada', coins: 10, version: 3 })
  assert.equal((await read('bayo')).coins, 90)
  assert.equal((await db.select().from(gifts)).length, 3)
})
