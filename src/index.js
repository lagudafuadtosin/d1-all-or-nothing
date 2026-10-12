// All or nothing on Cloudflare D1.
//
// D1 has no interactive transactions. You cannot read a row, decide, and write
// inside one transaction, so between your read and your write another request
// can change the same row. Two gifts sent at once both spend the same coins.
//
// A batch does run as one transaction, and a statement that fails rolls the
// whole batch back. allOrNothing() uses that: in front of your writes it puts a
// check for every row you read, and after them it bumps each row's version. If
// any of those rows changed since you read it, a check fails, nothing at all is
// written, and you get { ok: false } so you can read again and retry.

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// SQLite has no way to raise an error from a plain statement, but json() on text
// that is not JSON fails the statement, and that rolls back the batch.
const FAIL = "json('d1-all-or-nothing: a guarded row changed')"

function sqlName(name, what) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(`${what} must be a plain SQL name (letters, digits and _), got ${JSON.stringify(name)}`)
  }
  return `"${name}"`
}

function readGuards(guards) {
  const list = Array.isArray(guards) ? guards : [guards]
  if (list.length === 0 || list.some((g) => !g || typeof g !== 'object')) {
    throw new TypeError('allOrNothing needs a guard for each row you read before writing: { table, id, version }')
  }
  const seen = new Map()
  for (const g of list) {
    const table = sqlName(g.table, 'table')
    const idColumn = sqlName(g.idColumn ?? 'id', 'idColumn')
    const versionColumn = sqlName(g.versionColumn ?? 'version', 'versionColumn')
    if (g.id === undefined || g.id === null) throw new TypeError(`guard on ${g.table} has no id`)
    if (g.version !== null && !Number.isInteger(g.version)) {
      throw new TypeError(`guard on ${g.table} needs the version you read (a whole number, or null for a row that must not exist yet)`)
    }
    const key = `${table}.${idColumn}=${typeof g.id}:${g.id}`
    const before = seen.get(key)
    if (before && before.version !== g.version) {
      throw new TypeError(`two guards on the same row (${g.table} ${g.id}) with different versions`)
    }
    seen.set(key, { table, idColumn, versionColumn, id: g.id, version: g.version, name: g.table })
  }
  return [...seen.values()]
}

async function changedSince(db, guards) {
  const rows = await db.batch(
    guards.map((g) => db.prepare(`SELECT ${g.versionColumn} AS v FROM ${g.table} WHERE ${g.idColumn} = ?1`).bind(g.id)),
  )
  return guards
    .filter((g, i) => (rows[i].results[0]?.v ?? null) !== g.version)
    .map((g) => ({ table: g.name, id: g.id }))
}

/**
 * Run statements only if every guarded row is still at the version you read.
 * Each guarded row's version goes up by one when they run.
 *
 * @param {D1Database} db the D1 binding, or a Drizzle database made from it
 * @param {Guard | Guard[]} guards the rows you read before deciding what to write
 * @param {D1PreparedStatement[]} statements your writes: D1 prepared statements or Drizzle queries
 * @returns {Promise<{ ok: true, results: D1Result[] } | { ok: false, changed: { table: string, id: unknown }[] }>}
 */
export async function allOrNothing(db, guards, statements) {
  // A Drizzle database carries the D1 binding as $client, and its queries give their SQL through toSQL().
  if (db && db.$client && typeof db.$client.batch === 'function') db = db.$client
  const list = readGuards(guards)
  if (!Array.isArray(statements)) throw new TypeError('statements must be an array of prepared statements')
  statements = statements.map((s) => {
    if (s && typeof s.toSQL === 'function') {
      const { sql, params } = s.toSQL()
      return db.prepare(sql).bind(...params)
    }
    return s
  })
  const checks = list.map((g) =>
    db
      .prepare(`SELECT CASE WHEN (SELECT ${g.versionColumn} FROM ${g.table} WHERE ${g.idColumn} = ?1) IS ?2 THEN 1 ELSE ${FAIL} END`)
      .bind(g.id, g.version),
  )
  const bumps = list.map((g) =>
    db.prepare(`UPDATE ${g.table} SET ${g.versionColumn} = ${g.versionColumn} + 1 WHERE ${g.idColumn} = ?1`).bind(g.id),
  )
  try {
    const results = await db.batch([...checks, ...statements, ...bumps])
    return { ok: true, results: results.slice(checks.length, checks.length + statements.length) }
  } catch (err) {
    // The same error can come from one of your own statements, so look before saying a row changed.
    if (/malformed JSON/i.test(String(err && err.message))) {
      const changed = await changedSince(db, list)
      if (changed.length) return { ok: false, changed }
    }
    throw err
  }
}
