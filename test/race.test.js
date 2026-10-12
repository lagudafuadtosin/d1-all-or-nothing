// Five gifts of 30 coins sent at once from a wallet holding 100.
// Each request reads the wallet, decides, then writes, the way a Worker does.
// With allOrNothing exactly three land and no coin is made or lost.
// Without it, every request sees 100 and coins appear from nowhere.
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
  await db.exec('CREATE TABLE wallets (id TEXT PRIMARY KEY, coins INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0)')
  await db.prepare("INSERT INTO wallets (id, coins) VALUES ('ada', 100), ('bayo', 0)").run()
})

const read = (id) => db.prepare('SELECT coins, version FROM wallets WHERE id = ?').bind(id).first()
const total = async () => (await read('ada')).coins + (await read('bayo')).coins

async function guardedGift(coins) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const ada = await read('ada')
    if (ada.coins < coins) return 'refused'
    const r = await allOrNothing(db, { table: 'wallets', id: 'ada', version: ada.version }, [
      db.prepare('UPDATE wallets SET coins = ? WHERE id = ?').bind(ada.coins - coins, 'ada'),
      db.prepare('UPDATE wallets SET coins = coins + ? WHERE id = ?').bind(coins, 'bayo'),
    ])
    if (r.ok) return 'sent'
  }
  return 'gave up'
}

async function plainGift(coins) {
  const ada = await read('ada')
  if (ada.coins < coins) return 'refused'
  await db.batch([
    db.prepare('UPDATE wallets SET coins = ? WHERE id = ?').bind(ada.coins - coins, 'ada'),
    db.prepare('UPDATE wallets SET coins = coins + ? WHERE id = ?').bind(coins, 'bayo'),
  ])
  return 'sent'
}

test('with allOrNothing: three of five land, 100 coins in total before and after', async () => {
  const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => guardedGift(30)))
  assert.equal(outcomes.filter((o) => o === 'sent').length, 3, outcomes.join(', '))
  assert.equal(outcomes.filter((o) => o === 'refused').length, 2)
  assert.deepEqual(await read('ada'), { coins: 10, version: 3 })
  assert.equal((await read('bayo')).coins, 90)
  assert.equal(await total(), 100)
})

test('without it (a plain batch): the same five gifts make coins from nothing', async () => {
  const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => plainGift(30)))
  const after = await total()
  console.log(`  plain batch: ${outcomes.filter((o) => o === 'sent').length} sent, ada ${(await read('ada')).coins}, bayo ${(await read('bayo')).coins}, total ${after}`)
  assert.ok(after > 100, `expected the race to break the total, got ${after}`)
})
