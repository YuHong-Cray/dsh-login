/**
 * dsh-login — the zero-configuration account store: SQLite over `node:sqlite`.
 *
 * This is the driver a deployment gets when it does NOT configure MySQL: the
 * hub creates the file and the table itself on first use, so a whole deployment
 * (register → approval → login → per-user instance) works with no external
 * database and no `npm install`. The account table is identical in shape to the
 * MySQL one, so switching to MySQL later is a data move, not a code change.
 *
 *   CREATE TABLE IF NOT EXISTS "dsh_login" (
 *     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
 *     username           TEXT    NOT NULL UNIQUE,
 *     password_hash      TEXT    NOT NULL,        -- scrypt verifier, never plain text
 *     status             TEXT    NOT NULL DEFAULT 'approved',
 *     model_self_service INTEGER NOT NULL DEFAULT 0,
 *     created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 *     last_login_at      TEXT    NULL
 *   )
 *
 * Two deliberate parity choices with lib/db.js, because both columns were added
 * after the first release and an old table must upgrade the same way:
 *   - `status` defaults to 'approved' (rows predating the approval workflow
 *     stay usable);
 *   - `model_self_service` defaults to 0 (a pre-existing user stays DENIED until
 *     an administrator grants it — the safe direction on upgrade).
 *
 * Timestamps are stored as ISO-8601 UTC (`...Z`), not SQLite's bare
 * `CURRENT_TIMESTAMP`: a bare `YYYY-MM-DD HH:MM:SS` has no offset, and the
 * console's `new Date(value)` would then read a UTC instant as local time.
 *
 * Security posture: the file holds scrypt verifiers, so it is created 0600
 * inside the Harness home (0700). It is a second copy of the same secret class
 * as `.credentials.yaml`, and it is NOT a backup target — a leaked DB plus an
 * offline scrypt brute force is the same exposure as a leaked `.credentials.yaml`.
 *
 * `node:sqlite` is built into Node 22.5+ / 23+ (it prints an ExperimentalWarning
 * on Node 22; the API surface used here is stable in practice). No native module,
 * no download, no compile step.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ACCOUNT_STATUSES } from './account-status.js'

/** Default file name inside a hub's DSH_HOME. */
export const SQLITE_DEFAULT_FILE = 'dsh-login-accounts.sqlite'

/** Is this a unique-constraint violation (i.e. the username already exists)? */
function isUniqueViolation(err) {
  const code = String(err?.code ?? '')
  if (code.startsWith('ERR_SQLITE_CONSTRAINT_UNIQUE') || code === 'SQLITE_CONSTRAINT_UNIQUE') return true
  return /UNIQUE constraint failed/i.test(String(err?.message ?? ''))
}

/**
 * One synchronous SQLite handle behind the same async surface as LoginDatabase,
 * so every HTTP handler in index.js is driver-agnostic.
 *
 * Methods throw Error with a `db-down` tag when the store is unusable (missing
 * directory, unwritable file, locked table) so the HTTP layer answers 503 with
 * the same friendly message as the MySQL driver.
 */
export class SqliteLoginDatabase {
  /**
   * @param cfg - normalized db config: `{ driver: 'sqlite', file, table }`.
   *   `file` must be absolute (config.js resolves the default against DSH_HOME);
   *   `:memory:` is accepted for tests.
   */
  constructor(cfg) {
    this.cfg = { ...cfg }
    this.driver = 'sqlite'
    if (!/^[A-Za-z0-9_-]+$/.test(String(this.cfg.table ?? ''))) {
      throw new Error(`dsh-login: db.table must match ^[A-Za-z0-9_-]+$ (got ${JSON.stringify(cfg.table)})`)
    }
    const file = String(this.cfg.file ?? '')
    if (file === '') throw new Error('dsh-login: db.file is required for the sqlite driver')
    this.file = file === ':memory:' ? file : (isAbsolute(file) ? file : resolve(file))
    this.cfg.file = this.file
    this.db = undefined
    this.lastError = ''
  }

  /** The quoted table identifier for SQL statements. */
  table() {
    return `"${this.cfg.table}"`
  }

