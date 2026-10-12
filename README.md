# d1-all-or-nothing

Writes on Cloudflare D1 that all happen or none do, even when another request changed the rows you read.

```sh
npm install d1-all-or-nothing
```

## The problem

D1 has no transactions you can read inside. A Worker reads a row, decides what to write, then writes it. Between the read and the write, another request can change the same row, and nothing stops the second write.

Five gifts of 30 coins sent at once from a wallet holding 100, each one read, checked and written the normal way:

| | sent | wallet | receiver | total |
|---|---|---|---|---|
| plain `db.batch()` | 5 | 70 | 150 | **220** |
| `allOrNothing()` | 3 | 10 | 90 | **100** |

Every plain request saw 100 coins, so all five went through and 120 coins came from nowhere. That is the race test in this repo, run against a real local D1.

## How it works

A D1 batch runs as one transaction, and if any statement in it fails, the whole batch is rolled back. `allOrNothing()` puts a check in front of your writes for each row you read: is it still at the version you read? After your writes it adds one to each of those versions. If any row changed in between, its check fails, the batch is rolled back, and nothing at all is written. You get `{ ok: false }`, read again and retry.

There is no lock and no extra table. Each table you guard needs one INTEGER version column.

## Use it

Add a version column to the tables you guard:

```sql
alter table wallets add column version integer not null default 0;
```

Read, decide, then write through `allOrNothing()` with the version you read:

```js
import { allOrNothing } from 'd1-all-or-nothing'

async function sendGift(db, from, to, coins) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wallet = await db.prepare('select coins, version from wallets where id = ?').bind(from).first()
    if (wallet.coins < coins) return 'not enough coins'

    const result = await allOrNothing(db, { table: 'wallets', id: from, version: wallet.version }, [
      db.prepare('update wallets set coins = ? where id = ?').bind(wallet.coins - coins, from),
      db.prepare('update wallets set coins = coins + ? where id = ?').bind(coins, to),
      db.prepare('insert into gifts (from_id, to_id, coins) values (?, ?, ?)').bind(from, to, coins),
    ])
    if (result.ok) return 'sent'
    // Someone else changed the wallet first. Nothing was written. Read again.
  }
  return 'busy, try again'
}
```

### With Drizzle

Drizzle's `db.transaction()` cannot work on D1, because D1 refuses `BEGIN TRANSACTION`. Pass the Drizzle database and Drizzle queries instead:

```js
import { drizzle } from 'drizzle-orm/d1'
import { eq, sql } from 'drizzle-orm'
import { allOrNothing } from 'd1-all-or-nothing'

const db = drizzle(env.DB)
const [wallet] = await db.select().from(wallets).where(eq(wallets.id, from))

const result = await allOrNothing(db, { table: 'wallets', id: from, version: wallet.version }, [
  db.update(wallets).set({ coins: wallet.coins - coins }).where(eq(wallets.id, from)),
  db.update(wallets).set({ coins: sql`${wallets.coins} + ${coins}` }).where(eq(wallets.id, to)),
  db.insert(gifts).values({ fromId: from, toId: to, coins }),
])
```

The table name in the guard is the SQL table name, as in `sqliteTable('wallets', ...)`.

### Reference

`allOrNothing(db, guards, statements)`

- `db`: the D1 binding (`env.DB`), or a Drizzle database made from it.

- `guards`: one or a list of `{ table, id, version }`, the rows your decision was based on. Optional `idColumn` (default `id`) and `versionColumn` (default `version`).
- `version: null` means the row must not exist yet, so only the first of two requests creating it wins.
- `statements`: your D1 prepared statements or Drizzle queries, run in order.
- Returns `{ ok: true, results }` with one result per statement of yours, or `{ ok: false, changed }` listing the rows that moved.
- Anything else that fails (a constraint, bad SQL) throws, and nothing is written either.

## Good to know

- Guard every row your decision reads. A row you read but do not guard can still change under you.
- Only `allOrNothing()` should change a version column. If other code writes the row without going through it, give that code the same guard or bump the version yourself.
- Table and column names must be plain SQL names (letters, digits and `_`), since names cannot be bound. Ids and versions are always bound.
- It works because D1 rolls a batch back when a statement fails. It raises that failure with `json()` on text that is not JSON, because SQLite has no other way to fail a plain statement on purpose. If one of your own statements fails the same way, the versions are read again to tell the two apart, and your error is thrown.
- It is not a transaction you can read inside. You read first, then hand over all the writes at once. Code that needs to read, decide and write again in the middle needs splitting into rounds, each one guarded.
- It uses the Worker binding's `batch()`. The D1 REST API and `wrangler d1 execute` are not covered.
- Under heavy contention requests retry more. For one very busy row, a Durable Object that owns it is the better fit.

## Tests

```sh
npm install
npm test
```

The tests run against a local D1 from wrangler, the same SQLite D1 runs on. They cover unchanged rows, Drizzle, changed and deleted rows, `version: null`, your own errors, column names, refused names, a bound id, and the five-gift race with and without the guard.

## Licence

MIT, Fuad Laguda.
