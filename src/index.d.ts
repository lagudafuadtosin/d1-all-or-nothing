/** A row you read before deciding what to write. */
export type Guard = {
  /** Table name: letters, digits and _ only. */
  table: string
  /** The row's id. */
  id: string | number
  /** The version you read. null means the row must not exist yet. */
  version: number | null
  /** Default "id". */
  idColumn?: string
  /** Default "version". An INTEGER column that only allOrNothing changes. */
  versionColumn?: string
}

type Statement = { bind(...values: unknown[]): Statement }
type Database<S extends Statement, R> = { prepare(sql: string): S; batch(statements: S[]): Promise<R[]> }
/** A Drizzle database made with drizzle(env.DB). */
type DrizzleDatabase<S extends Statement, R> = { $client: Database<S, R> }
/** A Drizzle query, such as db.update(table).set(...).where(...). */
type DrizzleQuery = { toSQL(): { sql: string; params: unknown[] } }

export type Outcome<R> = { ok: true; results: R[] } | { ok: false; changed: { table: string; id: string | number }[] }

/**
 * Run statements only if every guarded row is still at the version you read.
 * Each guarded row's version goes up by one when they run.
 * On { ok: false } nothing was written: read again and retry.
 * Any other failure (a constraint, bad SQL) throws, and nothing was written either.
 */
export declare function allOrNothing<S extends Statement, R>(
  db: Database<S, R> | DrizzleDatabase<S, R>,
  guards: Guard | Guard[],
  statements: (S | DrizzleQuery)[],
): Promise<Outcome<R>>