  /** Open (once) the handle and apply the pragmas every statement relies on. */
  handle() {
    if (this.db !== undefined) return this.db
    if (this.file !== ':memory:') {
      mkdirSync(dirname(this.file), { recursive: true })
    }
    const fresh = this.file === ':memory:' ? false : !existsSync(this.file)
    const db = new DatabaseSync(this.file)
    try {
      // WAL: a hub restart or a concurrent verify run never blocks logins on a
      // single writer lock. busy_timeout keeps the second writer waiting.
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA synchronous = FULL')
    } catch (err) {
      db.close()
      throw err
    }
    this.db = db
    if (this.file !== ':memory:') {
      // The file carries scrypt verifiers: private whatever its umask context.
      // A pre-existing file is tightened too — this is a secret store.
      try {
        chmodSync(this.file, 0o600)
      } catch (err) {
        this.lastError = `chmod 0600 ${this.file}: ${err?.message ?? String(err)}`
      }
      if (fresh) this.createdFile = true
    }
    return this.db
  }

  /**
   * Ensure the account table exists (and carries both later-added columns).
   * @returns the table name.
   * @throws {Error} tagged db-down when the store cannot be opened or written.
   */
  async ensureTable() {
    const t = this.table()
    try {
      this.handle().exec(
        `CREATE TABLE IF NOT EXISTS ${t} (
           id                 INTEGER PRIMARY KEY AUTOINCREMENT,
           username           TEXT    NOT NULL UNIQUE,
           password_hash      TEXT    NOT NULL,
           status             TEXT    NOT NULL DEFAULT 'approved',
           model_self_service INTEGER NOT NULL DEFAULT 0,
           created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
           last_login_at      TEXT
         )`,
      )
      this.ensureStatusColumn()
      this.ensureModelSelfServiceColumn()
      this.lastError = ''
      return this.cfg.table
    } catch (err) {
      this.lastError = err?.message ?? String(err)
      throw this.down(err)
    }
  }

  /** Column names currently present in the table. */
  columns() {
    return this.handle()
      .prepare(`PRAGMA table_info(${this.table()})`)
      .all()
      .map((row) => String(row.name))
  }

  /**
   * Add `status` to a table that predates the approval workflow.
   * Same DEFAULT as the MySQL migration ('approved'), so old rows keep working.
   * @returns true when the column was added by this call.
   */
  ensureStatusColumn() {
    if (this.columns().includes('status')) return false
    this.handle().exec(`ALTER TABLE ${this.table()} ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`)
    return true
  }

  /**
   * Add `model_self_service` to a table that predates the self-service switch.
   * Same DEFAULT as the MySQL migration (0 = denied): an upgrade never hands out
   * self-service rights an administrator has not granted.
   * @returns true when the column was added by this call.
   */
  ensureModelSelfServiceColumn() {
    if (this.columns().includes('model_self_service')) return false
    this.handle().exec(`ALTER TABLE ${this.table()} ADD COLUMN model_self_service INTEGER NOT NULL DEFAULT 0`)
    return true
  }

  /**
   * Liveness probe.
   * @returns 'up' or 'down' (never throws).
   */
  async health() {
    try {
      const row = this.handle().prepare('SELECT 1 AS ok').get()
      this.lastError = ''
      return row?.ok === 1 ? 'up' : 'down'
    } catch (err) {
      this.lastError = err?.message ?? String(err)
      return 'down'
    }
  }

