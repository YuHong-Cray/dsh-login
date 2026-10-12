/**
 * dsh-login — account-store driver selection.
 *
 * Two interchangeable backends sit behind one surface (`ensureTable`, `health`,
 * `register`, `findByUsername`, `listUsers`, `setStatus`, `setModelSelfService`,
 * `touchLastLogin`, `remove`, `close`):
 *
 *   sqlite (default)  lib/db-sqlite.js — built into Node (node:sqlite), the file
 *                     and the table are created on first use. A deployment with
 *                     no database configuration still gets the full flow.
 *   mysql             lib/db.js — the shared/enterprise account table; requires
 *                     the optional `mysql2` dependency.
 *
 * `config.js` decides the driver at config-load time (`db.driver`, or `auto`
 * from the presence of `db.host`/`db.user`/`db.database`); this module only
 * resolves the module lazily, so a SQLite deployment never loads `mysql2` and
 * an instance-mode host never loads either.
 */

/** Human description of one normalized db config, for startup logs. */
export function describeDb(dbCfg) {
  if (dbCfg?.driver === 'sqlite') {
    return `sqlite:${dbCfg.file ?? '<unset>'} table=${dbCfg.table}`
  }
  return `mysql:${String(dbCfg?.host ?? '')}:${String(dbCfg?.port ?? '')}/${dbCfg?.database ?? ''} table=${dbCfg?.table ?? ''}`
}

/**
 * Instantiate the driver for one normalized db config.
 * @param dbCfg - `config.js` output (`driver`, plus driver-specific fields).
 * @returns the database object (all methods awaited by callers).
 * @throws Error with a `dbDown` tag when the MySQL driver's dependency is absent.
 */
export async function createLoginDatabase(dbCfg) {
  if (dbCfg?.driver === 'sqlite') {
    const m = await import('./db-sqlite.js')
    return new m.SqliteLoginDatabase(dbCfg)
  }
  try {
    const m = await import('./db.js')
    return new m.LoginDatabase(dbCfg)
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      const tagged = new Error(
        'database unavailable: the mysql driver needs the optional dependency '
        + '`mysql2` (npm install mysql2), or drop the db.host/db.user/db.database '
        + 'config to use the built-in SQLite account store',
      )
      tagged.dbDown = true
      tagged.cause = err
      throw tagged
    }
    throw err
  }
}