  /**
   * Insert one account.
   * @param username - validated username.
   * @param passwordHash - scrypt verifier string.
   * @returns {ok:true} or {ok:false, code:'exists'} on the unique-key conflict.
   */
  async register(username, passwordHash, status = 'pending') {
    const safeStatus = ACCOUNT_STATUSES.includes(status) ? status : 'pending'
    try {
      this.handle()
        .prepare(`INSERT INTO ${this.table()} (username, password_hash, status) VALUES (?, ?, ?)`)
        .run(username, passwordHash, safeStatus)
      this.lastError = ''
      return { ok: true, status: safeStatus }
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, code: 'exists' }
      this.lastError = err?.message ?? String(err)
      throw this.down(err)
    }
  }

  /**
   * Fetch the stored verifier for one username.
   * @returns the row ({username, password_hash, status, model_self_service})
   *   or undefined when absent.
   */
  async findByUsername(username) {
    try {
      const row = this.handle()
        .prepare(`SELECT username, password_hash, status, model_self_service FROM ${this.table()} WHERE username = ? LIMIT 1`)
        .get(username)
      this.lastError = ''
      return row === undefined ? undefined : { ...row }
    } catch (err) {
      this.lastError = err?.message ?? String(err)
      throw this.down(err)
    }
  }

  /**
   * List all accounts (management page).
   * @returns [{username, created_at, last_login_at, status, model_self_service}]
   *   ordered by username.
   */
  async listUsers() {
    try {
      const rows = this.handle()
        .prepare(`SELECT username, created_at, last_login_at, status, model_self_service FROM ${this.table()} ORDER BY username`)
        .all()
      this.lastError = ''
      return rows.map((row) => ({ ...row }))
    } catch (err) {
      this.lastError = err?.message ?? String(err)
      throw this.down(err)
    }
  }

  /**
   * Set one account's approval status (administrator action).
   * @param username - the account name.
   * @param status - one of {@link ACCOUNT_STATUSES}.
   * @returns `{ok: true, changed}`; `changed` is 0 when the value was already set.
   * @throws Error when `status` is unknown or the store is unusable.
   */
  async setStatus(username, status) {
    if (!ACCOUNT_STATUSES.includes(status)) {
      throw new Error(`dsh-login: unknown account status ${JSON.stringify(status)}`)
    }
    try {
      // `changed` must mean "rows actually modified", like mysql2's affectedRows
      // (which counts changed rows, not matched ones). SQLite's changes() counts
      // every matched row, so the guard belongs in the WHERE clause.
      const result = this.handle()
        .prepare(`UPDATE ${this.table()} SET status = ? WHERE username = ? AND status <> ?`)
        .run(status, username, status)
      this.lastError = ''
      return { ok: true, changed: result?.changes ?? 0 }
    } catch (err) {
      this.lastError = err?.message ?? String(err)
      throw this.down(err)
    }
  }

  /**
   * Grant or revoke one account's right to configure its own model providers.
   * The hub mirrors this decision into the user's DSH_HOME (lib/model-policy.js).
   * @param username - the account name.
   * @param allow - true to allow self-service, false to require an administrator.
   * @returns `{ok: true, changed}`; `changed` is 0 when the value was already set.
   */
  async setModelSelfService(username, allow) {
    const flag = allow === true ? 1 : 0
    try {
      const result = this.handle()
        .prepare(`UPDATE ${this.table()} SET model_self_service = ? WHERE username = ? AND model_self_service <> ?`)
        .run(flag, username, flag)
      this.lastError = ''
      return { ok: true, changed: result?.changes ?? 0 }
    } catch (err) {
      this.lastError = err?.message ?? String(err)
      throw this.down(err)
    }
  }

  /** Record a successful login (best effort; failures never block login). */
  async touchLastLogin(username) {
    try {
      this.handle()
        .prepare(`UPDATE ${this.table()} SET last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE username = ?`)
        .run(username)
      this.lastError = ''
    } catch (err) {
      this.lastError = err?.message ?? String(err)
    }
  }

  /** Drop one account (maintenance path; also used by the test suite). */
  async remove(username) {
    try {
      const result = this.handle()
        .prepare(`DELETE FROM ${this.table()} WHERE username = ?`)
        .run(username)
      this.lastError = ''
      return result?.changes ?? 0
    } catch (err) {
      this.lastError = err?.message ?? String(err)
      throw this.down(err)
    }
  }

  /** Close the handle (idempotent). */
  close() {
    if (this.db !== undefined) {
      const db = this.db
      this.db = undefined
      try {
        db.close()
      } catch {
        /* already closed */
      }
    }
  }

  /** Wrap any store failure in the shared `db-down` tag the HTTP layer reads. */
  down(err) {
    const cause = err instanceof Error ? err : new Error(String(err))
    const tagged = new Error(`database unavailable: ${cause.message}`)
    tagged.dbDown = true
    tagged.cause = cause
    return tagged
  }
}
